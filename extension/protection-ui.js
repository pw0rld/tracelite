import { sendRequest, withTimeout } from "./rpc.js";

const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const management = params.get("view") === "manage";
const HOST_ACCESS = { origins: ["http://*/*", "https://*/*"] };
let data = null, current = null, known = false, protectionBusy = false, cleanupBusy = false;
let refreshSequence = 0, job = null, pollTimer = null, polling = false;

$("#extension-version").textContent = "v" + chrome.runtime.getManifest().version;
const send = (message, timeoutMs = 5000) => sendRequest(chrome, message, { timeoutMs });
const webOrigin = value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null; } catch { return null; } };
const errorsFor = value => (value?.errors || []).map(item => typeof item === "string" ? item : item?.error || item?.message || "请求规则检查失败");
const domainExcluded = (host, domains) => Boolean(host && domains.some(domain => host === domain || host.endsWith("." + domain)));

async function currentTab() {
  const saved = params.get("tab");
  if (management && saved && /^\d+$/.test(saved)) return withTimeout(chrome.tabs.get(Number(saved)), 3000);
  return (await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 3000))[0] || null;
}
function protectionControls() {
  const enabled = known && data?.globalEnabled !== false && !data?.cleanupPending && data?.phase !== "cleanup";
  for (const input of [$("#protect-trackers"), $("#protect-links"), $("#protection-exclude")]) input.disabled = protectionBusy || !enabled;
  $("#protection-exclude").disabled ||= !current?.origin;
  for (const button of $("#protection-exceptions").querySelectorAll("button")) button.disabled = protectionBusy || !enabled;
  $("#protection-retry").disabled = protectionBusy;
}
function cleanupControls() {
  const unavailable = cleanupBusy || job?.state === "running" || !current?.origin || current.incognito;
  $("#clear-site-cache").disabled = unavailable;
  $("#clear-site-data").disabled = unavailable;
  $("#cleanup-recheck").disabled = cleanupBusy || polling;
}
function showProtectionError(error) {
  const element = $("#protection-error"); element.hidden = false;
  element.textContent = error instanceof Error ? error.message : String(error);
}
function renderProtection(next) {
  data = next; known = true;
  const config = next.config || { trackers: false, links: false, excludedDomains: [] };
  $("#protect-trackers").checked = config.trackers === true;
  $("#protect-links").checked = config.links === true;
  const chip = $("#protection-status"), phase = next.phase || "off";
  const warning = next.cleanupPending === true || ["error", "cleanup"].includes(phase) || errorsFor(next).length > 0;
  chip.textContent = next.cleanupPending ? "待清理" : phase === "paused" ? "已暂停" : phase === "needs-permission" ? "待授权" : warning ? "需处理" : next.active ? "规则已启用" : "已关闭";
  chip.className = "status" + (warning || phase === "needs-permission" ? " warn" : !next.active ? " neutral" : "");
  $("#protection-trackers-detail").textContent = `内置基础名单 · ${Number(next.domainCount) || 0} 个域名；仅拦截第三方请求。`;
  const active = [];
  if (next.trackersActive) active.push("第三方追踪请求拦截");
  if (next.linksActive) active.push("链接参数清理");
  const stateText = $("#protection-state");
  stateText.textContent = next.cleanupPending ? "旧请求规则尚未完全清理，请重新检查。"
    : warning ? "请求保护未完整就绪，请查看提示。"
    : phase === "paused" || next.globalEnabled === false ? "总开关已暂停，已保存选择；恢复后重新应用。"
    : phase === "needs-permission" ? "网站访问尚未就绪。请手动开启所需项目并授权。"
    : active.length ? `${active.join("、")}用于后续请求。已载入的页面不会自动刷新。`
    : "按需开启以上项目，首次会申请 HTTP(S) 网站访问。";
  const domains = Array.isArray(config.excludedDomains) ? config.excludedDomains : [];
  const host = next.currentHostname || current?.hostname;
  const excluded = domainExcluded(host, domains);
  $("#protection-site-exception").hidden = !current?.origin;
  $("#protection-exclude").checked = excluded;
  $("#protection-exception-host").textContent = host ? `${next.matchedExcludedDomain || host} 及其子域` : "";
  if (excluded && next.globalEnabled !== false) stateText.textContent += " 此域名及子域已加入例外。";
  if (next.notices?.length) stateText.textContent += " " + next.notices.join(" ");
  $("#protection-retry").hidden = !warning && phase !== "needs-permission";
  const errors = errorsFor(next);
  $("#protection-error").hidden = !errors.length;
  $("#protection-error").textContent = errors.join("\n");
  $("#protection-coverage").textContent = next.coverage || `内置基础名单不涵盖所有第一方追踪。链接清理只处理 GET 网页导航及 ${Number(next.paramCount) || 0} 个明确参数；未知或签名相关查询会跳过。`;
  const list = $("#protection-exceptions"); list.replaceChildren();
  if (!domains.length) {
    const item = document.createElement("li"); item.textContent = "尚无域名例外。"; item.className = "hint"; list.append(item);
  } else for (const domain of domains) {
    const item = document.createElement("li"), label = document.createElement("span"), remove = document.createElement("button");
    label.className = "exception-domain"; label.textContent = `${domain} 及其子域`;
    remove.type = "button"; remove.textContent = "移除例外"; remove.setAttribute("aria-label", `移除 ${domain} 的例外`);
    remove.addEventListener("click", () => configure({ origin: `https://${domain}`, excluded: false }));
    item.append(label, remove); list.append(item);
  }
  protectionControls();
  window.dispatchEvent(new CustomEvent("protection-rendered", { detail: next }));
}
async function refreshProtection() {
  const sequence = ++refreshSequence;
  try {
    const tab = await currentTab(), origin = webOrigin(tab?.url);
    const next = await send({ type: "protectionStatus", tabId: tab?.id ?? null });
    if (sequence !== refreshSequence) return;
    current = { tabId: tab?.id ?? null, origin, hostname: origin ? new URL(origin).hostname : null, incognito: tab?.incognito === true };
    renderProtection(next);
    $("#cleanup-scope").textContent = current.incognito ? "无痕窗口不提供清理，避免误删普通窗口的数据。"
      : current.origin ? `仅手动清理：${current.origin}` : "请从普通 HTTP(S) 网页打开扩展后清理。";
    cleanupControls();
  } catch (error) {
    if (sequence !== refreshSequence) return;
    known = false;
    $("#protection-status").textContent = "未知"; $("#protection-status").className = "status warn";
    $("#protection-state").textContent = "当前请求保护状态无法确认，请重新检查。";
    $("#protection-retry").hidden = false; showProtectionError(error); protectionControls();
  }
}
async function configure(change, grant = null) {
  if (protectionBusy || !known) return;
  protectionBusy = true; protectionControls(); $("#protection-error").hidden = true;
  try {
    if (grant && !await grant) throw new Error("未授予网站访问，请求保护没有开启。");
    const next = await send({ type: "protectionConfigure", ...change, tabId: current?.tabId ?? null });
    renderProtection(next);
  } catch (error) { await refreshProtection(); showProtectionError(error); }
  finally { protectionBusy = false; protectionControls(); window.dispatchEvent(new Event("protection-settings-changed")); }
}
for (const [selector, feature] of [["#protect-trackers", "trackers"], ["#protect-links", "links"]]) {
  $(selector).addEventListener("change", () => {
    const value = $(selector).checked;
    if (protectionBusy || !known || data?.globalEnabled === false) { renderProtection(data); return; }
    // Request first to preserve the click gesture. Authorization alone never installs rules.
    const grant = value ? chrome.permissions.request(HOST_ACCESS) : null;
    configure({ feature, value }, grant);
  });
}
$("#protection-exclude").addEventListener("change", () => {
  if (!current?.origin) return;
  const excluded = $("#protection-exclude").checked;
  const origin = !excluded && data?.matchedExcludedDomain ? `https://${data.matchedExcludedDomain}` : current.origin;
  configure({ origin, excluded });
});
$("#protection-retry").addEventListener("click", async () => {
  if (protectionBusy) return;
  protectionBusy = true; protectionControls();
  try { renderProtection(await send({ type: "protectionRetry", tabId: current?.tabId ?? null })); }
  catch (error) { showProtectionError(error); }
  finally { protectionBusy = false; protectionControls(); window.dispatchEvent(new Event("protection-settings-changed")); }
});

