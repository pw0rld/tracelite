import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createHeaderCheck, fetchHeaderCheck, readHeaderCheckDocument } from "../extension/header-check.js";
import { languageRule } from "../extension/regions.js";
import { BUILTIN_PROFILES } from "../extension/region-config.js";

const ORIGIN = "https://who.1ms.dog";
const profile = BUILTIN_PROFILES.find(item => item.id === "us-en");
const normalize = value => JSON.parse(JSON.stringify(value));
function fixture({ header = "en-US,en;q=0.9", body, url = ORIGIN + "/zh-cn/", language = "en-US", languages = ["en-US", "en"] } = {}) {
  const calls = { tabs: [], permissions: [], rules: 0, matches: [], scripts: [], fetches: [], signals: [] };
  const documentId = "original-document";
  const context = vm.createContext({ location: { origin: ORIGIN }, performance: { timeOrigin: Date.now() - 100, now: () => 10 },
    navigator: { language, languages, serviceWorker: { controller: null } },
    AbortSignal: { timeout(ms) { calls.signals.push(ms); return { timeoutMs: ms }; } },
    async fetch(request, options) {
      calls.fetches.push({ request, options });
      return { ok: true, status: 200, headers: { get: name => ({ age: "12", "cf-cache-status": "DYNAMIC" })[name] || null },
        json: async () => body === undefined ? { h: { "accept-language": header }, ip: "DO-NOT-RETURN-IP", city: "DO-NOT-RETURN-LOCATION" } : body };
    }
  });
  const prepared = { profiles: [profile], lifecycle: { active: true, selectedProfileId: profile.id }, enabled: true };
  const api = {
    tabs: { async get(tabId) { calls.tabs.push(tabId); return { id: tabId, url }; } },
    permissions: { async contains(details) { calls.permissions.push(details); return true; } },
    declarativeNetRequest: {
      async getDynamicRules() { calls.rules++; return [languageRule(profile)]; },
      async testMatchOutcome(details) { calls.matches.push(details); return { matchedRules: [{ ruleId: 7001, rulesetId: "_dynamic" }] }; }
    },
    scripting: { async executeScript(details) {
      calls.scripts.push(details);
      const result = await vm.runInContext(`(${details.func.toString()})(...${JSON.stringify(details.args)})`, context);
      return [{ frameId: 0, documentId, result: normalize(result) }];
    } }
  };
  return { api, prepared, calls, context, documentId, check: createHeaderCheck(api).check };
}

test("explicit check compares actual header and page language without returning the rest of the response", async () => {
  const f = fixture(), result = await f.check(f.prepared, 42);
  assert.equal(result.status, "match");
  assert.equal(result.expectedHeader, "en-US,en;q=0.9");
  assert.equal(result.receivedHeader, result.expectedHeader);
  assert.deepEqual(result.pageLanguages, ["en-US", "en"]);
  assert.equal(result.pageLanguage, "en-US");
  assert.equal(result.preferredMatch, true); assert.equal(result.expectedPreferredMatch, true); assert.equal(result.exact, true);
  assert.equal(result.ruleInstalled, true); assert.equal(result.ruleCorrect, true);
  assert.equal(result.ruleMatches, true); assert.equal(result.ruleDiagnostic, "matched");
  assert.deepEqual(result.hosts, { target: true });
  assert.deepEqual(result.responseCache, { age: "12", cfCacheStatus: "DYNAMIC", serviceWorkerControlled: false });
  assert.ok(Number.isFinite(result.timeOrigin)); assert.ok(Number.isFinite(Date.parse(result.at)));
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-RETURN/);
  assert.equal(f.calls.fetches.length, 1);
  assert.match(f.calls.fetches[0].request, /^\/api\/me\?privacy_guard_check=[a-f0-9-]{36}$/);
  assert.deepEqual(normalize(f.calls.fetches[0].options), { cache: "no-store", credentials: "omit", redirect: "error", signal: { timeoutMs: 4000 } });
  assert.deepEqual(f.calls.signals, [4000]);
  assert.deepEqual(f.calls.scripts[0].target, { tabId: 42, frameIds: [0] });
  assert.deepEqual(f.calls.scripts[1].target, { tabId: 42, documentIds: [f.documentId] });
  assert.ok(f.calls.scripts.every(item => item.world === "MAIN" && item.injectImmediately));
  assert.deepEqual(f.calls.permissions, [{ origins: [ORIGIN + "/*"] }, { permissions: ["scripting", "declarativeNetRequestWithHostAccess"] }]);
  assert.equal(f.calls.matches[0].url, ORIGIN + f.calls.fetches[0].request);
  assert.equal(f.calls.matches[0].initiator, ORIGIN);
  assert.equal(f.calls.matches[0].type, "xmlhttprequest");
});

