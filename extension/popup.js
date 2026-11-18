import { sendRequest, withTimeout } from "./rpc.js";

const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const management = params.get("view") === "manage";
if (management) document.body.classList.add("manage-view");
let origin = null, tabId = null, state = null, incognito = false, working = false, stateKnown = false, refreshId = 0;
const labels = { active: "已生效", external: "当前值符合", blocked: "被覆盖", inactive: "未生效", error: "失败", unsupported: "不可用", released: "已释放" };
const checkButton = document.createElement("button");
checkButton.type = "button"; checkButton.textContent = "重新检查状态"; checkButton.hidden = true;
$(".overview").append(checkButton);
checkButton.addEventListener("click", () => { refresh().catch(() => {}); });
$("#lifecycle-note").hidden = true;
$("#site-state").hidden = true;

const send = message => sendRequest(chrome, message);

function regionNeedsAttention(region) {
  return Boolean(region && (region.cleanupPending?.scripts || region.cleanupPending?.headers || region.errors?.length
    || ["cleanup", "error"].includes(region.status)));
}

function render(next) {
  state = next; stateKnown = true; checkButton.hidden = true;
  $("#enabled").checked = state.config.enabled;
  $("#master-label").textContent = state.config.enabled ? "总开关" : "已暂停";
  $("#release").textContent = state.config.enabled ? "暂停全部功能" : "已暂停";
  $("#release").disabled = working || !state.config.enabled;
  const wanted = state.settings.filter(row => row.wanted);
  const effective = wanted.filter(row => ["active", "external"].includes(row.status)).length;
  const unavailable = wanted.filter(row => row.status === "unsupported").length;
  const settingFailure = state.settings.some(row => row.status === "error" || (row.wanted && ["blocked", "inactive"].includes(row.status)));
  const regionFailure = regionNeedsAttention(state.region);
  const requestFailure = state.protection?.cleanupPending || ["error", "cleanup", "needs-permission"].includes(state.protection?.phase);
  const errors = [...(state.siteErrors || []).map(item => `${item.origin}: ${item.error}`), ...(state.region?.errors || []), ...(state.protection?.errors || [])];
  const failure = settingFailure || errors.length > 0 || regionFailure || requestFailure;
  document.body.classList.toggle("is-paused", !state.config.enabled);
  document.body.classList.toggle("has-issues", Boolean(failure));
  $(".overview").classList.toggle("warning", failure);
  $("#summary").textContent = (state.incognito ? "无痕窗口 · " : "") + (state.config.enabled
    ? failure ? "有一项需要处理，请看看提示" : "基础保护已开启"
    : failure ? "暂停未完全完成，请处理待清理项目" : "基础保护已暂停，已释放本扩展设置");
  $("#native-count").textContent = state.config.enabled ? `${effective}/${wanted.length} 项生效${unavailable ? ` · ${unavailable} 项不可用` : ""}` : "已释放 · 选择保留";
  const notes = [];
  if (state.region?.cleanupPending?.scripts || state.region?.cleanupPending?.headers) notes.push("地区规则待清理；请打开“地区与语言”重试。");
  if (state.protection?.cleanupPending) notes.push("追踪保护规则待清理，请到追踪保护重试。");
  if (state.region?.needsRefresh) notes.push(`${state.region.needsRefresh} 个页面待刷新，旧页面可能仍保留地区覆盖。`);
  if (state.region?.refreshUnknown) notes.push("部分旧页面无法列出，请手动刷新。");
  $("#lifecycle-note").textContent = notes.join(" ");
  $("#lifecycle-note").hidden = notes.length === 0;
  $("#error").hidden = errors.length === 0;
  if (errors.length) $("#error").textContent = errors.join("\n");
  $("#settings").replaceChildren();
  for (const row of state.settings) {
    const article = document.createElement("div"); article.className = "setting";
    const head = document.createElement("div"); head.className = "setting-head";
    const label = document.createElement("label");
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = state.config.selected[row.id];
    checkbox.addEventListener("change", () => update({ type: "select", id: row.id, value: checkbox.checked }));
    const title = document.createElement("span"); title.textContent = row.title;
    label.append(checkbox, title);
    const status = document.createElement("span");
    status.className = "status" + (["blocked", "inactive", "error"].includes(row.status) ? " warn" : ["unsupported", "released"].includes(row.status) ? " neutral" : "");
    status.textContent = labels[row.status] || row.status;
    status.title = row.error || (row.status === "external" ? "当前值符合目标，由用户、策略或其他扩展提供；本扩展未控制此值。" : row.level || "浏览器未提供此设置接口");
    head.append(label, status);
    const description = document.createElement("p"); description.className = "description"; description.textContent = row.description;
    if (row.error) description.append(document.createTextNode(" 应用错误：" + row.error));
    article.append(head, description); $("#settings").append(article);
  }
  $("#origin").textContent = origin || "此标签页不支持站点设置";
  $("#block-js").checked = Boolean(origin && state.config.blockedOrigins.includes(origin));
  $("#block-js").disabled = !origin || !state.config.enabled;
  $("#reload").disabled = !origin;
  const saved = origin && state.config.blockedOrigins.includes(origin);
  $("#site-state").textContent = !origin ? "请从普通网页打开扩展，或返回原网页。"
    : `JavaScript 当前${state.site?.setting === "block" ? "禁止" : state.site?.setting === "allow" ? "允许" : "状态未知"}`
      + (saved && !state.config.enabled ? "；禁止规则已保存，暂停期间不应用。" : "。")
      + (state.site?.error || "");
  $("#site-state").hidden = false;
  $("#site-js-badge").hidden = state.site?.setting !== "block";
}

