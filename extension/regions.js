import { validateProfile, normalizeRegions, profilesFor } from "./region-config.js";
import { applyPageContext } from "./page-context.js";
import { earlyProfileFor, earlyControlEvent, earlyStopTokens } from "./region-early.js";
import { withTimeout } from "./rpc.js";

const SCRIPT_ID = "privacy-guard-bootstrap-v2";
const EARLY_SCRIPT_ID = "privacy-guard-early-v1";
const SCRIPT_IDS = [SCRIPT_ID, EARLY_SCRIPT_ID];
const RULE_ID = 7001;
const PERMISSIONS = ["tabs", "scripting", "declarativeNetRequestWithHostAccess"];
const ORIGINS = ["http://*/*", "https://*/*"];
const RUNTIME_KEY = "regionRuntime";
const DOCUMENT_KEY = "regionDocuments";
const CONTROL_EVENT = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const web = url => { try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; } };
const blankPending = () => ({ scripts: false, headers: false });
const pending = runtime => runtime.cleanupPending.scripts || runtime.cleanupPending.headers;

export function languageRule(profile) {
  if (profile.languageMode === "native") return null;
  const header = profile.languages.map((tag, i) => tag + (i ? `;q=${(1 - i / 10).toFixed(1)}` : "")).join(",");
  return { id: RULE_ID, priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "accept-language", operation: "set", value: header }] },
    condition: { regexFilter: "^https?://", resourceTypes: ["main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "media", "websocket", "other"] } };
}

export function matchesLanguageRule(actual, expected) {
  if (!actual?.action || !actual.condition) return false;
  const normalize = rule => {
    const condition = { ...rule.condition };
    // Chrome may serialize these defaults or reorder the resource-type set.
    if (condition.isUrlFilterCaseSensitive === false) delete condition.isUrlFilterCaseSensitive;
    if (Array.isArray(condition.resourceTypes)) condition.resourceTypes = [...condition.resourceTypes].sort();
    const action = { ...rule.action };
    if (Array.isArray(action.requestHeaders)) action.requestHeaders = action.requestHeaders.map(header => ({ ...header,
      header: typeof header.header === "string" ? header.header.toLowerCase() : header.header }));
    return { ...rule, priority: rule.priority ?? 1, action, condition };
  };
  const canonical = value => JSON.stringify(value, function (key, current) {
    return current && typeof current === "object" && !Array.isArray(current)
      ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) : current;
  });
  // A matching value alone says nothing about the action or request scope.
  return canonical(normalize(actual)) === canonical(normalize(expected));
}

// Only Chrome-supplied sender metadata may identify the injection target.
// There is no page-message bridge or externally_connectable entry point.
export function isRegionDocumentSender(api, sender) {
  return sender?.id === api.runtime.id && Number.isInteger(sender?.tab?.id)
    && typeof sender.documentId === "string" && Number.isInteger(sender.frameId) && web(sender.url);
}

// This function is serialized into the page. Built-in presets have already run
// at document_start: verification must never make a late second modification.
export function readEarlyDocument(profile) {
  const date = new Date(), options = Intl.DateTimeFormat().resolvedOptions();
  const readings = { timezone: options.timeZone, locale: options.locale,
    language: navigator.language, languages: Array.from(navigator.languages),
    offset: date.getTimezoneOffset(), userAgent: navigator.userAgent,
    hasClientHints: !!navigator.userAgentData, timeOrigin: performance.timeOrigin };
  const parse = text => {
    if (text === "GMT" || text === "UTC") return 0;
    const match = /GMT([+−-])(\d{1,2}):?(\d{2})?/.exec(text);
    return match ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] || 0)) : null;
  };
  const zonePart = new Intl.DateTimeFormat("en-US", { timeZone: readings.timezone, timeZoneName: "longOffset" })
    .formatToParts(date).find(part => part.type === "timeZoneName")?.value;
  const intlOffset = parse(zonePart || ""), stringOffset = parse(date.toString());
  const consistent = intlOffset !== null && intlOffset === -readings.offset && stringOffset === intlOffset;
  const matches = readings.timezone === profile.timezone && readings.locale === profile.locale
    && readings.language === profile.languages[0] && readings.languages.join(",") === profile.languages.join(",");
  return { applied: matches && consistent, changed: true, readings, timeOrigin: readings.timeOrigin,
    error: matches && consistent ? null : "当前页未完整应用地区预设，或 Date 与 Intl 读数不一致；请刷新重试。" };
}

