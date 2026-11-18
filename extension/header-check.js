import { languageRule, matchesLanguageRule } from "./regions.js";
import { validateProfile } from "./region-config.js";
import { withTimeout } from "./rpc.js";

const ORIGIN = "https://who.1ms.dog";
const TARGET_HOSTS = [ORIGIN + "/*"];
const LIMIT = 5000;
const DIAGNOSTIC_LIMIT = 700;
const firstLanguage = value => typeof value === "string" ? value.split(",")[0].split(";")[0].trim().toLowerCase() : "";
const targetUrl = value => {
  try { const url = new URL(value); return url.origin === ORIGIN && !url.username && !url.password; }
  catch { return false; }
};

// Both functions are serialized by Chrome. They deliberately have no imports,
// closures, page-message listeners, settings writes, or remote script loading.
export function readHeaderCheckDocument(expectedOrigin) {
  if (location.origin !== expectedOrigin || !Number.isFinite(performance.timeOrigin) || performance.timeOrigin <= 0) return null;
  return { origin: location.origin, timeOrigin: performance.timeOrigin };
}

export async function fetchHeaderCheck(expectedOrigin, expectedTimeOrigin, nonce, expiresAt) {
  const clean = (value, limit) => typeof value === "string" && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  const current = () => location.origin === expectedOrigin && performance.timeOrigin === expectedTimeOrigin;
  if (expectedOrigin !== "https://who.1ms.dog" || !current()) return { errorCode: "DOCUMENT_CHANGED" };
  // An executeScript call can sit in Chrome's queue past the outer timeout. A
  // late arrival must not start a new request after its check has finished.
  if (!Number.isFinite(expiresAt) || performance.timeOrigin + performance.now() >= expiresAt) return { errorCode: "CHECK_TIMEOUT" };
  if (typeof nonce !== "string" || !/^[a-f0-9-]{36}$/i.test(nonce)) return { errorCode: "INVALID_CHECK" };
  const pageLanguage = clean(navigator.language, 64);
  const pageLanguages = Array.from(navigator.languages || []).slice(0, 16).map(value => clean(value, 64)).filter(value => value !== null);
  let serviceWorkerControlled = false;
  try { serviceWorkerControlled = !!navigator.serviceWorker?.controller; } catch { /* Unavailable in some documents. */ }
  try {
    const response = await fetch("/api/me?privacy_guard_check=" + nonce, {
      cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(4000)
    });
    if (!current()) return { errorCode: "DOCUMENT_CHANGED" };
    if (!response.ok) return { errorCode: "HTTP_ERROR", httpStatus: response.status };
    const json = await response.json();
    if (!current()) return { errorCode: "DOCUMENT_CHANGED" };
    const receivedHeader = clean(json?.h?.["accept-language"], 512);
    const age = response.headers.get("age"), cfCacheStatus = response.headers.get("cf-cache-status");
    // Never return the response body: /api/me also contains addresses and
    // location. Only these explicitly selected language/cache fields cross back.
    return { receivedHeader, pageLanguage, pageLanguages, timeOrigin: performance.timeOrigin,
      responseCache: { age: /^\d{1,10}$/.test(age || "") ? age : null,
        cfCacheStatus: /^[A-Z_ -]{1,32}$/.test(cfCacheStatus || "") ? cfCacheStatus : null,
        serviceWorkerControlled } };
  } catch (error) {
    return { errorCode: error?.name === "TimeoutError" || error?.name === "AbortError" ? "FETCH_TIMEOUT" : "FETCH_FAILED" };
  }
}