test("inactive, paused, absent profile and native-language profiles never read the page or start a network request", async () => {
  for (const variant of ["off", "paused", "missing", "native"]) {
    const f = fixture();
    if (variant === "off" || variant === "paused") f.prepared.lifecycle.active = false;
    if (variant === "missing") f.prepared.lifecycle.selectedProfileId = "absent";
    if (variant === "native") f.prepared.profiles = [{ ...profile, languageMode: "native", languages: [] }];
    const result = await f.check(f.prepared, 42);
    assert.equal(result.status, "unknown"); assert.ok(result.error);
    assert.equal(f.calls.tabs.length, 0); assert.equal(f.calls.scripts.length, 0); assert.equal(f.calls.fetches.length, 0);
  }
});

test("only the exact HTTPS who origin is eligible", async () => {
  for (const url of ["http://who.1ms.dog/zh-cn/", "https://who.1ms.dog.evil.example/", "https://check.1ms.dog/", "https://who.1ms.dog:8443/", "https://user:pass@who.1ms.dog/", "chrome://extensions/"]) {
    const f = fixture({ url }), result = await f.check(f.prepared, 42);
    assert.equal(result.errorCode, "WRONG_SITE", url);
    assert.equal(f.calls.permissions.length, 0); assert.equal(f.calls.scripts.length, 0); assert.equal(f.calls.fetches.length, 0);
  }
  const f = fixture();
  f.api.tabs.get = async () => ({ url: ORIGIN + "/zh-cn/", pendingUrl: "https://example.com/" });
  assert.equal((await f.check(f.prepared, 42)).errorCode, "WRONG_SITE");
  assert.equal(f.calls.fetches.length, 0);
});

test("invalid or inaccessible tabs and missing live permissions cannot inject or fetch", async () => {
  const invalid = fixture();
  for (const tabId of [undefined, null, "42", -1, 1.5]) assert.equal((await invalid.check(invalid.prepared, tabId)).errorCode, "INVALID_TAB");
  assert.equal(invalid.calls.tabs.length, 0);
  for (const denied of ["tabs", "hosts", "scripting", "permissions-error"]) {
    const f = fixture();
    if (denied === "tabs") f.api.tabs.get = async () => { throw new Error("tab gone"); };
    else f.api.permissions.contains = async details => {
      if (denied === "permissions-error") throw new Error("permission API unavailable");
      return denied === "hosts" ? !details.origins : !details.permissions;
    };
    const result = await f.check(f.prepared, 42);
    assert.equal(result.status, "unknown");
    assert.equal(result.errorCode, denied === "tabs" ? "INVALID_TAB" : "ACCESS_MISSING");
    assert.equal(f.calls.scripts.length, 0); assert.equal(f.calls.fetches.length, 0);
  }
});

test("header comparison follows the site's first-tag test and also reports full-header equality", async () => {
  const different = fixture({ header: "zh-CN,zh;q=0.9" });
  const result = await different.check(different.prepared, 42);
  assert.equal(result.status, "mismatch"); assert.equal(result.preferredMatch, false); assert.equal(result.exact, false);
  const formatted = fixture({ header: "EN-us, en;q=0.8" });
  const result2 = await formatted.check(formatted.prepared, 42);
  assert.equal(result2.status, "match"); assert.equal(result2.preferredMatch, true); assert.equal(result2.exact, false);
  const oldPage = fixture({ header: "ja-JP,ja;q=0.9", language: "ja-JP", languages: ["ja-JP", "ja"] });
  const result3 = await oldPage.check(oldPage.prepared, 42);
  assert.equal(result3.preferredMatch, true); assert.equal(result3.expectedPreferredMatch, false); assert.equal(result3.status, "mismatch");
});

test("no header, invalid header and missing page language produce unknown rather than a false mismatch", async () => {
  for (const body of [{}, { h: {} }, { h: { "accept-language": null } }, { h: { "accept-language": "" } },
    { h: { "accept-language": "en-US\r\nSecret: value" } }, { h: { "accept-language": "a".repeat(513) } }]) {
    const f = fixture({ body }), result = await f.check(f.prepared, 42);
    assert.equal(result.status, "unknown"); assert.equal(result.errorCode, "HEADER_MISSING");
    assert.equal(result.preferredMatch, null);
  }
  const f = fixture({ language: "", languages: [] }), result = await f.check(f.prepared, 42);
  assert.equal(result.errorCode, "PAGE_LANGUAGE_MISSING"); assert.equal(result.status, "unknown");
});

