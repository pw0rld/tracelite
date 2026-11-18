import { withTimeout } from "./rpc.js";

const STORAGE_KEY = "siteCleanupJob";
const TOKEN_LIFETIME = 60_000;
const TOKEN_LIMIT = 16;
const READ_LIMIT = 2_000;
const KINDS = new Set(["cache", "data"]);
const WARNINGS = {
  cache: "仅清除此来源的 HTTP 缓存，包括可能用于识别的 ETag 缓存。下次加载需要重新下载资源；Cookie 和站点数据由另一个按钮清理。已打开的页面可能再次写入缓存。",
  data: "将清除本站 Cookie、本地存储、IndexedDB、缓存存储、Service Worker 和文件系统数据，可能退出登录并删除离线内容，包含此来源已安装网页应用的数据。Cookie 的清理还会连带同一可注册主域及其子域。此操作不可撤销；HTTP 缓存由另一个按钮清理。"
};

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function originForTab(tab) {
  if (tab?.incognito === true) throw failure("INCOGNITO_UNSUPPORTED", "暂不支持在无痕窗口清理，避免误删普通窗口的数据。");
  let url;
  try { url = new URL(tab?.url); } catch { throw failure("INVALID_TAB", "无法读取当前网页，请返回普通网站后重试。"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw failure("INVALID_ORIGIN", "仅支持清理 HTTP 或 HTTPS 网站。");
  }
  if (tab.pendingUrl) {
    let pending;
    try { pending = new URL(tab.pendingUrl); } catch { throw failure("TAB_CHANGED", "当前标签页正在切换网站，请等待加载完成后重试。"); }
    if (pending.origin !== url.origin || pending.username || pending.password) {
      throw failure("TAB_CHANGED", "当前标签页正在切换网站，请等待加载完成后重试。");
    }
  }
  return url.origin;
}

function publicJob(job) {
  if (!job) return null;
  return { id: job.id, state: job.state, kind: job.kind, origin: job.origin,
    at: job.at, updatedAt: job.updatedAt, error: job.error || null };
}

function safeError(error) {
  const text = typeof error?.message === "string" ? error.message : "浏览器没有返回有效结果";
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, "[网址已省略]").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240);
}