const MESSAGES = {
  REGION_INACTIVE: "请先启用地区模式，再检查语言请求头。",
  NATIVE_LANGUAGE: "当前预设保留原生语言，无需检查语言请求头。",
  INVALID_TAB: "无法读取当前标签页，请重新打开扩展后重试。",
  WRONG_SITE: "请在 https://who.1ms.dog/ 的检测页手动运行此检查。",
  ACCESS_MISSING: "网站访问或地区脚本权限不可用，请先检查扩展权限。",
  DOCUMENT_CHANGED: "检测页已切换或刷新，请在当前页重新检查。",
  CHECK_TIMEOUT: "语言请求头检查超时，请在检测页就绪后重试。",
  FETCH_TIMEOUT: "检测服务响应超时，请稍后重试。",
  FETCH_FAILED: "无法读取检测服务，请检查连接后重试。",
  HTTP_ERROR: "检测服务返回错误，请稍后重试。",
  HEADER_MISSING: "检测服务没有返回有效的 Accept-Language 请求头。",
  PAGE_LANGUAGE_MISSING: "无法读取当前页的语言，请刷新检测页后重试。",
  INVALID_CHECK: "本次检查参数无效，请重新运行。"
};

function summarizeRule(rule) {
  if (!rule) return null;
  const header = rule.action?.requestHeaders?.find(item => item.header?.toLowerCase() === "accept-language");
  const strings = values => Array.isArray(values) ? values.filter(value => typeof value === "string").slice(0, 32) : null;
  return { id: rule.id, priority: rule.priority || 1, action: rule.action?.type || null,
    header: header?.header || null, operation: header?.operation || null, value: header?.value || null,
    regexFilter: rule.condition?.regexFilter || null, urlFilter: rule.condition?.urlFilter || null,
    resourceTypes: strings(rule.condition?.resourceTypes),
    requestDomains: strings(rule.condition?.requestDomains), initiatorDomains: strings(rule.condition?.initiatorDomains) };
}