test("unpacked-only testMatchOutcome failure is a diagnostic unknown, not a network-check failure", async () => {
  const f = fixture();
  f.api.declarativeNetRequest.testMatchOutcome = async () => { throw new Error("not available for this extension"); };
  const result = await f.check(f.prepared, 42);
  assert.equal(result.status, "match"); assert.equal(result.ruleMatches, null); assert.equal(result.ruleDiagnostic, "unknown");
  assert.equal(result.ruleInstalled, true); assert.equal(result.error, null); assert.equal(f.calls.fetches.length, 1);
});

test("unavailable or stale actual rules are reported independently of the measured header", async () => {
  for (const variant of ["error", "missing", "wrong"]) {
    const f = fixture();
    f.api.declarativeNetRequest.getDynamicRules = async () => {
      if (variant === "error") throw new Error("API unavailable");
      if (variant === "missing") return [];
      const rule = languageRule(profile); rule.action.requestHeaders[0].operation = "append"; return [rule];
    };
    f.api.declarativeNetRequest.testMatchOutcome = async () => ({ matchedRules: [] });
    const result = await f.check(f.prepared, 42);
    assert.equal(result.status, "match"); assert.equal(result.ruleMatches, false);
    assert.equal(result.ruleDiagnostic, "unmatched");
    assert.equal(result.ruleInstalled, variant === "error" ? null : variant === "wrong");
    assert.equal(result.ruleCorrect, variant === "error" ? null : false);
  }
});

test("rule correctness shares full semantic matching, accepting browser defaults but rejecting added scope", async () => {
  for (const variant of ["normalized", "scoped", "extra-header"]) {
    const f = fixture(), rule = languageRule(profile);
    rule.condition.isUrlFilterCaseSensitive = false;
    rule.condition.resourceTypes.reverse();
    rule.action.requestHeaders[0].header = "Accept-Language";
    if (variant === "scoped") rule.condition.requestDomains = ["another.example"];
    if (variant === "extra-header") rule.action.requestHeaders.push({ header: "x-unexpected", operation: "set", value: "unexpected" });
    f.api.declarativeNetRequest.getDynamicRules = async () => [rule];
    const result = await f.check(f.prepared, 42);
    assert.equal(result.ruleInstalled, true);
    assert.equal(result.ruleCorrect, variant === "normalized");
    assert.equal(result.status, "match");
  }
});

test("readback requires a main-frame documentId and never falls back to a tab-targeted fetch", async () => {
  for (const bad of [{ frameId: 0, result: { origin: ORIGIN, timeOrigin: 123 } },
    { frameId: 1, documentId: "child", result: { origin: ORIGIN, timeOrigin: 123 } },
    { frameId: 0, documentId: "current", result: { origin: "https://example.com", timeOrigin: 123 } }]) {
    const f = fixture(); f.api.scripting.executeScript = async details => { f.calls.scripts.push(details); return [bad]; };
    const result = await f.check(f.prepared, 42);
    assert.equal(result.errorCode, "DOCUMENT_CHANGED"); assert.equal(f.calls.scripts.length, 1); assert.equal(f.calls.fetches.length, 0);
  }
});

test("a navigation race cannot substitute another document's result", async () => {
  const f = fixture(), execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async details => {
    const value = await execute(details);
    if (details.target.documentIds) value[0].documentId = "replacement-document";
    return value;
  };
  const result = await f.check(f.prepared, 42);
  assert.equal(result.status, "unknown"); assert.equal(result.errorCode, "DOCUMENT_CHANGED");
  assert.equal(f.calls.scripts[1].target.documentIds[0], f.documentId);
});

