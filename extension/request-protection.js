import { requestProtectionRules, ownsRequestRule, TRACKING_DOMAINS, TRACKING_PARAMS, TRACKING_LIST_VERSION } from "./tracking-rules.js";

const CONFIG_KEY = "requestProtection";
const RUNTIME_KEY = "requestProtectionRuntime";
const ORIGINS = ["http://*/*", "https://*/*"];
const API_PERMISSION = "declarativeNetRequestWithHostAccess";
const requested = config => config.trackers || config.links;

function hostname(value, originOnly = false) {
  try {
    if (typeof value !== "string" || !value || value.length > 2048) return null;
    const url = new URL(originOnly || value.includes("://") ? value : "https://" + value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    // Domain conditions are deliberately limited to DNS names and IPv4 here.
    // Do not silently broaden an IPv6 literal into another exception scope.
    return host.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host) ? host : null;
  } catch { return null; }
}

export function normalizeRequestProtection(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return { version: 1, trackers: source.trackers === true, links: source.links === true,
    excludedDomains: [...new Set((Array.isArray(source.excludedDomains) ? source.excludedDomains : [])
      .map(value => hostname(value)).filter(Boolean))].sort().slice(0, 100) };
}

function canonicalRules(rules) {
  const setKeys = new Set(["requestDomains", "excludedInitiatorDomains", "excludedRequestDomains", "resourceTypes", "requestMethods", "removeParams"]);
  return JSON.stringify(rules.map(rule => {
    const condition = { ...rule.condition };
    if (condition.isUrlFilterCaseSensitive === false) delete condition.isUrlFilterCaseSensitive;
    return { ...rule, condition, priority: rule.priority ?? 1 };
  }).sort((a, b) => a.id - b.id), function (key, value) {
    if (Array.isArray(value)) return setKeys.has(key) ? [...value].sort() : value;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    return value;
  });
}