export function createHeaderCheck(api) {
  async function check(prepared, tabId) {
    const selected = Array.isArray(prepared?.profiles) ? prepared.profiles.find(item => item?.id === prepared?.lifecycle?.selectedProfileId) : null;
    let profile = null;
    // Built-in presets use the config's legacy default of override. Validate it
    // here instead of treating arbitrary or malformed modes as authorization.
    try { if (selected) profile = validateProfile(selected, selected.id); } catch { /* Refuse a malformed selection. */ }
    const expectedRule = profile?.languageMode === "override" ? languageRule(profile) : null;
    const result = { status: "unknown", expectedHeader: expectedRule?.action.requestHeaders[0].value || null,
      receivedHeader: null, pageLanguage: null, pageLanguages: [], preferredMatch: null,
      expectedPreferredMatch: null, exact: null, ruleInstalled: null, ruleCorrect: null,
      ruleMatches: null, ruleDiagnostic: "unknown", rule: null, hosts: { target: null },
      at: new Date().toISOString(), timeOrigin: null, responseCache: null, error: null, errorCode: null };
    const failed = code => ({ ...result, status: "unknown", errorCode: code, error: MESSAGES[code] || MESSAGES.FETCH_FAILED });
    if (prepared?.lifecycle?.active !== true) return failed("REGION_INACTIVE");
    if (!expectedRule || !Array.isArray(profile.languages) || !profile.languages.length) return failed("NATIVE_LANGUAGE");
    if (!Number.isInteger(tabId) || tabId < 0) return failed("INVALID_TAB");
    const expiresAt = Date.now() + LIMIT;
    let finished = false;
    const live = () => !finished && Date.now() < expiresAt;
    const run = async () => {
      let tab;
      try { tab = await api.tabs.get(tabId); } catch { return failed("INVALID_TAB"); }
      if (!live()) return failed("CHECK_TIMEOUT");
      if (!targetUrl(tab?.url) || tab.pendingUrl && !targetUrl(tab.pendingUrl)) return failed("WRONG_SITE");
      const permissions = await Promise.allSettled([
        Promise.resolve().then(() => api.permissions.contains({ origins: TARGET_HOSTS })),
        Promise.resolve().then(() => api.permissions.contains({ permissions: ["scripting", "declarativeNetRequestWithHostAccess"] }))
      ]);
      result.hosts.target = permissions[0].status === "fulfilled" ? permissions[0].value === true : null;
      if (!live()) return failed("CHECK_TIMEOUT");
      if (result.hosts.target !== true || permissions[1].status !== "fulfilled" || permissions[1].value !== true) return failed("ACCESS_MISSING");
      const nonce = crypto.randomUUID();
      const url = ORIGIN + "/api/me?privacy_guard_check=" + nonce;
      const diagnostics = await Promise.allSettled([
        withTimeout(Promise.resolve().then(() => api.declarativeNetRequest.getDynamicRules()), DIAGNOSTIC_LIMIT),
        withTimeout(Promise.resolve().then(() => api.declarativeNetRequest.testMatchOutcome({
          url, type: "xmlhttprequest", method: "get", initiator: ORIGIN, tabId
        })), DIAGNOSTIC_LIMIT)
      ]);
      if (!live()) return failed("CHECK_TIMEOUT");
      if (diagnostics[0].status === "fulfilled" && Array.isArray(diagnostics[0].value)) {
        const rule = diagnostics[0].value.find(item => item.id === expectedRule.id);
        result.ruleInstalled = !!rule;
        result.rule = summarizeRule(rule);
        result.ruleCorrect = !!rule && matchesLanguageRule(rule, expectedRule);
      }
      if (diagnostics[1].status === "fulfilled" && Array.isArray(diagnostics[1].value?.matchedRules)) {
        result.ruleMatches = diagnostics[1].value.matchedRules.some(item => item.ruleId === expectedRule.id);
        result.ruleDiagnostic = result.ruleMatches ? "matched" : "unmatched";
      }
      let identity;
      try {
        const readings = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "MAIN",
          injectImmediately: true, func: readHeaderCheckDocument, args: [ORIGIN] });
        if (!live()) return failed("CHECK_TIMEOUT");
        identity = readings.find(item => item.frameId === 0);
        if (identity?.error || !identity?.documentId || identity.result?.origin !== ORIGIN
          || !Number.isFinite(identity.result.timeOrigin) || identity.result.timeOrigin <= 0) return failed("DOCUMENT_CHANGED");
        result.timeOrigin = identity.result.timeOrigin;
        const readings2 = await api.scripting.executeScript({ target: { tabId, documentIds: [identity.documentId] }, world: "MAIN",
          injectImmediately: true, func: fetchHeaderCheck, args: [ORIGIN, result.timeOrigin, nonce, expiresAt] });
        if (!live()) return failed("CHECK_TIMEOUT");
        const answer = readings2.find(item => item.documentId === identity.documentId);
        if (answer?.error || !answer?.result) return failed("DOCUMENT_CHANGED");
        const value = answer.result;
        if (value.errorCode) return failed(Object.hasOwn(MESSAGES, value.errorCode) ? value.errorCode : "FETCH_FAILED");
        if (value.timeOrigin !== result.timeOrigin) return failed("DOCUMENT_CHANGED");
        result.receivedHeader = typeof value.receivedHeader === "string" ? value.receivedHeader : null;
        result.pageLanguage = typeof value.pageLanguage === "string" ? value.pageLanguage : null;
        result.pageLanguages = Array.isArray(value.pageLanguages) ? value.pageLanguages.filter(item => typeof item === "string").slice(0, 16) : [];
        result.responseCache = value.responseCache || null;
        const headerFirst = firstLanguage(result.receivedHeader), pageFirst = firstLanguage(result.pageLanguages[0] || result.pageLanguage);
        if (!headerFirst) return failed("HEADER_MISSING");
        if (!pageFirst) return failed("PAGE_LANGUAGE_MISSING");
        result.preferredMatch = headerFirst === pageFirst;
        result.expectedPreferredMatch = headerFirst === firstLanguage(result.expectedHeader);
        result.exact = result.receivedHeader === result.expectedHeader;
        return { ...result, status: result.preferredMatch && result.expectedPreferredMatch ? "match" : "mismatch" };
      } catch { return failed("DOCUMENT_CHANGED"); }
    };
    try { return await withTimeout(run(), LIMIT, MESSAGES.CHECK_TIMEOUT); }
    catch (error) { return failed(error?.code === "RPC_TIMEOUT" ? "CHECK_TIMEOUT" : "FETCH_FAILED"); }
    finally { finished = true; }
  }
  return { check };
}
