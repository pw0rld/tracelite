// Popup-only presentation. No browser settings, remote requests or data removal.
const $ = selector => document.querySelector(selector);
const drawer = $("#settings-drawer"), backdrop = $("#settings-backdrop");
const background = [$("#app-header"), $("#popup-main"), $("#app-footer")];
let previousFocus = null;

function selectPanel(name) {
  const selected = ["basic", "region", "about"].includes(name) ? name : "basic";
  for (const panel of drawer.querySelectorAll("[data-settings-panel]")) panel.hidden = panel.dataset.settingsPanel !== selected;
  for (const button of drawer.querySelectorAll("[data-settings-tab]")) button.setAttribute("aria-selected", String(button.dataset.settingsTab === selected));
  drawer.querySelector(".drawer-content").scrollTop = 0;
}
function openDrawer(name = "basic", invoker = null) {
  if (drawer.hidden) previousFocus = invoker || document.activeElement;
  selectPanel(name);
  drawer.hidden = false; backdrop.hidden = false;
  document.body.classList.add("drawer-open");
  for (const element of background) element.inert = true;
  $("#settings-title").focus();
}
function closeDrawer() {
  drawer.hidden = true; backdrop.hidden = true;
  document.body.classList.remove("drawer-open");
  for (const element of background) element.inert = false;
  const target = previousFocus?.isConnected && !previousFocus.disabled ? previousFocus : $("#manage");
  target?.focus();
}
$("#manage").addEventListener("click", event => openDrawer("basic", event.currentTarget));
$("#region-shortcut").addEventListener("click", event => openDrawer("region", event.currentTarget));
$("#settings-close").addEventListener("click", closeDrawer);
backdrop.addEventListener("click", closeDrawer);
for (const button of drawer.querySelectorAll("[data-settings-tab]")) button.addEventListener("click", () => selectPanel(button.dataset.settingsTab));
document.addEventListener("keydown", event => {
  if (drawer.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); closeDrawer(); return; }
  if (event.key !== "Tab") return;
  const controls = [...drawer.querySelectorAll("button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]")]
    .filter(element => element.getClientRects().length && !element.closest("[hidden]"));
  if (!controls.length) { event.preventDefault(); return; }
  const first = controls[0], last = controls.at(-1), active = document.activeElement;
  if (event.shiftKey && (active === first || active === $("#settings-title"))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (active === last || active === $("#settings-title"))) { event.preventDefault(); first.focus(); }
});
window.addEventListener("protection-rendered", event => {
  const state = event.detail;
  if (!state || typeof state !== "object") return;
  const notice = state.cleanupPending || state.errors?.length || state.notices?.length || ["paused", "error", "cleanup", "needs-permission"].includes(state.phase);
  $("#protection-panel").classList.toggle("has-protection-notice", Boolean(notice));
  $("#protection-panel").classList.toggle("site-excluded", Boolean(state.siteExcluded));
  $("#site-exception-badge").hidden = !state.siteExcluded;
  $("#site-exception-badge").title = state.matchedExcludedDomain ? `${state.matchedExcludedDomain} 及其子域已加入例外` : "";
});
window.addEventListener("region-rendered", event => {
  const state = event.detail, life = state?.lifecycle;
  if (!life) return;
  const cleanup = life.cleanupPending?.scripts || life.cleanupPending?.headers;
  const refresh = life.needsRefresh || life.refreshUnknown;
  const warning = cleanup || state.pageMismatch || state.readError || life.errors?.length || ["error", "cleanup", "unknown"].includes(life.status);
  $("#region-shortcut").classList.toggle("is-warning", Boolean(warning || refresh));
  $("#region-short-status").textContent = cleanup ? "待清理" : state.pageMismatch ? "当前页未一致" : life.errors?.length ? "需处理"
    : life.status === "unknown" ? "状态未知" : life.status === "paused" ? "已暂停" : refresh ? "有页面待刷新" : life.active ? state.name || "已启用" : "已关闭";
  const readbackWarning = $("#region-quick-warning");
  readbackWarning.hidden = !state.pageMismatch && !state.readError;
  readbackWarning.textContent = state.pageMismatch ? "当前页地区读数尚未对齐，请打开地区与语言查看并刷新。"
    : state.readError ? "地区状态暂时无法确认，请打开设置重新检查。" : "";
});
window.dispatchEvent(new Event("tracelite-ui-ready"));
// Existing saved management URLs still work, but open this small drawer.
if (new URLSearchParams(location.search).get("view") === "manage") openDrawer("basic");