test("serialized functions are self-contained and revalidate origin, time origin and deadline before fetching", async () => {
  for (const variant of ["origin", "timeOrigin", "deadline", "expectedOrigin", "nonce"]) {
    const f = fixture(), origin = variant === "expectedOrigin" ? "https://example.com" : ORIGIN;
    const timeOrigin = f.context.performance.timeOrigin;
    if (variant === "origin") f.context.location.origin = "https://example.com";
    if (variant === "timeOrigin") f.context.performance.timeOrigin++;
    const nonce = variant === "nonce" ? "../other?secret=value" : "12345678-1234-1234-1234-123456789abc";
    const expiresAt = variant === "deadline" ? Date.now() - 1000 : Date.now() + 5000;
    const value = await vm.runInContext(`(${fetchHeaderCheck.toString()})(...${JSON.stringify([origin, timeOrigin, nonce, expiresAt])})`, f.context);
    assert.ok(value.errorCode); assert.equal(f.calls.fetches.length, 0, variant);
  }
  const f = fixture();
  assert.equal(vm.runInContext(`(${readHeaderCheckDocument.toString()})('https://example.com')`, f.context), null);
});

test("navigation while awaiting the response discards the result", async () => {
  const f = fixture(), originalFetch = f.context.fetch;
  f.context.fetch = async (...args) => { const response = await originalFetch(...args); f.context.performance.timeOrigin++; return response; };
  const result = await f.check(f.prepared, 42);
  assert.equal(result.errorCode, "DOCUMENT_CHANGED"); assert.equal(result.receivedHeader, null);
});

test("network, JSON, HTTP and fetch-timeout errors are bounded fixed messages without raw response data", async () => {
  for (const variant of ["network", "json", "http", "timeout"]) {
    const f = fixture();
    f.context.fetch = async () => {
      if (variant === "network" || variant === "timeout") { const error = new Error("DO-NOT-RETURN-IP"); error.name = variant === "timeout" ? "TimeoutError" : "TypeError"; throw error; }
      return { ok: variant !== "http", status: 503, headers: { get: () => null }, json: async () => { throw new Error("DO-NOT-RETURN-LOCATION"); } };
    };
    const result = await f.check(f.prepared, 42);
    assert.equal(result.status, "unknown");
    assert.equal(result.errorCode, variant === "http" ? "HTTP_ERROR" : variant === "timeout" ? "FETCH_TIMEOUT" : "FETCH_FAILED");
    assert.doesNotMatch(JSON.stringify(result), /DO-NOT-RETURN/);
  }
});

test("a hanging Chrome call times out and a late completion cannot start a network check", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
  const f = fixture(); let resolveTab, entered;
  const entry = new Promise(resolve => { entered = resolve; });
  f.api.tabs.get = () => new Promise(resolve => { resolveTab = resolve; entered(); });
  const checking = f.check(f.prepared, 42);
  await entry;
  t.mock.timers.tick(5001);
  const result = await checking;
  assert.equal(result.status, "unknown"); assert.equal(result.errorCode, "CHECK_TIMEOUT");
  resolveTab({ id: 42, url: ORIGIN + "/zh-cn/" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.scripts.length, 0); assert.equal(f.calls.fetches.length, 0);
});

test("a fetch script queued past the outer deadline refuses the request even if Chrome later runs it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
  const f = fixture(), originalExecute = f.api.scripting.executeScript;
  let entered, release, queued;
  const entry = new Promise(resolve => { entered = resolve; });
  f.api.scripting.executeScript = details => {
    if (!details.target.documentIds) return originalExecute(details);
    queued = details;
    return new Promise(resolve => {
      release = async () => { const result = await originalExecute(details); resolve(result); return result; };
      entered();
    });
  };
  const checking = f.check(f.prepared, 42);
  await entry;
  t.mock.timers.tick(5001);
  assert.equal((await checking).errorCode, "CHECK_TIMEOUT");
  // Set the page's own clock relative to the actual serialized deadline. The
  // host mock clock only fires the outer timer and is not this realm's clock.
  const pageNow = queued.args[3] + 1 - f.context.performance.timeOrigin;
  f.context.performance.now = () => pageNow;
  assert.equal(f.context.performance.timeOrigin + f.context.performance.now(), queued.args[3] + 1);
  const late = await release();
  assert.equal(late[0].result.errorCode, "CHECK_TIMEOUT");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.fetches.length, 0);
});

test("a hanging unpacked diagnostic is capped so the actual check can still run", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
  const f = fixture(); let entered;
  const entry = new Promise(resolve => { entered = resolve; });
  f.api.declarativeNetRequest.testMatchOutcome = () => { entered(); return new Promise(() => {}); };
  const checking = f.check(f.prepared, 42);
  await entry; t.mock.timers.tick(701);
  const result = await checking;
  assert.equal(result.status, "match"); assert.equal(result.ruleMatches, null); assert.equal(result.ruleDiagnostic, "unknown");
  assert.equal(f.calls.fetches.length, 1);
});
