// Optional localization controls. Network header checks require an explicit click.
import { sendRequest, withTimeout } from "./rpc.js";
import { earlyProfileFor } from "./region-early.js";
import { IP_LOOKUP_ORIGIN } from "./region-ip.js";

const panel = document.querySelector("#region-panel");
const params = new URLSearchParams(location.search);
const management = params.get("view") === "manage";
const REGION_PERMISSIONS = { permissions: ["tabs"], origins: ["http://*/*", "https://*/*"] };
const node = (tag, text, className) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
};
const button = (text, handler, className) => {
  const el = node("button", text, className); el.type = "button"; el.addEventListener("click", handler); return el;
};
let tabId = null, supportedTab = false, headerCheckSupported = false, data = null, selectedId = null, working = false, editorDirty = false, dataKnown = false, refreshId = 0;
let ipWorking = false, selectionRevision = 0;

const heading = node("div", undefined, "section-heading");
const statusChip = node("span", "检查中", "status neutral");
heading.append(node("h2", "网页语言与时区"), statusChip);
const intro = node("p", "默认不覆盖。可保留原生值，或分别设置语言与时区；覆盖仍可被检测。", "hint region-intro");
const ipPicker = node("div", undefined, "region-ip-picker");
const ipDetect = button("按出口 IP 自动选择", detectIpRegion); ipDetect.id = "region-ip-detect";
const ipNotice = node("p", "点击向 ipwho.is 查询，该服务会看到本次出口 IP；结果仅在当前弹窗显示。分流时可能与目标网站出口不同。", "hint"); ipNotice.id = "region-ip-notice";
const ipResult = node("p", "", "region-ip-result"); ipResult.id = "region-ip-result"; ipResult.hidden = true; ipResult.setAttribute("role", "status");
ipPicker.append(ipDetect, ipNotice, ipResult);
const selector = node("select"); selector.id = "region-profile"; selector.setAttribute("aria-label", "选择语言与时区组合");
const selectionRow = node("div", undefined, "region-selection");
const applyButton = button("启用并刷新", enableSelected, "primary-button");
selectionRow.append(selector, applyButton);
const scopeText = node("p", "", "region-scope");
scopeText.hidden = true;
const stateText = node("p", "正在检查…", "region-state"); stateText.setAttribute("role", "status");
const headerPanel = node("div", undefined, "region-header-check"); headerPanel.hidden = true;
const headerButton = button("核对本站语言请求头", checkHeader);
const headerHint = node("p", "点击向当前检测站发出一次请求；仅核对语言，不保存结果。", "hint");
const headerResult = node("p", "", "region-header-result"); headerResult.hidden = true; headerResult.setAttribute("role", "status");
headerPanel.append(headerButton, headerHint, headerResult);
const checkButton = button("重新检查地区状态", () => refresh()); checkButton.hidden = true;
const pendingText = node("p", "", "region-pending"); pendingText.setAttribute("role", "status"); pendingText.hidden = true;
const actions = node("div", undefined, "region-actions");
actions.hidden = true;
const stopButton = button("停止地区模式", () => action({ type: "regionStop", tabId }));
const cleanupButton = button("恢复权限并清理", retryCleanup);
const refreshCurrentButton = button("刷新当前页", () => action({ type: "regionRefreshCurrent", tabId }));
const refreshAllButton = button("刷新受影响页面", async () => {
  const count = Number(data?.lifecycle?.needsRefresh || 0);
  if (!window.confirm(`将刷新 ${count || "所有受影响的"} 个页面，未保存的表单或编辑内容可能丢失。确定继续？`)) return;
  await action({ type: "regionRefreshAll" });
});
actions.append(stopButton, cleanupButton, refreshCurrentButton, refreshAllButton);
const error = node("p", "", "region-error"); error.setAttribute("role", "alert"); error.hidden = true;