// Destructive operations are reachable only through a short-lived prepare token.
// The caller owns extension-document authentication and the visible confirmation.
export function createSiteCleanup(api) {
  const owner = crypto.randomUUID(), tokens = new Map();
  let queue = Promise.resolve(), fallback = null;
  const exclusive = task => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  const timestamp = () => new Date().toISOString();
  const write = job => api.storage.session.set({ [STORAGE_KEY]: job });

  async function stored() {
    if (fallback) return fallback;
    const result = (await api.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
    if (!result || result.schema !== 1 || typeof result.id !== "string" || !KINDS.has(result.kind)
      || !["running", "done", "error", "unknown"].includes(result.state)) return null;
    let origin;
    try { origin = originForTab({ url: result.origin }); } catch { return null; }
    // Do not retain an accidental URL path, query, or credential from old data.
    const job = { schema: 1, id: result.id, owner: result.owner, state: result.state, kind: result.kind, origin,
      at: result.at, updatedAt: result.updatedAt, error: typeof result.error === "string" ? result.error : null };
    if (job.state === "running" && job.owner !== owner) {
      job.state = "unknown"; job.owner = owner; job.updatedAt = timestamp();
      job.error = "扩展后台已重启，无法确认上次清理结果；不会自动重新执行。";
      await write(job);
    }
    return job;
  }

  async function readTab(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) throw failure("INVALID_TAB", "无法读取当前标签页。");
    try { return await withTimeout(api.tabs.get(tabId), READ_LIMIT, "读取当前标签页超时，请稍后重试。"); }
    catch (error) {
      if (error.code === "RPC_TIMEOUT") throw error;
      throw failure("INVALID_TAB", "当前标签页已关闭或无法访问。");
    }
  }

  async function prepare(tabId, kind) {
    if (!KINDS.has(kind)) throw failure("INVALID_KIND", "清理类型无效。");
    const tab = await readTab(tabId), origin = originForTab(tab);
    const now = Date.now();
    for (const [token, entry] of tokens) if (entry.expiresAt <= now) tokens.delete(token);
    if (tokens.size >= TOKEN_LIMIT) throw failure("TOO_MANY_PREPARES", "待确认的清理操作过多，请稍后重试。");
    const result = { token: crypto.randomUUID(), tabId, kind, origin, incognito: false,
      warning: WARNINGS[kind], expiresAt: now + TOKEN_LIFETIME };
    tokens.set(result.token, result);
    return { ...result };
  }

  async function finish(job, error) {
    const current = await stored();
    if (!current || current.id !== job.id || current.owner !== owner || current.state !== "running") return;
    const next = { ...current, state: error ? "error" : "done", updatedAt: timestamp(),
      error: error ? "清理未确认完成，部分数据可能已删除：" + safeError(error) : null };
    try { await write(next); }
    catch {
      fallback = { ...next, state: "unknown", error: "清理调用已返回，但结果暂时无法保存；请检查状态，勿自动重复清理。" };
    }
  }

  async function start(token) {
    // Consume before awaiting anything: a double click or replay cannot issue a
    // second removal, even if the first start has not completed its checks.
    const prepared = typeof token === "string" ? tokens.get(token) : null;
    if (!prepared) throw failure("INVALID_TOKEN", "清理确认已失效，请重新选择并确认。");
    tokens.delete(token);
    if (Date.now() >= prepared.expiresAt) throw failure("EXPIRED_TOKEN", "清理确认已过期，请重新确认。");
    return exclusive(async () => {
      const previous = await stored();
      if (previous?.state === "running") throw failure("CLEANUP_BUSY", "已有清理任务正在进行，请等待完成。");
      const allowed = await withTimeout(api.permissions.contains({ permissions: ["browsingData"] }), READ_LIMIT,
        "读取清理权限超时，请重新检查权限。");
      if (!allowed || typeof api.browsingData?.remove !== "function") throw failure("PERMISSION_REQUIRED", "请先授予清理浏览数据的权限。");
      const tab = await readTab(prepared.tabId);
      if (originForTab(tab) !== prepared.origin) throw failure("TAB_CHANGED", "当前网站已变化；没有开始清理，请重新确认目标网站。");
      if (Date.now() >= prepared.expiresAt) throw failure("EXPIRED_TOKEN", "清理确认已过期，请重新确认。");
      const at = timestamp();
      const job = { schema: 1, owner, id: crypto.randomUUID(), state: "running", kind: prepared.kind,
        origin: prepared.origin, at, updatedAt: at, error: null };
      // If recording the operation fails, no removal is launched.
      await write(job);
      fallback = null;
      try {
        // Recording the running job is asynchronous too. Navigation or a long
        // storage delay during that step must not leave a late deletion armed.
        const finalTab = await readTab(prepared.tabId);
        if (originForTab(finalTab) !== prepared.origin) throw failure("TAB_CHANGED", "当前网站已变化；没有开始清理，请重新确认目标网站。");
        if (Date.now() >= prepared.expiresAt) throw failure("EXPIRED_TOKEN", "清理确认已过期，没有开始清理，请重新确认。");
      } catch (error) {
        const cancelled = { ...job, state: "error", updatedAt: timestamp(), error: "没有开始清理：" + safeError(error) };
        try { await write(cancelled); } catch { fallback = cancelled; }
        throw error;
      }
      const options = { origins: [prepared.origin], since: 0,
        originTypes: { unprotectedWeb: true, protectedWeb: true, extension: false } };
      const types = prepared.kind === "cache" ? { cache: true }
        : { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true };
      let operation;
      try { operation = api.browsingData.remove(options, types); }
      catch (error) { operation = Promise.reject(error); }
      // The long browser operation never holds this controller's state queue or
      // the caller's settings queue. Chrome's pending API request owns its life.
      Promise.resolve(operation).then(
        () => exclusive(() => finish(job, null)),
        error => exclusive(() => finish(job, error))
      ).catch(() => {
        fallback = { ...job, state: "unknown", updatedAt: timestamp(),
          error: "清理结果无法确认，请重新检查；不会自动重复执行。" };
      });
      return publicJob(job);
    });
  }

  async function getStatus(id = null) {
    return exclusive(async () => {
      const job = await stored();
      return id && job?.id !== id ? null : publicJob(job);
    });
  }

  return { prepare, start, getStatus };
}