function cancelPoll() { if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null; }
function showCleanupError(error) {
  $("#cleanup-result").hidden = false; $("#cleanup-result").classList.add("is-warning");
  $("#cleanup-result").textContent = error instanceof Error ? error.message : String(error);
  $("#cleanup-recheck").hidden = false;
}
function renderJob(next) {
  job = next || null; cancelPoll();
  const element = $("#cleanup-result");
  if (!job) { element.hidden = true; $("#cleanup-recheck").hidden = true; cleanupControls(); return; }
  const kind = job.kind === "cache" ? "缓存" : "站点数据";
  element.hidden = false; element.classList.toggle("is-warning", ["error", "unknown"].includes(job.state));
  const prefix = `目标：${job.origin || "未知站点"}\n`;
  element.textContent = prefix + (job.state === "running" ? `正在清理${kind}，可能需要一些时间。可以关闭弹窗，稍后重新读取结果。`
    : job.state === "done" ? `${kind}清理已完成。已打开的网页可能重新写入记录；需要时请手动刷新。`
    : job.state === "error" ? `${kind}清理失败：${job.error || "浏览器未完成清理"}。没有自动重试。`
    : `${kind}清理结果未确认。没有自动重新执行，请先重新读取结果。`);
  $("#cleanup-recheck").hidden = job.state === "done";
  cleanupControls();
  if (job.state === "running") pollTimer = setTimeout(() => { readCleanup().catch(() => {}); }, 1000);
}
async function readCleanup() {
  if (polling) return;
  polling = true; cleanupControls();
  try { renderJob(await send({ type: "cleanupStatus" })); }
  catch (error) { cancelPoll(); showCleanupError(error); }
  finally { polling = false; cleanupControls(); }
}
async function clearSite(kind) {
  if (cleanupBusy || job?.state === "running" || !current?.origin || current.incognito) return;
  // Optional permission must be requested directly from the click. It grants
  // capability only; the separate, exact-origin confirmation follows below.
  const granting = chrome.permissions.request({ permissions: ["browsingData"] });
  const selected = { ...current };
  cleanupBusy = true; cleanupControls();
  try {
    if (!await granting) throw new Error("未授予清理权限，没有执行清理。");
    const prepared = await send({ type: "cleanupPrepare", tabId: selected.tabId, kind });
    if (prepared.origin !== selected.origin || prepared.kind !== kind || prepared.incognito === true) throw new Error("当前网页已变化，请重新读取页面后再清理。");
    const title = kind === "cache" ? "清除此站点的 HTTP 缓存？" : "清除此站点的数据？";
    if (!window.confirm(`${title}\n\n${prepared.origin}\n\n${prepared.warning || (kind === "cache" ? "清除缓存中的旧记录；网页之后仍可重新写入。" : "可能退出登录、删除离线内容；同主域子站的 Cookie 也可能被清除。")}`)) return;
    // No transport retry: a timeout does not mean Chrome cancelled deletion.
    renderJob(await send({ type: "cleanupStart", token: prepared.token }, 6000));
  } catch (error) { showCleanupError(error); }
  finally { cleanupBusy = false; cleanupControls(); }
}
$("#clear-site-cache").addEventListener("click", () => clearSite("cache"));
$("#clear-site-data").addEventListener("click", () => clearSite("data"));
$("#cleanup-recheck").addEventListener("click", () => readCleanup());
for (const name of ["privacy-settings-changed", "region-settings-changed", "focus"]) window.addEventListener(name, () => {
  if (!protectionBusy) refreshProtection();
  if (!cleanupBusy && !polling) readCleanup();
});
window.addEventListener("pagehide", cancelPoll);
window.addEventListener("tracelite-ui-ready", () => {
  if (data) window.dispatchEvent(new CustomEvent("protection-rendered", { detail: data }));
});
refreshProtection();
readCleanup();
