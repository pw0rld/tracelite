import { DEFINITIONS, normalizeConfig, normalOrigin, applySettings, readSetting, applySiteRules, readSiteSetting } from "./settings.js";
import { createRegions, isRegionDocumentSender } from "./regions.js";
import { summarizeState } from "./status.js";
import { earlyStopTokens } from "./region-early.js";
import { createHeaderCheck } from "./header-check.js";
import { createRegionIpLookup } from "./region-ip.js";
import { createRequestProtection } from "./request-protection.js";
import { createSiteCleanup } from "./site-cleanup.js";
import { withTimeout } from "./rpc.js";

const regions = createRegions(chrome);
const headerCheck = createHeaderCheck(chrome);
const protection = createRequestProtection(chrome);
const siteCleanup = createSiteCleanup(chrome);
let regionIpLookup = null;

let queue = Promise.resolve();
const exclusive = task => {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
};
let siteErrors = [];
let settingErrors = {};

async function config() {
  const stored = await chrome.storage.local.get("config");
  return normalizeConfig(stored.config);
}

async function snapshot(origin = null, incognito = false) {
  const current = await config();
  const settings = await Promise.all(DEFINITIONS.map(d => readSetting(chrome, d, current, settingErrors[d.id], incognito)));
  const site = await readSiteSetting(chrome, origin, incognito);
  const region = await regions.summary();
  const requestProtection = await protection.status(origin);
  return { config: current, settings, site, siteErrors, incognito, region, protection: requestProtection };
}

async function protectionStatus(tabId) {
  let currentOrigin = null, incognito = false;
  if (Number.isInteger(tabId)) {
    try {
      const tab = await withTimeout(chrome.tabs.get(tabId), 1200, "当前标签页读取超时");
      currentOrigin = normalOrigin(tab.url); incognito = tab.incognito === true;
    } catch { /* Rules can still be managed without a readable current tab. */ }
  }
  const current = await config();
  return { ...await protection.status(currentOrigin), currentOrigin,
    currentHostname: currentOrigin ? new URL(currentOrigin).hostname : null,
    globalEnabled: current.enabled, incognito };
}

async function badge(state) {
  const view = summarizeState(state);
  await chrome.action.setBadgeText({ text: view.text });
  await chrome.action.setBadgeBackgroundColor({ color: view.color });
  await chrome.action.setTitle({ title: view.title });
}

async function apply(current, reconcileRegions = true) {
  await chrome.storage.local.set({ config: current });
  // Region reconciliation records its own failures. Native controls must still proceed.
  try { if (reconcileRegions) { if (current.enabled) await regions.resume(); else await regions.suspend(); } }
  catch (error) { console.error("Region reconciliation failed", error); }
  try { await protection.reconcile(current.enabled); }
  catch (error) { console.error("Request protection reconciliation failed", error); }
  const rows = await applySettings(chrome, current);
  settingErrors = Object.fromEntries(rows.filter(row => row.error).map(row => [row.id, row.error]));
  const saved = await chrome.storage.local.get(["siteApplied", "siteErrors"]);
  siteErrors = await applySiteRules(chrome, current, saved.siteErrors?.length ? null : saved.siteApplied || null);
  await chrome.storage.local.set({ siteApplied: current, siteErrors });
  const state = await snapshot();
  await badge(state);
  return state;
}

async function handle(message) {
  if (!message || typeof message !== "object") throw new Error("无效请求");
  if (message.type === "protectionStatus") return protectionStatus(message.tabId);
  if (message.type === "protectionConfigure" || message.type === "protectionRetry") {
    const current = await config();
    if (message.type === "protectionConfigure") await protection.configure(message, current.enabled);
    else await protection.reconcile(current.enabled);
    await badge(await snapshot());
    return protectionStatus(message.tabId);
  }
  if (typeof message.type === "string" && message.type.startsWith("region")) {
    const result = await regions.handle(message);
    await badge(await snapshot());
    return result;
  }
  const current = await config();
  if (message.type === "status") {
    const saved = await chrome.storage.local.get("siteErrors");
    siteErrors = saved.siteErrors || [];
    const state = await snapshot(normalOrigin(message.origin), message.incognito === true);
    await badge(state);
    return state;
  }
  if (message.type === "enabled" && typeof message.value === "boolean") current.enabled = message.value;
  else if (message.type === "select" && DEFINITIONS.some(d => d.id === message.id) && typeof message.value === "boolean") current.selected[message.id] = message.value;
  else if (message.type === "defaults") {
    const defaults = normalizeConfig({ enabled: current.enabled, blockedOrigins: current.blockedOrigins });
    return apply(defaults, false);
  } else if (message.type === "site" && typeof message.block === "boolean") {
    const origin = normalOrigin(message.origin);
    if (!origin) throw new Error("仅支持 HTTP / HTTPS 站点");
    current.blockedOrigins = current.blockedOrigins.filter(item => item !== origin);
    if (message.block) {
      if (current.blockedOrigins.length >= 100) throw new Error("最多保存 100 个站点");
      current.blockedOrigins.push(origin);
    }
  } else if (message.type !== "retry") throw new Error("未知请求");
  return apply(current);
}