export function createRegions(api) {
  const getRegions = async () => normalizeRegions((await api.storage.local.get("regions")).regions);
  const running = async () => (await api.storage.local.get("config")).config?.enabled !== false;
  const saveRuntime = runtime => api.storage.local.set({ [RUNTIME_KEY]: runtime });
  async function state() {
    const raw = (await api.storage.local.get(RUNTIME_KEY))[RUNTIME_KEY];
    if (raw?.schema === 2) return { ...raw, cleanupPending: { ...blankPending(), ...raw.cleanupPending }, errors: Array.isArray(raw.errors) ? raw.errors : [] };
    if (raw?.schema === 1) {
      // Chrome clears user scripts on extension update. The removed permission
      // must never be requested just to migrate. Old ordinary messages are rejected.
      const requested = raw.requested === true && raw.reason !== "permission-revoked";
      const hadHeaders = raw.requested === true || raw.cleanupPending?.headers === true || ["active", "applying"].includes(raw.phase);
      const runtime = { schema: 2, requested, generation: (Number(raw.generation) || 0) + 1,
        phase: requested ? "paused" : "off", reason: raw.reason || "upgraded",
        cleanupPending: { scripts: false, headers: hadHeaders }, errors: [], revision: (Number(raw.revision) || 0) + 1 };
      await saveRuntime(runtime);
      if (raw.requested || raw.cleanupPending?.scripts || raw.cleanupPending?.headers) await markAffected();
      return runtime;
    }
    // v0.2 saved a selected profile as if it were enabled. Keep the selection,
    // but require an explicit Apply after migration; remove old direct MAIN code.
    const legacy = Boolean((await getRegions()).defaultProfileId);
    const runtime = { schema: 2, requested: false, generation: 1, phase: "off", reason: null,
      cleanupPending: { scripts: false, headers: legacy }, errors: [], revision: 1 };
    await saveRuntime(runtime);
    if (legacy) await markAffected();
    return runtime;
  }
  async function documents() {
    const raw = (await api.storage.session.get(DOCUMENT_KEY))[DOCUMENT_KEY];
    return { modified: raw?.modified || {}, refresh: raw?.refresh || {}, observed: raw?.observed || {}, applied: raw?.applied || {}, refreshUnknown: raw?.refreshUnknown === true };
  }
  const saveDocuments = value => api.storage.session.set({ [DOCUMENT_KEY]: value });
  async function stopPropagation() {
    const docs = await documents();
    if (typeof api.tabs.sendMessage !== "function") return;
    // Existing page patches still need a reload. This bounded notification only
    // stops their hooks from extending the old profile to newly made contexts.
    // A closed document or removed host permission may make delivery impossible;
    // keep the refresh notice rather than turn a best-effort stop into a fake
    // script-cleanup error. Late delivery is also safe: it can only stop hooks.
    const notifications = Object.entries(docs.applied)
      .filter(([, value]) => Number.isInteger(value.tabId) && CONTROL_EVENT.test(value.controlEvent || ""))
      .map(([documentId, value]) => Promise.resolve().then(() => api.tabs.sendMessage(value.tabId,
        { type: "regionStopPropagation", controlEvent: value.controlEvent }, { documentId })));
    try { await withTimeout(Promise.allSettled(notifications), 1200, "旧页面上下文停止通知超时"); }
    catch { /* The existing refresh debt remains the visible recovery path. */ }
  }
  async function access() {
    const present = {};
    for (const name of PERMISSIONS) present[name] = await api.permissions.contains({ permissions: [name] });
    const hosts = await api.permissions.contains({ origins: ORIGINS });
    let scriptAllowed = false;
    if (present.scripting && api.scripting) {
      try { await api.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS }); scriptAllowed = true; } catch { /* revoked or unavailable scripting API */ }
    }
    return { present, hosts, scriptAllowed, complete: hosts && scriptAllowed && PERMISSIONS.every(name => present[name]) };
  }
  async function markAffected() {
    const docs = await documents();
    Object.assign(docs.refresh, docs.modified, docs.observed);
    if (await api.permissions.contains({ permissions: ["tabs"] })) {
      try {
        for (const tab of await api.tabs.query({})) if (web(tab.url || tab.pendingUrl)) {
          const value = { title: tab.title || `网页 ${tab.id}` };
          docs.observed[tab.id] = value; docs.refresh[tab.id] = value;
        }
        docs.refreshUnknown = false;
      } catch { docs.refreshUnknown = true; }
    } else docs.refreshUnknown = true;
    await saveDocuments(docs);
  }
  async function clearDocument(tabId) {
    const docs = await documents();
    delete docs.modified[tabId]; delete docs.refresh[tabId]; delete docs.observed[tabId];
    for (const [id, value] of Object.entries(docs.applied)) if (value.tabId === tabId) delete docs.applied[id];
    await saveDocuments(docs);
  }
  async function cleanup(runtime, available) {
    const errors = [];
    if (runtime.cleanupPending.scripts) {
      if (!available.scriptAllowed) errors.push("地区脚本待清理：脚本接口暂不可用，请重新加载扩展后重试；恢复后只清理，不会自动启用。");
      else {
        try {
          const registered = await api.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
          const ids = registered.filter(script => SCRIPT_IDS.includes(script.id)).map(script => script.id);
          if (ids.length) await api.scripting.unregisterContentScripts({ ids });
          runtime.cleanupPending.scripts = false;
        }
        catch (error) { errors.push("地区脚本清理失败：" + error.message); }
      }
    }
    if (runtime.cleanupPending.headers) {
      if (!available.present.declarativeNetRequestWithHostAccess || !api.declarativeNetRequest) errors.push("语言请求头规则待清理：恢复请求规则权限后可重试。");
      else {
        try { await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] }); runtime.cleanupPending.headers = false; }
        catch (error) { errors.push("语言请求头规则清理失败：" + error.message); }
      }
    }
    runtime.errors = errors;
    await saveRuntime(runtime);
    return runtime;
  }
  async function invalidate(runtime, reason, keepRequested) {
    const hadArtifacts = runtime.requested || ["active", "applying"].includes(runtime.phase) || pending(runtime);
    runtime.requested = keepRequested && runtime.requested;
    runtime.generation++;
    runtime.revision++;
    runtime.phase = keepRequested ? "paused" : "off";
    runtime.reason = reason;
    if (hadArtifacts) runtime.cleanupPending = { scripts: true, headers: true };
    await saveRuntime(runtime); // authorization is revoked before any fallible cleanup
    // Stop future automatic MAIN injection before waiting on an old page. A
    // suspended/busy page may take the full notification deadline to respond.
    if (hadArtifacts) await cleanup(runtime, await access());
    if (hadArtifacts) await stopPropagation();
    if (hadArtifacts) await markAffected();
    return runtime;
  }
  async function installed(runtime, profile) {
    try {
      const scripts = await api.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
      const rules = await api.declarativeNetRequest.getDynamicRules();
      const header = languageRule(profile), early = earlyProfileFor(profile);
      const matches = (script, world, file) => script?.world === world
        && script.js?.length === 1 && script.js[0] === file
        && script.runAt === "document_start" && script.allFrames === true && script.persistAcrossSessions === false
        && script.matches?.length === ORIGINS.length && ORIGINS.every(origin => script.matches.includes(origin));
      return runtime.patchVersion === 5 && scripts.length === (early ? 2 : 1)
        && matches(scripts.find(script => script.id === SCRIPT_ID), "ISOLATED", "region-bootstrap.js")
        && (!early || matches(scripts.find(script => script.id === EARLY_SCRIPT_ID), "MAIN", early.file))
        && (header ? rules.some(rule => matchesLanguageRule(rule, header))
          : !rules.some(rule => rule.id === RULE_ID));
    } catch { return false; }
  }
  async function install(runtime, profile) {
    runtime.phase = "applying";
    runtime.cleanupPending = { scripts: true, headers: true };
    runtime.errors = [];
    await saveRuntime(runtime);
    try {
      const header = languageRule(profile);
      await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID], addRules: header ? [header] : [] });
      const early = earlyProfileFor(profile);
      const scripts = [{ id: SCRIPT_ID, matches: ORIGINS, allFrames: true,
        runAt: "document_start", world: "ISOLATED", persistAcrossSessions: false, js: ["region-bootstrap.js"] }];
      if (early) scripts.push({ id: EARLY_SCRIPT_ID, matches: ORIGINS, allFrames: true,
        runAt: "document_start", world: "MAIN", persistAcrossSessions: false, js: [early.file] });
      await api.scripting.registerContentScripts(scripts);
      runtime.cleanupPending = blankPending(); runtime.phase = "active"; runtime.reason = null; runtime.errors = []; runtime.patchVersion = 5;
      await saveRuntime(runtime);
    } catch (error) {
      runtime.requested = false; runtime.generation++; runtime.revision++; runtime.phase = "off"; runtime.reason = "apply-failed";
      await saveRuntime(runtime);
      await cleanup(runtime, await access());
      runtime.errors.unshift("地区模式未完整应用，已停止：" + error.message);
      await saveRuntime(runtime);
      throw new Error(runtime.errors.join("；"));
    }
    return runtime;
  }
  async function reconcile(allowInstall = false) {
    let runtime = await state();
    const available = await access();
    if (runtime.requested && !available.complete) {
      runtime = await invalidate(runtime, "permission-revoked", false);
    }
    if (runtime.requested && !await running() && runtime.phase !== "paused") runtime = await invalidate(runtime, "paused", true);
    if (pending(runtime)) runtime = await cleanup(runtime, available);
    const regions = await getRegions();
    const profile = profilesFor(regions).find(p => p.id === regions.defaultProfileId);
    if (runtime.requested && profile && await running() && available.complete && !pending(runtime)) {
      const current = runtime.phase === "active" && await installed(runtime, profile);
      if (!current && allowInstall) {
        runtime = await invalidate(runtime, "resume", true);
        runtime = await cleanup(runtime, available);
        if (!pending(runtime)) runtime = await install(runtime, profile);
      } else if (!current) {
        runtime.phase = "error";
        runtime.errors = ["地区脚本或请求头规则未就绪，请重新应用。"]; await saveRuntime(runtime);
      }
    }
    return { runtime, available, profile };
  }
  function brief(runtime, available, profile, globalEnabled, needsRefresh, refreshUnknown = false) {
    const active = runtime.requested && globalEnabled && available.complete && runtime.phase === "active" && !pending(runtime);
    const status = pending(runtime) ? "cleanup" : runtime.errors.length ? "error"
      : active ? "active" : runtime.requested && !globalEnabled ? "paused" : runtime.requested ? "setup" : "off";
    const errors = [...runtime.errors];
    const notices = runtime.reason === "permission-revoked" ? ["已停止地区模式；重新授权后仍需手动启用。"] : [];
    return { requested: runtime.requested, active, status, selectedProfileId: profile?.id || null,
      timing: earlyProfileFor(profile) ? "document_start" : profile?.timezoneMode === "native" && profile?.languageMode === "native" ? "native" : "after_authorization",
      cleanupPending: { ...runtime.cleanupPending }, errors, notices, needsRefresh, refreshUnknown, revision: runtime.revision };
  }
  async function summary() {
    const { runtime, available, profile } = await reconcile();
    const docs = await documents();
    return brief(runtime, available, profile, await running(), Object.keys(docs.refresh).length, docs.refreshUnknown);
  }
  async function prepareStatus() {
    const { runtime, available, profile } = await reconcile();
    const docs = await documents(), regions = await getRegions(), globalEnabled = await running();
    const lifecycle = brief(runtime, available, profile, globalEnabled, Object.keys(docs.refresh).length, docs.refreshUnknown);
    return { profiles: profilesFor(regions), defaultProfileId: regions.defaultProfileId, lifecycle,
      refreshTabs: Object.entries(docs.refresh).map(([id, item]) => ({ id: +id, title: item.title })), allowed: available.scriptAllowed,
      autoAllowed: available.complete, enabled: globalEnabled };
  }
  async function statusChanged(prepared) {
    const current = await state();
    return current.revision !== prepared.lifecycle.revision || await running() !== prepared.enabled;
  }
  async function readStatus(prepared, tabId) {
    let live = null, readError = null;
    const profile = prepared.profiles.find(item => item.id === prepared.lifecycle.selectedProfileId);
    if (prepared.allowed && Number.isInteger(tabId)) {
      try {
        const tab = await withTimeout(api.tabs.get(tabId), 1200, "当前标签页读取超时");
        if (web(tab.url)) {
          const injection = earlyProfileFor(profile) ? { func: readEarlyDocument, args: [profile] } : { func: () => ({
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale,
            language: navigator.language, languages: Array.from(navigator.languages), offset: new Date().getTimezoneOffset(),
            userAgent: navigator.userAgent, hasClientHints: !!navigator.userAgentData
          }) };
          const results = await withTimeout(api.scripting.executeScript({ target: { tabId }, world: "MAIN", injectImmediately: true, ...injection }),
            1200, "当前页读数超时，网页可能尚未就绪；地区配置仍可使用");
          const result = results[0]?.result;
          live = result?.readings || result || null;
          if (result?.applied === false) readError = result.error || "当前页地区读数未通过核对，请刷新重试。";
        }
      } catch (error) { readError = error.message; }
    }
    const { lifecycle } = prepared;
    const matches = profile && !!live && !readError && (profile.timezoneMode === "native" || live.timezone === profile.timezone)
      && (profile.languageMode === "native" || live.locale === profile.locale && live.language === profile.languages[0]
        && live.languages?.join(",") === profile.languages.join(","));
    const current = profile ? { profileId: profile.id, profile, status: lifecycle.active ? matches ? "partial" : "pending" : lifecycle.status,
      errors: [...lifecycle.errors, ...(readError ? ["当前页读数不可用：" + readError] : [])], live } : null;
    return { ...prepared, current, readError, stale: await statusChanged(prepared) };
  }
  function unmeasuredStatus(prepared) { return { ...prepared, current: null, readError: "地区状态刚刚变化，请重新检查当前页读数。" }; }
  async function status(tabId) { return readStatus(await prepareStatus(), tabId); }
  async function reload(tabId) {
    if (!Number.isInteger(tabId)) return;
    const previous = await documents();
    const oldIds = Object.entries(previous.applied).filter(([, value]) => value.tabId === tabId).map(([id]) => id);
    await api.tabs.reload(tabId);
    const after = await documents();
    for (const id of oldIds) delete after.applied[id];
    delete after.refresh[tabId];
    // A fast document_start reply may already have registered the replacement
    // document. Do not erase its new guard when the reload promise resolves.
    if (!Object.values(after.applied).some(value => value.tabId === tabId && value.changed !== false)) delete after.modified[tabId];
    await saveDocuments(after);
  }
  async function select(profileId, tabId) {
    const regions = await getRegions();
    const profile = profilesFor(regions).find(p => p.id === profileId);
    if (!profile) throw new Error("地区预设不存在");
    if (profile.timezoneMode === "native" && profile.languageMode === "native") {
      await stop();
      regions.defaultProfileId = profileId; await api.storage.local.set({ regions });
      // Restore by navigation, never stack an attempted inverse patch on a page.
      try { await reload(tabId); } catch (error) {
        const runtime = await state(); runtime.errors.push("原生模式已选定，但当前页刷新失败：" + error.message); await saveRuntime(runtime);
      }
      return status(tabId);
    }
    if (!await running()) throw new Error("请先启用基础保护");
    const available = await access();
    if (!available.complete) throw new Error("请授权地区功能所需的网站访问和脚本执行权限后重试。");
    let runtime = await invalidate(await state(), "apply", false);
    runtime = await cleanup(runtime, available);
    if (pending(runtime)) throw new Error(runtime.errors.join("；"));
    regions.defaultProfileId = profileId; await api.storage.local.set({ regions });
    runtime.requested = true; runtime.reason = null; await saveRuntime(runtime);
    await install(runtime, profile);
    await markAffected();
    try { await reload(tabId); } catch (error) {
      runtime.errors = ["地区已配置，但当前页刷新失败：" + error.message]; await saveRuntime(runtime);
    }
    return status(tabId);
  }
  async function suspend() {
    let runtime = await state();
    if (runtime.requested && runtime.phase !== "paused") runtime = await invalidate(runtime, "paused", true);
    await cleanup(runtime, await access());
    return summary();
  }
  async function resume() { await reconcile(true); return summary(); }
  async function stop() {
    let runtime = await invalidate(await state(), "stopped", false);
    await cleanup(runtime, await access());
  }
  async function permissionsChanged(change = {}) {
    let runtime = await state();
    const relevant = !change.permissions && !change.origins || (change.permissions || []).some(name => PERMISSIONS.includes(name))
      || (change.origins || []).some(origin => origin === "<all_urls>" || /^https?:/.test(origin));
    if (change.removed && relevant && (runtime.requested || runtime.phase === "active")) runtime = await invalidate(runtime, "permission-revoked", false);
    await reconcile(); // granting permissions is a cleanup opportunity, never an Apply
    return summary();
  }
  async function documentRequest(message, sender) {
    if (!["regionBootstrap", "regionDocument", "regionRecheckDocument"].includes(message?.type) || message.protocol !== 2 || !isRegionDocumentSender(api, sender)) return { applied: false };
    const refuse = (extra = {}) => {
      const tokens = earlyStopTokens(message.timeOrigin);
      return { applied: false, ...extra, ...(tokens.length ? { stopEarlyTokens: tokens } : {}) };
    };
    if (message.type === "regionRecheckDocument") {
      const previous = (await documents()).applied[sender.documentId];
      if (!previous || previous.tabId !== sender.tab.id) return refuse();
      // A BFCache restore only rechecks the previous authorization. It must
      // never install, repair or re-enable a profile as a side effect of Back.
      const runtime = (await api.storage.local.get(RUNTIME_KEY))[RUNTIME_KEY];
      const available = await access(), regions = await getRegions();
      const profile = profilesFor(regions).find(item => item.id === regions.defaultProfileId);
      const active = runtime?.schema === 2 && runtime.requested && runtime.phase === "active"
        && previous.generation === runtime.generation && previous.verified !== false && available.complete && profile && await running()
        && !runtime.cleanupPending?.scripts && !runtime.cleanupPending?.headers && await installed(runtime, profile);
      if (active) return { applied: true };
      if (typeof api.tabs.sendMessage === "function" && typeof previous.controlEvent === "string" && CONTROL_EVENT.test(previous.controlEvent)) {
        try {
          await withTimeout(Promise.resolve().then(() => api.tabs.sendMessage(sender.tab.id,
            { type: "regionStopPropagation", controlEvent: previous.controlEvent }, { documentId: sender.documentId })),
          1200, "恢复页面上下文停止通知超时");
        } catch { /* Existing refresh debt remains; an unreachable page is not repaired here. */ }
      }
      return refuse({ reloadRequired: true });
    }
    const { runtime, available, profile } = await reconcile();
    if (!runtime.requested || runtime.phase !== "active" || !available.complete || !profile || !await running()) return refuse();
    if (message.type === "regionBootstrap") return { generation: runtime.generation };
    if (message.generation !== runtime.generation) return refuse();
    // documentIds rejects stale queued requests after navigation, rather than patching
    // a newer document which happens to occupy the same frame/tab.
    try {
      const current = await state();
      if (!current.requested || current.generation !== message.generation) return refuse();
      const before = await documents();
      const previous = before.applied[sender.documentId];
      if (previous) return previous.generation === message.generation && previous.verified !== false
        ? { applied: true, reloadRequired: false } : refuse({ reloadRequired: true });
      // Do not evict guards for live/BFCache documents: that could patch one twice.
      // A deliberate refresh clears this tab's history. At the cap, fail closed.
      if (Object.keys(before.applied).length >= 4096 || Object.values(before.applied).filter(value => value.tabId === sender.tab.id).length >= 128) {
        before.refresh[sender.tab.id] = { title: sender.tab.title || `网页 ${sender.tab.id}` };
        await saveDocuments(before);
        return refuse({ reloadRequired: true });
      }
      const early = earlyProfileFor(profile);
      let controlEvent = early ? null : crypto.randomUUID();
      if (early && Number.isFinite(message.timeOrigin) && message.timeOrigin > 0) {
        // The MAIN entry may already be active even while this readback is
        // queued behind a busy page. Preserve its stop token before waiting.
        controlEvent = earlyControlEvent(early.key, message.timeOrigin);
        const observed = { title: sender.tab.title || `网页 ${sender.tab.id}` };
        before.applied[sender.documentId] = { tabId: sender.tab.id, generation: message.generation,
          changed: true, controlEvent, verified: false };
        before.modified[sender.tab.id] = observed; before.observed[sender.tab.id] = observed;
        before.refresh[sender.tab.id] = observed;
        await saveDocuments(before);
      }
      const injection = early ? { func: readEarlyDocument, args: [profile] }
        : { func: applyPageContext, args: [profile, controlEvent] };
      const execution = api.scripting.executeScript({ target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
        world: "MAIN", injectImmediately: true, ...injection });
      // This path only reads: a late completion cannot apply an obsolete profile.
      // Actual custom-profile writes remain serialized without an unsafe timeout.
      const result = early ? await withTimeout(execution, 1200, "当前页启动读数核对超时，请刷新重试。") : await execution;
      const item = result.find(item => item.documentId === sender.documentId);
      if (item?.error || !item?.result) return refuse();
      if (early) {
        const timeOrigin = Number.isFinite(message.timeOrigin) && message.timeOrigin > 0 ? message.timeOrigin : item.result.timeOrigin;
        if (!Number.isFinite(timeOrigin) || timeOrigin <= 0) return refuse({ error: "无法核对当前文档的启动时间，请刷新重试。" });
        controlEvent = earlyControlEvent(early.key, timeOrigin);
      }
      if (!early && item.result.applied !== true) return refuse();
      const docs = await documents();
      docs.applied[sender.documentId] = { tabId: sender.tab.id, generation: message.generation,
        changed: item.result.changed !== false, controlEvent, verified: item.result.applied === true };
      const observed = { title: sender.tab.title || `网页 ${sender.tab.id}` };
      if (item.result.changed !== false) docs.modified[sender.tab.id] = observed;
      docs.observed[sender.tab.id] = observed;
      if (item.result.applied !== true) docs.refresh[sender.tab.id] = observed;
      else if (sender.frameId === 0 && !item.result.reloadRequired) delete docs.refresh[sender.tab.id];
      await saveDocuments(docs);
      if (item.result.applied !== true) return refuse({ reloadRequired: true,
        error: item.result.error || "地区启动读数未通过核对，请刷新重试。" });
      return { applied: true };
    } catch { return refuse(); } // closed/replaced documents never become another target
  }
  async function checkTabDocument(tabId) {
    try {
      const [top] = await withTimeout(api.scripting.executeScript({ target: { tabId }, world: "MAIN", injectImmediately: true, func: () => null }),
        1200, "页面文档检查超时");
      return top?.documentId || null;
    } catch { return null; }
  }
  async function tabChanged(tabId, change, tab, topDocumentId = null) {
    // A loading event is not proof the old document is gone (failed navigation,
    // iframe loads and bfcache can keep it). Only a verified top-document ID,
    // successful root injection or our explicit refresh clears the notice.
    if (change.status === "complete") {
      const docs = await documents();
      if (docs.refresh[tabId]) {
          const old = topDocumentId && docs.applied[topDocumentId];
          const runtime = await state();
          if (topDocumentId && (!old || old.verified !== false && old.generation === runtime.generation && runtime.phase === "active")) {
            delete docs.refresh[tabId]; await saveDocuments(docs);
          }
      }
    }
    if (web(tab?.url || tab?.pendingUrl)) {
      const docs = await documents(); docs.observed[tabId] = { title: tab.title || `网页 ${tabId}` }; await saveDocuments(docs);
    }
  }
  async function handle(message) {
    if (message.type === "regionStatus") return status(message.tabId);
    if (message.type === "regionApply" || message.type === "regionDefault" && message.profileId) return select(message.profileId, message.tabId);
    if (["regionStop", "regionStopAll", "regionDefault"].includes(message.type)) { await stop(); return status(message.tabId); }
    if (message.type === "regionRetryCleanup") { await reconcile(); return status(message.tabId); }
    if (["regionRefreshCurrent", "regionRefreshAll", "regionRefresh"].includes(message.type)) {
      await reconcile();
      const all = message.type === "regionRefreshAll" || message.all === true;
      if (all && (await documents()).refreshUnknown) await markAffected();
      const ids = all ? Object.keys((await documents()).refresh).map(Number) : [message.tabId];
      const results = await Promise.allSettled(ids.map(reload));
      const failed = results.filter(r => r.status === "rejected");
      if (failed.length) throw new Error(`${failed.length} 个页面刷新失败，请手动刷新。`);
      return status(message.tabId);
    }
    const regions = await getRegions();
    if (message.type === "regionSave") {
      const id = message.id || "custom-" + crypto.randomUUID();
      if (!/^custom-[a-z0-9-]{1,60}$/.test(id)) throw new Error("内置预设不可覆盖，请另存自定义");
      if (!regions.custom.some(p => p.id === id) && regions.custom.length >= 20) throw new Error("最多保存 20 个自定义地区");
      const profile = validateProfile(message.profile, id);
      regions.custom = [...regions.custom.filter(p => p.id !== id), profile];
      await api.storage.local.set({ regions });
      const runtime = await state();
      if (regions.defaultProfileId === id && runtime.requested) {
        // Changing an active saved profile does not silently change pages; stop it.
        await stop();
      }
    } else if (message.type === "regionDelete") {
      if (!regions.custom.some(p => p.id === message.profileId)) throw new Error("内置预设不可删除");
      if (regions.defaultProfileId === message.profileId) { await stop(); regions.defaultProfileId = null; }
      regions.custom = regions.custom.filter(p => p.id !== message.profileId); await api.storage.local.set({ regions });
    } else throw new Error("未知地区请求");
    return status(message.tabId);
  }
  return { handle, status, prepareStatus, readStatus, statusChanged, unmeasuredStatus, summary, suspend, resume, permissionsChanged, documentRequest,
    checkTabDocument, tabChanged, tabRemoved: clearDocument,
    stopAll: suspend }; // compatibility with older callers, without pretending cleanup succeeded
}