const preview = node("p", "", "region-preview management-only");
const live = node("p", "", "region-live management-only");
const note = node("p", "启用或停止后，已打开的页面可能需要刷新。不会自动刷新其他页面。", "hint management-only");
const readings = node("details", undefined, "region-readings management-only");
readings.hidden = true;
readings.append(node("summary", "组合详情与当前页读回"), preview, live, note);
const editor = node("details", undefined, "region-editor management-only");
editor.hidden = true;
editor.append(node("summary", "自定义／另存组合"));
function field(label, id, placeholder, parent = editor) {
  const wrapper = node("label", undefined, "region-field");
  const input = node("input"); input.id = id; input.type = "text"; input.placeholder = placeholder; input.autocomplete = "off";
  wrapper.append(node("span", label), input); parent.append(wrapper); return input;
}
const nameInput = field("名称", "region-name", "例如：英国英文");
function modeGroup(title, id) {
  const group = node("fieldset", undefined, "region-mode-group");
  group.append(node("legend", title));
  const label = node("label", undefined, "region-native-option");
  const input = node("input"); input.type = "checkbox"; input.id = id;
  label.append(input, node("span", "保留浏览器原生")); group.append(label);
  editor.append(group); return { group, input };
}
const timezoneMode = modeGroup("时区", "region-timezone-native");
const timezoneInput = field("IANA 时区", "region-timezone", "Europe/London", timezoneMode.group); timezoneInput.setAttribute("list", "region-timezones");
timezoneMode.group.append(node("p", "保存并应用后停止时区覆盖，刷新页面后使用原生值；不会修改 macOS 时区。", "hint"));
const timezones = node("datalist"); timezones.id = "region-timezones";
try { for (const value of Intl.supportedValuesOf("timeZone")) { const option = node("option"); option.value = value; timezones.append(option); } } catch {}
timezoneMode.group.append(timezones);
const languageMode = modeGroup("语言与格式", "region-language-native");
const localeInput = field("默认日期／数字格式", "region-locale", "en-GB", languageMode.group);
const languagesInput = field("网页语言，按优先级", "region-languages", "en-GB, en", languageMode.group);
languageMode.group.append(node("p", "覆盖时用逗号分隔，第一语言与区域格式相同。保留原生需保存并应用、刷新页面，才会停止语言 API 和请求头覆盖；不修改系统或 Chrome 界面语言。", "hint"));
const editActions = node("div", undefined, "region-actions");
const saveButton = button("另存为新组合", () => saveProfile(false));
const replaceButton = button("更新此组合", () => saveProfile(true));
const deleteButton = button("删除此组合", deleteProfile);
editActions.append(saveButton, replaceButton, deleteButton); editor.append(editActions);

const help = node("details", undefined, "region-help management-only");
help.append(node("summary", "权限与修改范围"));
help.append(node("p", "启用覆盖时按需申请 HTTP(S) 网站访问和标签页权限。脚本执行与请求头规则 API 为固定权限，便于可靠初始化及撤销后的清理；无网站授权时不能全站操作。不需要“允许运行用户脚本”。撤销网站访问后会停止，重新授权后仍需主动启用。"));
const detailButton = button("打开扩展详情", () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }).catch(showError));
help.append(detailButton);
help.append(node("p", "时区与语言可独立保留原生或覆盖。全原生组合不安装页面脚本、不改写 API 或语言请求头；切换后旧页面仍需刷新。不会改变系统时区、浏览器界面语言、IP 或代理 DNS。"));
help.append(node("p", "可访问的同源 iframe、部分经典 Blob Worker 会同步设置。HTTP、模块、共享及 Service Worker 等仍可能返回原始值，网站也可能发现改写。账号、Cookie 或网址中的语言偏好可能优先。"));

selectionRow.hidden = true;
panel.append(heading, intro, ipPicker, selectionRow, scopeText, stateText, headerPanel, checkButton, pendingText, actions, readings, editor, help, error);
for (const input of [nameInput, timezoneInput, localeInput, languagesInput]) input.addEventListener("input", () => { editorDirty = true; selectionChanged(); });
for (const input of [timezoneMode.input, languageMode.input]) input.addEventListener("change", () => { editorDirty = true; selectionChanged(); syncModeInputs(); });
selector.addEventListener("change", () => {
  if (editorDirty && !window.confirm("切换组合会丢弃尚未保存的编辑，是否继续？")) { selector.value = selectedId; return; }
  selectionChanged(); selectedId = selector.value; editorDirty = false; fillEditor(); showPreview(); setWorking(false);
});