export function createRequestProtection(api) {
  const getConfig = async () => normalizeRequestProtection((await api.storage.local.get(CONFIG_KEY))[CONFIG_KEY]);
  const getRuntime = async () => {
    const raw = (await api.storage.local.get(RUNTIME_KEY))[RUNTIME_KEY];
    return { version: 1, cleanupPending: raw?.cleanupPending === true,
      errors: Array.isArray(raw?.errors) ? raw.errors.filter(value => typeof value === "string") : [],
      reason: typeof raw?.reason === "string" ? raw.reason : null };
  };
  const saveRuntime = runtime => api.storage.local.set({ [RUNTIME_KEY]: runtime });
  const enabled = async supplied => typeof supplied === "boolean" ? supplied : (await api.storage.local.get("config")).config?.enabled !== false;
  async function access() {
    const checks = await Promise.allSettled([
      api.permissions.contains({ permissions: [API_PERMISSION] }),
      api.permissions.contains({ origins: ORIGINS })
    ]);
    return { api: checks[0].status === "fulfilled" ? checks[0].value === true && !!api.declarativeNetRequest : null,
      hosts: checks[1].status === "fulfilled" ? checks[1].value === true : null,
      errors: checks.some(result => result.status === "rejected") ? ["请求保护权限状态无法确认，请重新检查。"] : [] };
  }
  const readRules = async () => (await api.declarativeNetRequest.getDynamicRules()).filter(rule => ownsRequestRule(rule.id));

  async function clear(runtime) {
    runtime.cleanupPending = true;
    await saveRuntime(runtime);
    try {
      const rules = await readRules();
      if (rules.length) await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(rule => rule.id) });
      if ((await readRules()).length) throw new Error("清理后仍检测到请求规则");
      runtime.cleanupPending = false;
      runtime.errors = [];
    } catch (error) {
      runtime.errors = ["请求保护规则待清理：" + error.message];
    }
    await saveRuntime(runtime);
    return runtime;
  }

  async function status(origin = null) {
    const [config, runtime, globalEnabled, available] = await Promise.all([getConfig(), getRuntime(), enabled(), access()]);
    let actual = null, readError = null;
    if (available.api) {
      try { actual = await readRules(); } catch (error) { readError = "请求规则读取失败：" + error.message; }
    } else if (requested(config) || runtime.cleanupPending) readError = "请求规则接口不可用，请重新加载扩展。";
    const shouldRun = requested(config) && globalEnabled && available.api === true && available.hosts === true;
    const expected = shouldRun ? requestProtectionRules(config) : [];
    const matches = actual !== null && canonicalRules(actual) === canonicalRules(expected);
    const unexpected = actual?.length > 0 && !shouldRun;
    const cleanupPending = runtime.cleanupPending || unexpected;
    const errors = [...runtime.errors, ...available.errors, ...(readError ? [readError] : [])];
    if (shouldRun && !matches && !errors.length) errors.push("请求保护规则未完整就绪，请重试。");
    const phase = cleanupPending ? "cleanup" : errors.length ? "error" : !requested(config) ? "off"
      : !globalEnabled ? "paused" : !available.hosts ? "needs-permission" : matches ? "active" : "error";
    const active = phase === "active", domain = hostname(origin, true);
    const matchedExcludedDomain = domain && config.excludedDomains.find(excluded => domain === excluded || domain.endsWith("." + excluded)) || null;
    const siteExcluded = !!matchedExcludedDomain;
    return { config, active, phase, errors: [...new Set(errors)], cleanupPending,
      trackersActive: active && config.trackers, linksActive: active && config.links,
      domainCount: TRACKING_DOMAINS.length, paramCount: TRACKING_PARAMS.length,
      version: TRACKING_LIST_VERSION, exclusionScope: "domain-and-subdomains", siteExcluded, matchedExcludedDomain,
      coverage: "基础名单仅拦第三方子请求；链接清理仅限含明确追踪键的 GET 导航，未知或登录、签名参数会跳过。",
      notices: runtime.reason === "permission-revoked" ? ["网站访问已撤销，请求保护已关闭；重新授权后仍需手动开启。"] : [] };
  }

  async function reconcile(globalEnabled) {
    const config = await getConfig(), runtime = await getRuntime(), available = await access();
    // An onRemoved event may be missed while the worker is not running. Never
    // keep an enabled intent that can revive when withheld hosts are restored.
    if (requested(config) && available.hosts === false) {
      config.trackers = false; config.links = false; runtime.reason = "permission-revoked";
      await api.storage.local.set({ [CONFIG_KEY]: config }); await saveRuntime(runtime);
    }
    const shouldRun = requested(config) && await enabled(globalEnabled) && available.api === true && available.hosts === true;
    if (!shouldRun) {
      if (available.api) await clear(runtime);
      else if (requested(config) || runtime.cleanupPending) {
        runtime.cleanupPending = true; runtime.errors = ["请求规则接口不可用，无法确认已清理，请重新加载扩展。"];
        await saveRuntime(runtime);
      }
      return status();
    }
    const expected = requestProtectionRules(config);
    try {
      const actual = await readRules();
      if (canonicalRules(actual) !== canonicalRules(expected)) {
        runtime.cleanupPending = true; runtime.errors = []; await saveRuntime(runtime);
        await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: actual.map(rule => rule.id), addRules: expected });
      }
      if (canonicalRules(await readRules()) !== canonicalRules(expected)) throw new Error("安装后读回与预期规则不一致");
      runtime.cleanupPending = false; runtime.errors = []; runtime.reason = null; await saveRuntime(runtime);
    } catch (error) {
      const message = "请求保护未完整应用，已尝试停止：" + error.message;
      await clear(runtime); runtime.errors.unshift(message); await saveRuntime(runtime);
    }
    return status();
  }

  async function configure(message, globalEnabled) {
    const config = await getConfig();
    if (["trackers", "links"].includes(message?.feature) && typeof message.value === "boolean") {
      if (message.value) {
        const available = await access();
        if (!available.api || !available.hosts) throw new Error("请先授予 HTTP(S) 网站访问权限，再开启请求保护。");
      }
      config[message.feature] = message.value;
    } else if (typeof message?.excluded === "boolean") {
      const domain = hostname(message.origin, true);
      if (!domain) throw new Error("此网址不支持域名例外，请从普通 HTTP(S) 网页操作。");
      if (!message.excluded && !config.excludedDomains.includes(domain)) {
        const inherited = config.excludedDomains.find(value => domain.endsWith("." + value));
        if (inherited) throw new Error(`此站点由 ${inherited} 的域名例外覆盖，请在例外列表中移除该父域名。`);
      }
      config.excludedDomains = config.excludedDomains.filter(value => value !== domain);
      if (message.excluded) {
        if (config.excludedDomains.length >= 100) throw new Error("最多保存 100 个域名例外");
        config.excludedDomains.push(domain); config.excludedDomains.sort();
      }
    } else throw new Error("无效的请求保护设置");
    await api.storage.local.set({ [CONFIG_KEY]: config });
    const runtime = await getRuntime(); runtime.reason = null; await saveRuntime(runtime);
    return reconcile(globalEnabled);
  }

  async function permissionsChanged(details = {}, globalEnabled) {
    const config = await getConfig(), available = await access();
    // Removing unrelated optional browsingData/tabs permission must not turn
    // request protection off. Regrant never restores a revoked enable intent.
    const relevant = (details.origins || []).some(origin => origin === "<all_urls>" || /^(?:https?|\*):/.test(origin))
      || (details.permissions || []).includes(API_PERMISSION);
    if (details.removed === true && relevant && (available.hosts === false || available.api === false)) {
      config.trackers = false; config.links = false;
      await api.storage.local.set({ [CONFIG_KEY]: config });
      const runtime = await getRuntime(); runtime.reason = "permission-revoked"; await saveRuntime(runtime);
    }
    return reconcile(globalEnabled);
  }
  return { status, configure, reconcile, permissionsChanged };
}