chrome.runtime.onInstalled.addListener(() => { exclusive(async () => apply(await config())).catch(console.error); });
chrome.runtime.onStartup.addListener(() => { exclusive(async () => apply(await config())).catch(console.error); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (isRegionDocumentSender(chrome, sender)) {
    if (!["regionBootstrap", "regionDocument", "regionRecheckDocument"].includes(message?.type)) return false;
    exclusive(async () => {
      const result = await regions.documentRequest(message, sender);
      await badge(await snapshot());
      return result;
    }).then(respond, error => respond({ applied: false, error: error.message, stopEarlyTokens: earlyStopTokens(message.timeOrigin) }));
    return true;
  }
  // Only our own extension documents may change browser settings.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  if (message?.type === "regionIpRecommend") {
    // An explicit popup query is advisory only. Network work must never hold
    // the mutation queue or accept an endpoint supplied by a caller.
    Promise.resolve().then(() => {
      regionIpLookup ||= createRegionIpLookup(chrome);
      return regionIpLookup.lookup();
    }).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (["cleanupPrepare", "cleanupStart", "cleanupStatus"].includes(message?.type)) {
    // Browser data removal may take tens of seconds. Its one-shot job must
    // never occupy the settings queue or delay pause/permission cleanup.
    Promise.resolve().then(() => message.type === "cleanupPrepare" ? siteCleanup.prepare(message.tabId, message.kind)
      : message.type === "cleanupStart" ? siteCleanup.start(message.token) : siteCleanup.getStatus(message.id))
      .then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "regionHeaderCheck") {
    let prepared;
    exclusive(() => regions.prepareStatus()).then(value => {
      prepared = value;
      return headerCheck.check(value, message.tabId);
    }).then(result => exclusive(async () => await regions.statusChanged(prepared)
      ? { ...result, status: "unknown", stale: true, error: "检查期间地区设置已变化，请重新核对。" } : result))
      .then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "regionStatus") {
    // Snapshot configuration in order, but never hold the mutation queue while
    // waiting for an unresponsive website's optional readback.
    exclusive(() => regions.prepareStatus()).then(prepared => regions.readStatus(prepared, message.tabId))
      .then(result => exclusive(async () => result.stale || await regions.statusChanged(result)
        ? regions.unmeasuredStatus(await regions.prepareStatus()) : result))
      .then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
    return true;
  }
  exclusive(() => handle(message)).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});

for (const [event, removed] of [[chrome.permissions.onRemoved, true], [chrome.permissions.onAdded, false]]) {
  event.addListener(details => {
    exclusive(async () => {
      await regions.permissionsChanged({ ...details, removed });
      await protection.permissionsChanged({ ...details, removed }, (await config()).enabled);
      await badge(await snapshot());
    }).catch(console.error);
  });
}
const tabUpdates = new Map();
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  // Title/favicon/audio updates cannot change region coverage. Coalesce relevant
  // events; a page probe may wait for a renderer but must not block settings.
  if (change.status === "loading") tabUpdates.delete(tabId);
  if (change.status !== "complete" && !change.url) return;
  const token = {}; tabUpdates.set(tabId, token);
  const probe = change.status === "complete" ? regions.checkTabDocument(tabId) : Promise.resolve(null);
  probe.then(documentId => exclusive(async () => {
    if (tabUpdates.get(tabId) !== token) return;
    tabUpdates.delete(tabId);
    await regions.tabChanged(tabId, change, tab, documentId);
    await badge(await snapshot());
  })).catch(console.error);
});
chrome.tabs.onRemoved.addListener(tabId => {
  tabUpdates.delete(tabId);
  exclusive(async () => { await regions.tabRemoved(tabId); await badge(await snapshot()); }).catch(console.error);
});

for (const definition of DEFINITIONS) {
  chrome.privacy?.[definition.section]?.[definition.key]?.onChange?.addListener(() => {
    exclusive(async () => badge(await snapshot())).catch(console.error);
  });
}