function showError(text) { $("#error").hidden = false; $("#error").textContent = text; }
function unknown(error) {
  stateKnown = false;
  $(".overview").classList.add("warning");
  $("#summary").textContent = state ? "当前状态无法确认；下方为上次读取结果" : "无法确认设置是否生效";
  $("#master-label").textContent = "状态未知";
  $("#lifecycle-note").hidden = true;
  $("#site-state").hidden = true;
  showError(error.message); checkButton.hidden = false;
}
function busy(value) {
  working = value;
  for (const el of document.querySelectorAll("header input, .native-card input, .native-card button, #block-js, #reload")) el.disabled = value || !stateKnown;
  checkButton.disabled = value;
  if (!value) {
    $("#block-js").disabled = !stateKnown || !origin || !state?.config.enabled;
    $("#reload").disabled = !origin;
    $("#release").disabled = !stateKnown || !state?.config.enabled;
  }
}
async function currentTab() {
  const saved = params.get("tab");
  if (management && saved && /^\d+$/.test(saved)) {
    try { return await withTimeout(chrome.tabs.get(Number(saved)), 3000); } catch (error) { if (error.code === "RPC_TIMEOUT") throw error; return null; }
  }
  return (await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 3000))[0];
}
async function refresh() {
  const requestId = ++refreshId; busy(true);
  try {
    const tab = await currentTab();
    const nextTabId = tab?.id ?? null, nextIncognito = tab?.incognito === true;
    let nextOrigin = null;
    if (tab?.url) { const url = new URL(tab.url); if (["http:", "https:"].includes(url.protocol)) nextOrigin = url.origin; }
    const next = await send({ type: "status", origin: nextOrigin, incognito: nextIncognito, tabId: nextTabId });
    if (requestId !== refreshId) return;
    tabId = nextTabId; incognito = nextIncognito; origin = nextOrigin;
    render(next);
    window.dispatchEvent(new CustomEvent("privacy-context", { detail: { tabId, origin, incognito, management } }));
  } catch (error) { if (requestId === refreshId) unknown(error); throw error; }
  finally { if (requestId === refreshId) busy(false); }
}
async function update(message) {
  if (working || !stateKnown) return;
  busy(true); $("#error").hidden = true;
  try { await send(message); await refresh(); }
  catch (error) { try { await refresh(); } catch {} showError(error.message); }
  finally { busy(false); }
  window.dispatchEvent(new Event("privacy-settings-changed"));
}

$("#enabled").addEventListener("change", () => update({ type: "enabled", value: $("#enabled").checked }));
$("#block-js").addEventListener("change", () => update({ type: "site", origin, block: $("#block-js").checked }));
$("#retry").addEventListener("click", () => update({ type: "retry" }));
$("#defaults").addEventListener("click", () => update({ type: "defaults" }));
$("#release").addEventListener("click", () => update({ type: "enabled", value: false }));
$("#reload").addEventListener("click", async () => {
  try { if (tabId !== null) await chrome.tabs.reload(tabId); } catch (error) { showError(error.message); }
});
document.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => {
  chrome.tabs.create({ url: button.dataset.page }).catch(error => showError(error.message));
}));
window.addEventListener("region-settings-changed", () => { if (!working) refresh().catch(() => {}); });
window.addEventListener("protection-settings-changed", () => { if (!working) refresh().catch(() => {}); });
window.addEventListener("focus", () => { if (!working) refresh().catch(() => {}); });
refresh().catch(() => {});