function selectionChanged() {
  selectionRevision++;
  if (!ipWorking) ipResult.hidden = true;
}
function recommendationState() {
  const life = lifecycle();
  return JSON.stringify([data?.enabled, data?.allowed, data?.autoAllowed, life.status, life.requested,
    life.active, life.selectedProfileId, life.cleanupPending]);
}
function showIpResult(text, warning = false) {
  ipResult.textContent = text; ipResult.hidden = false; ipResult.classList.toggle("is-warning", warning);
}
async function detectIpRegion() {
  if (ipWorking || working || !dataKnown) return;
  if (editorDirty) { showIpResult("请先保存当前编辑，或切换组合放弃编辑后再查询。", true); return; }
  const revision = selectionRevision, previous = selectedId, state = recommendationState();
  // Request only the disclosed provider origin, directly from this click.
  const granting = chrome.permissions.request({ origins: [IP_LOOKUP_ORIGIN] });
  ipWorking = true; ipDetect.disabled = true;
  showIpResult("正在查询出口国家与时区…");
  try {
    if (!await granting) throw new Error("未授权查询服务，没有发送出口位置查询。");
    if (selectionRevision !== revision) { showIpResult("设置已变化，未继续查询。可再次点击自动选择。"); return; }
    const result = await send({ type: "regionIpRecommend" });
    // Do not let a late response replace edits, a manual choice, or pause/stop.
    if (working || selectionRevision !== revision) { showIpResult("查询已完成；你已修改设置，保留当前选择。"); return; }
    if (!await refresh() || selectionRevision !== revision || editorDirty || selectedId !== previous || recommendationState() !== state) {
      showIpResult("查询期间设置或权限已变化，保留当前选择；请重新查询。", true); return;
    }
    let country = result.countryCode;
    try { country = new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(country) || country; } catch {}
    const location = `${country} · ${result.timezone}`;
    const profile = data.profiles?.find(item => item.id === result.profileId);
    if (!profile) { showIpResult(`${location}\n暂无对应预设，请手动选择或自定义。`, true); return; }
    selectedId = profile.id; selector.value = selectedId; fillEditor(); showPreview(); setWorking(false);
    showIpResult(`${location}\n已选中「${profile.name}」，${data.enabled === false ? "恢复总开关后再启用" : "点击“启用并刷新”后生效"}。语言沿用预设，可手动调整。\n仅代表本次查询出口；分流可能不同，换节点后请重新查询。`);
  } catch (reason) { showIpResult(reason.message || "出口位置查询失败，请稍后重试。", true); }
  finally { ipWorking = false; ipDetect.disabled = working || !dataKnown; }
}

function selectedProfile() { return data?.profiles?.find(profile => profile.id === selectedId); }
function isNative(profile, dimension) { return profile?.[`${dimension}Mode`] === "native"; }
function allNative(profile) { return Boolean(profile && isNative(profile, "timezone") && isNative(profile, "language")); }
function coverage(profile) {
  if (allNative(profile)) return "时区与语言均保留浏览器原生；不改写页面 API 或语言请求头。";
  const timezone = isNative(profile, "timezone") ? "时区：浏览器原生" : `时区：覆盖为 ${profile?.timezone || "未填写"}`;
  const language = isNative(profile, "language") ? "语言与请求头：浏览器原生" : `语言与格式：覆盖为 ${profile?.locale || "未填写"}`;
  return `${timezone}；${language}。${earlyProfileFor(profile) ? "在网页首个脚本前应用。" : "自定义组合在加载期间应用，网站可能先读到原始值。"}`;
}
function syncModeInputs() {
  const unavailable = working || !dataKnown;
  timezoneInput.disabled = unavailable || timezoneMode.input.checked;
  localeInput.disabled = unavailable || languageMode.input.checked;
  languagesInput.disabled = unavailable || languageMode.input.checked;
  timezoneMode.group.classList.toggle("is-native", timezoneMode.input.checked);
  languageMode.group.classList.toggle("is-native", languageMode.input.checked);
}
function showError(reason) { error.textContent = reason instanceof Error ? reason.message : String(reason); error.hidden = false; }
function lifecycle() { return data?.lifecycle || {}; }
function cleanupPending() { const value = lifecycle().cleanupPending; return Boolean(value?.scripts || value?.headers); }
function unknown(reason) {
  dataKnown = false;
  statusChip.textContent = "未知"; statusChip.className = "status warn";
  stateText.textContent = "当前地区状态无法确认，请重新检查。";
  headerPanel.hidden = true;
  pendingText.hidden = true; actions.hidden = true; readings.hidden = true; editor.hidden = true;
  checkButton.hidden = false; showError(reason);
  window.dispatchEvent(new CustomEvent("region-rendered", { detail: { lifecycle: { status: "unknown", errors: [] },
    name: null, pageMismatch: false, readError: reason?.message || String(reason) } }));
}
function setWorking(value) {
  working = value;
  for (const control of panel.querySelectorAll("button, input, select")) control.disabled = value || !dataKnown;
  checkButton.disabled = value;
  detailButton.disabled = false;
  ipDetect.disabled = value || !dataKnown || ipWorking;
  if (!value) {
    applyButton.disabled = !dataKnown || !selectedProfile() || data?.enabled === false && !allNative(selectedProfile()) || cleanupPending();
    stopButton.disabled = !dataKnown || !(lifecycle().requested || lifecycle().active || cleanupPending());
    const custom = Boolean(selectedId?.startsWith("custom-"));
    replaceButton.disabled = !dataKnown || !custom; deleteButton.disabled = !dataKnown || !custom;
    refreshCurrentButton.disabled = !dataKnown || !supportedTab;
    refreshAllButton.disabled = !dataKnown || (!lifecycle().needsRefresh && !lifecycle().refreshUnknown);
  }
  applyButton.textContent = cleanupPending() ? "先完成清理" : allNative(selectedProfile()) ? "保持原生并刷新" : "启用并刷新";
  syncModeInputs();
}
function fillEditor() {
  const profile = selectedProfile(); if (!profile) return;
  nameInput.value = profile.name || ""; timezoneInput.value = profile.timezone || "";
  localeInput.value = profile.locale || ""; languagesInput.value = (profile.languages || []).join(", ");
  timezoneMode.input.checked = isNative(profile, "timezone");
  languageMode.input.checked = isNative(profile, "language");
  syncModeInputs();
}
function showPreview() {
  const profile = selectedProfile(); if (!profile) { preview.textContent = ""; return; }
  scopeText.textContent = coverage(profile); scopeText.hidden = false;
  let sample = "";
  try { sample = new Intl.DateTimeFormat(isNative(profile, "language") ? undefined : profile.locale, {
    ...(isNative(profile, "timezone") ? {} : { timeZone: profile.timezone }), dateStyle: "medium", timeStyle: "short"
  }).format(new Date()); } catch {}
  preview.textContent = coverage(profile) + (!isNative(profile, "language") ? `\n语言顺序：${(profile.languages || []).join(" → ")}` : "")
    + (sample ? `\n显示示例：${sample}` : "");
}
function render(next, selectId = null) {
  data = next; dataKnown = true; checkButton.hidden = true;
  selectionRow.hidden = false; readings.hidden = false; editor.hidden = false;
  const previous = selectId || selectedId || next.lifecycle?.selectedProfileId || next.defaultProfileId;
  selector.replaceChildren();
  for (const profile of next.profiles || []) { const option = node("option", profile.name); option.value = profile.id; selector.append(option); }
  selectedId = (next.profiles || []).some(profile => profile.id === previous) ? previous : next.profiles?.[0]?.id || null;
  selector.value = selectedId || ""; if (!editorDirty) fillEditor(); showPreview();
  const life = lifecycle(), current = next.current;
  const configured = next.profiles?.find(profile => profile.id === life.selectedProfileId || profile.id === next.defaultProfileId);
  const pageMismatch = life.active && current?.live && (current.status === "pending" || Boolean(next.readError));
  statusChip.className = "status " + (pageMismatch || cleanupPending() || ["cleanup", "error"].includes(life.status) ? "warn" : life.active ? "" : "neutral");
  statusChip.textContent = cleanupPending() ? "待清理" : pageMismatch ? "当前页未一致" : life.active ? "规则已启用" : life.status === "paused" ? "已暂停" : life.status === "setup" ? "待设置" : "已关闭";
  if (cleanupPending()) stateText.textContent = "地区规则尚未完全清理，不能视为已恢复。";
  else if (life.status === "error") stateText.textContent = "地区模式出现错误，请查看详情。";
  else if (pageMismatch) stateText.textContent = `规则已启用，但当前页读数与${configured?.name || "所选组合"}不一致。请重新启用并刷新；下方可查看实际读数。`;
  else if (life.active) stateText.textContent = `${configured?.name || "所选组合"}用于新载入网页。${coverage(configured)}`;
  else if (life.status === "paused") stateText.textContent = "新页面覆盖已暂停；所选组合已保留。";
  else if (life.requested && life.status === "setup") stateText.textContent = "请授权所需的网站访问和扩展权限，再手动启用。";
  else if (life.notices?.length) stateText.textContent = life.notices.join(" ");
  else if (allNative(configured)) stateText.textContent = "已选原生组合，未启用地区覆盖；旧页面如有覆盖仍需刷新。";
  else stateText.textContent = "未启用。选择组合后点击启用才会改变网页。";
  if (life.active && !isNative(configured, "language")) stateText.textContent += " 当前页读回只核对网页 API；服务器收到的语言请求头需单独抽查。";
  headerPanel.hidden = !headerCheckSupported || !life.active || isNative(configured, "language");
  headerResult.hidden = true; headerResult.textContent = "";
  const count = Number(life.needsRefresh || 0);
  pendingText.hidden = count === 0 && !life.refreshUnknown;
  pendingText.textContent = (count ? `${count} 个已打开页面待刷新；其中可能仍保留旧地区。` : "")
    + (life.refreshUnknown ? " 部分页面无法列出，请手动刷新曾使用地区模式的页面。" : "");
  cleanupButton.hidden = !cleanupPending() && life.status !== "error";
  stopButton.hidden = cleanupPending() || (!life.requested && !life.active);
  refreshCurrentButton.hidden = management || (count === 0 && !life.refreshUnknown);
  refreshAllButton.hidden = count === 0 && !life.refreshUnknown;
  actions.hidden = [stopButton, cleanupButton, refreshCurrentButton, refreshAllButton].every(control => control.hidden);
  const actual = current?.live;
  live.textContent = actual ? `当前页读回：${actual.timezone || "时区未知"} · ${actual.locale || "格式未知"}\n语言：${(actual.languages || [actual.language]).filter(Boolean).join(", ")}`
    : supportedTab ? "暂无当前页读回结果。" : "当前标签页不支持读回；新页面配置可在此管理。";
  const errors = [...(life.errors || []), ...(current?.errors || []), ...(next.readError && !current ? [next.readError] : [])].map(item => typeof item === "string" ? item : item.error || item.message || JSON.stringify(item))
    .filter(item => !item.startsWith("页面级覆盖："));
  error.hidden = errors.length === 0;
  if (errors.length) showError([...new Set(errors)].join("\n"));
  setWorking(false);
  window.dispatchEvent(new CustomEvent("region-rendered", { detail: { lifecycle: life, name: configured?.name || null, pageMismatch, readError: next.readError || null } }));
}
const send = message => sendRequest(chrome, message);
async function getTab() {
  const id = params.get("tab");
  if (management && id && /^\d+$/.test(id)) { try { return await withTimeout(chrome.tabs.get(+id), 3000); } catch (error) { if (error.code === "RPC_TIMEOUT") throw error; return null; } }
  return (await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 3000))[0];
}
async function refresh(selectId = null) {
  const requestId = ++refreshId;
  setWorking(true); error.hidden = true;
  try {
    const tab = await getTab(), nextTabId = tab?.id ?? null;
    const next = await send({ type: "regionStatus", tabId: nextTabId });
    if (requestId !== refreshId) return false;
    tabId = nextTabId; supportedTab = /^https?:\/\//i.test(tab?.url || "");
    try { headerCheckSupported = new URL(tab?.url || "").origin === "https://who.1ms.dog"; }
    catch { headerCheckSupported = false; }
    render(next, selectId); return true;
  } catch (reason) { if (requestId === refreshId) unknown(reason); return false; }
  finally { if (requestId === refreshId) setWorking(false); }
}
async function action(message) {
  if (working || !dataKnown) return; selectionChanged(); setWorking(true); error.hidden = true;
  try { await send(message); await refresh(); }
  catch (reason) { await refresh(); showError(reason); }
  finally { setWorking(false); window.dispatchEvent(new Event("region-settings-changed")); }
}
async function checkHeader() {
  if (working || !dataKnown || !headerCheckSupported || !lifecycle().active) return;
  setWorking(true); error.hidden = true;
  headerResult.hidden = false; headerResult.textContent = "正在核对这一次请求…";
  try {
    const result = await send({ type: "regionHeaderCheck", tabId });
    if (result.stale || result.errorCode === "REGION_INACTIVE") {
      await refresh(); showError(result.error || "地区设置已变化，请重新核对。"); return;
    }
    const first = result.status === "match" ? "本次请求：首选语言一致。"
      : result.status === "mismatch" ? "本次请求：语言不一致。" : "本次检查未能确认请求头。";
    const rules = result.ruleInstalled === false || result.ruleCorrect === false ? "本扩展的语言头规则不完整，请重新启用并刷新。"
      : result.ruleMatches === false ? "本扩展的规则未匹配这类请求，请重新启用并刷新。"
      : result.status === "mismatch" ? "规则存在仍不足以证明请求生效；请保留以下结果以便定位。" : "";
    headerResult.textContent = [first,
      `预期请求头：${result.expectedHeader || "未知"}`,
      `服务器回显：${result.receivedHeader || "未取得"}`,
      `当前页语言：${(result.pageLanguages || [result.pageLanguage]).filter(Boolean).join(", ") || "未知"}`,
      `本扩展规则：${result.ruleCorrect === true ? "完整" : result.ruleCorrect === false ? "不完整" : "未知"}；匹配检查：${result.ruleMatches === true ? "通过" : result.ruleMatches === false ? "未通过" : "不可用"}`,
      rules, result.error || "", "只代表本次抽查，不验证其他网站或匿名性。"].filter(Boolean).join("\n");
    headerResult.classList.toggle("is-warning", result.status !== "match");
  } catch (reason) {
    headerResult.textContent = reason.message || String(reason); headerResult.classList.add("is-warning");
  } finally { setWorking(false); }
}
async function enableSelected() {
  if (!dataKnown || !selectedProfile() || working) return;
  selectionChanged();
  // First asynchronous call preserves the explicit click for optional permissions.
  const granting = allNative(selectedProfile()) ? Promise.resolve(true) : chrome.permissions.request(REGION_PERMISSIONS);
  setWorking(true); error.hidden = true;
  try {
    if (!await granting) throw new Error("未授予地区模式权限，基础保护不受影响。");
    await send({ type: "regionApply", tabId, profileId: selectedId }); await refresh();
  } catch (reason) { await refresh(); showError(reason); }
  finally { setWorking(false); window.dispatchEvent(new Event("region-settings-changed")); }
}
async function retryCleanup() {
  if (working || !dataKnown) return;
  selectionChanged();
  // Keep a user-gesture recovery path if optional permissions themselves were revoked.
  // Permission restoration authorizes cleanup only; it must never select/apply a profile.
  const granting = cleanupPending() ? chrome.permissions.request(REGION_PERMISSIONS) : Promise.resolve(true);
  setWorking(true); error.hidden = true;
  try {
    if (!await granting) throw new Error("未授予清理所需权限，待清理状态已保留。");
    await send({ type: "regionRetryCleanup", tabId }); await refresh();
  } catch (reason) { await refresh(); showError(reason); }
  finally { setWorking(false); window.dispatchEvent(new Event("region-settings-changed")); }
}
async function saveProfile(replace) {
  if (working || !dataKnown) return;
  selectionChanged();
  setWorking(true); error.hidden = true;
  try {
    const profile = { name: nameInput.value.trim(),
      timezoneMode: timezoneMode.input.checked ? "native" : "override",
      languageMode: languageMode.input.checked ? "native" : "override",
      timezone: timezoneMode.input.checked ? "" : timezoneInput.value.trim(),
      locale: languageMode.input.checked ? "" : localeInput.value.trim(),
      languages: languageMode.input.checked ? [] : languagesInput.value.split(",").map(value => value.trim()).filter(Boolean) };
    const known = new Set((data?.profiles || []).map(item => item.id));
    const result = await send({ type: "regionSave", profile, tabId, ...(replace ? { id: selectedId } : {}) });
    const savedId = result?.profiles?.find(item => !known.has(item.id))?.id || selectedId;
    editorDirty = false;
    if (await refresh(savedId)) stateText.textContent = "组合已保存。启用前不会自动改变网页。";
  } catch (reason) { showError(reason); }
  finally { setWorking(false); window.dispatchEvent(new Event("region-settings-changed")); }
}
async function deleteProfile() {
  if (!selectedId?.startsWith("custom-")) return;
  await action({ type: "regionDelete", profileId: selectedId, tabId });
}

window.addEventListener("privacy-settings-changed", () => { selectionChanged(); if (!working) refresh(); });
window.addEventListener("focus", () => { if (!working) refresh(); });
window.addEventListener("tracelite-ui-ready", () => {
  if (!dataKnown || !data) return;
  const life = lifecycle(), configured = data.profiles?.find(profile => profile.id === life.selectedProfileId);
  window.dispatchEvent(new CustomEvent("region-rendered", { detail: { lifecycle: life, name: configured?.name || null,
    pageMismatch: Boolean(life.active && data.current?.live && (data.current.status === "pending" || data.readError)), readError: data.readError || null } }));
});
refresh();
