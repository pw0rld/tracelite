import test from "node:test";
import assert from "node:assert/strict";
import { createRequestProtection, normalizeRequestProtection } from "../extension/request-protection.js";
import { requestProtectionRules, CLEAN_LINK_REGEX, TRACKING_PARAMS, TRACKING_DOMAINS } from "../extension/tracking-rules.js";

function fixture(options = {}) {
  const data = { config: { enabled: true }, requestProtection: options.config };
  let rules = structuredClone(options.rules || [{ id: 7001, priority: 1, action: { type: "modifyHeaders" }, condition: {} }, { id: 9001, action: { type: "block" }, condition: {} }]);
  const calls = [];
  const flags = { hosts: options.hosts !== false, api: true, failUpdate: false, failAdd: false, ignoreUpdate: false, failRead: false };
  const api = {
    storage: { local: {
      async get(key) { return { [key]: structuredClone(data[key]) }; },
      async set(value) { Object.assign(data, structuredClone(value)); }
    } },
    permissions: { async contains(value) { return value.origins ? flags.hosts : flags.api; } },
    declarativeNetRequest: {
      async getDynamicRules() { if (flags.failRead) throw new Error("read failed"); return structuredClone(rules); },
      async updateDynamicRules(change) {
        calls.push(structuredClone(change));
        if (flags.failUpdate || flags.failAdd && change.addRules?.length) throw new Error("update failed");
        if (flags.ignoreUpdate) return;
        rules = [...rules.filter(rule => !change.removeRuleIds?.includes(rule.id)), ...structuredClone(change.addRules || [])];
      }
    }
  };
  return { data, flags, calls, api, module: createRequestProtection(api), rules: () => rules,
    replaceRules(value) { rules = structuredClone(value); } };
}

test("request features default off and status never writes network rules", async () => {
  const f = fixture(); const state = await f.module.status("https://example.com/");
  assert.equal(state.phase, "off"); assert.equal(state.active, false);
  assert.equal(state.config.trackers, false); assert.equal(state.config.links, false);
  assert.deepEqual(state.config.excludedDomains, []); assert.deepEqual(f.calls, []);
  assert.equal(state.domainCount, TRACKING_DOMAINS.length); assert.equal(state.paramCount, TRACKING_PARAMS.length);
});

test("config accepts only explicit booleans and web-domain exceptions", () => {
  const config = normalizeRequestProtection({ trackers: 1, links: true,
    excludedDomains: ["EXAMPLE.com", "example.com", "https://Sub.example.net:8443/path", "javascript:bad", "https://user:pass@example.org/"] });
  assert.equal(config.trackers, false); assert.equal(config.links, true);
  assert.deepEqual(config.excludedDomains, ["example.com", "sub.example.net"]);
});

test("two features install independently without touching region or unrelated rule IDs", async () => {
  const f = fixture(), unrelated = structuredClone(f.rules());
  let state = await f.module.configure({ feature: "trackers", value: true }, true);
  assert.equal(state.trackersActive, true); assert.equal(state.linksActive, false);
  assert.deepEqual(f.rules().filter(rule => rule.id < 8000 || rule.id >= 9000), unrelated);
  state = await f.module.configure({ feature: "links", value: true }, true);
  assert.equal(state.trackersActive, true); assert.equal(state.linksActive, true);
  assert.deepEqual(f.rules().filter(rule => rule.id < 8000 || rule.id >= 9000), unrelated);
  state = await f.module.configure({ feature: "trackers", value: false }, true);
  assert.equal(state.trackersActive, false); assert.equal(state.linksActive, true);
});

test("pause removes only owned rules, preserves choices and resumes them", async () => {
  const f = fixture(); await f.module.configure({ feature: "links", value: true }, true);
  f.data.config.enabled = false;
  let state = await f.module.reconcile(false);
  assert.equal(state.phase, "paused"); assert.equal(state.config.links, true);
  assert.deepEqual(f.rules().map(rule => rule.id), [7001, 9001]);
  f.data.config.enabled = true;
  state = await f.module.reconcile(true);
  assert.equal(state.linksActive, true); assert.ok(f.rules().some(rule => rule.id === 8100));
});

test("permissions are required before enabling and rejection cannot store enable intent", async () => {
  const f = fixture({ hosts: false });
  await assert.rejects(f.module.configure({ feature: "trackers", value: true }, true), /网站访问/);
  assert.equal((await f.module.status()).config.trackers, false); assert.equal(f.calls.length, 0);
});

test("host revocation cancels choices and a later regrant cannot automatically enable them", async () => {
  const f = fixture(); await f.module.configure({ feature: "trackers", value: true }, true);
  await f.module.configure({ feature: "links", value: true }, true);
  f.flags.hosts = false;
  let state = await f.module.permissionsChanged({ removed: true, origins: ["https://*/*"] }, true);
  assert.equal(state.config.trackers, false); assert.equal(state.config.links, false); assert.equal(state.active, false);
  assert.deepEqual(f.rules().map(rule => rule.id), [7001, 9001]);
  f.flags.hosts = true;
  state = await f.module.permissionsChanged({ removed: false, origins: ["https://*/*"] }, true);
  assert.equal(state.phase, "off"); assert.ok(state.notices.length); assert.equal(state.active, false);
});

test("all-urls host removal cancels enable intent rather than waiting for regrant", async () => {
  const f = fixture(); await f.module.configure({ feature: "links", value: true }, true);
  f.flags.hosts = false;
  const state = await f.module.permissionsChanged({ removed: true, origins: ["<all_urls>"] }, true);
  assert.equal(state.config.links, false); assert.equal(state.active, false);
  f.flags.hosts = true;
  assert.equal((await f.module.reconcile(true)).linksActive, false);
});

test("permission API failure remains unknown and cannot masquerade as confirmed host revocation", async () => {
  const f = fixture(); await f.module.configure({ feature: "links", value: true }, true);
  f.api.permissions.contains = async () => { throw new Error("permissions service unavailable"); };
  const state = await f.module.permissionsChanged({ removed: true, permissions: ["browsingData"] }, true);
  assert.equal(state.config.links, true); assert.equal(state.active, false);
  assert.equal(state.notices.length, 0); assert.ok(state.errors.length);
});

test("startup catches a missed host-removal event while unrelated browsingData removal leaves protection active", async () => {
  const f = fixture(); await f.module.configure({ feature: "trackers", value: true }, true);
  const unchanged = await f.module.permissionsChanged({ removed: true, permissions: ["browsingData"] }, true);
  assert.equal(unchanged.trackersActive, true);
  f.flags.hosts = false;
  assert.equal((await f.module.reconcile(true)).config.trackers, false);
  f.flags.hosts = true;
  assert.equal((await f.module.reconcile(true)).active, false);
});

test("domain exceptions cover both features and say that ports, schemes and subdomains share their scope", async () => {
  const f = fixture(); await f.module.configure({ feature: "trackers", value: true }, true);
  await f.module.configure({ feature: "links", value: true }, true);
  await f.module.configure({ origin: "https://EXAMPLE.com:8443/path", excluded: true }, true);
  const state = await f.module.status("http://child.example.com:8000/");
  assert.deepEqual(state.config.excludedDomains, ["example.com"]); assert.equal(state.siteExcluded, true);
  assert.equal(state.matchedExcludedDomain, "example.com"); assert.equal(state.exclusionScope, "domain-and-subdomains");
  assert.deepEqual(f.rules().find(rule => rule.id === 8000).condition.excludedInitiatorDomains, ["example.com"]);
  assert.deepEqual(f.rules().find(rule => rule.id === 8100).condition.excludedRequestDomains, ["example.com"]);
  assert.equal((await f.module.status("https://notexample.com")).siteExcluded, false);
  await assert.rejects(f.module.configure({ origin: "https://child.example.com", excluded: false }, true), /父域名/);
  await f.module.configure({ origin: "https://example.com", excluded: false }, true);
  assert.equal((await f.module.status("https://child.example.com")).siteExcluded, false);
});

test("bad operations and internal pages are rejected without changing config or rules", async () => {
  const f = fixture();
  for (const message of [{ feature: "ua", value: true }, { feature: "links", value: "yes" },
    { origin: "chrome://extensions/", excluded: true }, { origin: "file:///tmp/a", excluded: true },
    { origin: "https://user:pass@example.com/", excluded: true }]) await assert.rejects(f.module.configure(message, true));
  assert.equal(f.calls.length, 0); assert.equal((await f.module.status()).active, false);
});

test("installation failure attempts cleanup and never reports protection active", async () => {
  const f = fixture(); f.flags.failAdd = true;
  const state = await f.module.configure({ feature: "links", value: true }, true);
  assert.equal(state.active, false); assert.equal(state.phase, "error"); assert.match(state.errors.join(" "), /未完整应用/);
  assert.deepEqual(f.rules().map(rule => rule.id), [7001, 9001]);
  f.flags.failAdd = false;
  assert.equal((await f.module.reconcile(true)).active, true);
});

test("cleanup failure remains visible across controller restart and can be retried", async () => {
  const f = fixture(); await f.module.configure({ feature: "trackers", value: true }, true);
  f.flags.failUpdate = true; f.data.config.enabled = false;
  let state = await f.module.reconcile(false);
  assert.equal(state.phase, "cleanup"); assert.equal(state.cleanupPending, true); assert.equal(state.active, false);
  state = await createRequestProtection(f.api).status(); assert.equal(state.phase, "cleanup");
  f.flags.failUpdate = false;
  state = await createRequestProtection(f.api).reconcile(false);
  assert.equal(state.phase, "paused"); assert.equal(state.cleanupPending, false);
});

test("readback rejects ignored updates and same IDs with altered behavior", async () => {
  const f = fixture(); f.flags.ignoreUpdate = true;
  let state = await f.module.configure({ feature: "links", value: true }, true);
  assert.equal(state.active, false); assert.ok(state.errors.length);
  f.flags.ignoreUpdate = false; await f.module.reconcile(true);
  const rules = structuredClone(f.rules()); rules.find(rule => rule.id === 8100).condition.requestMethods = ["post"];
  f.replaceRules(rules); const before = f.calls.length;
  state = await f.module.status(); assert.equal(state.active, false); assert.equal(state.phase, "error");
  assert.equal(f.calls.length, before, "status must not silently repair or install");
});

test("readback accepts equivalent Chrome defaults and set ordering without rewriting rules", async () => {
  const f = fixture(); await f.module.configure({ feature: "trackers", value: true }, true);
  await f.module.configure({ feature: "links", value: true }, true);
  const rules = structuredClone(f.rules());
  for (const rule of rules.filter(rule => rule.id >= 8000 && rule.id < 9000)) {
    delete rule.priority;
    rule.condition.resourceTypes.reverse();
    if (rule.condition.requestDomains) rule.condition.requestDomains.reverse();
    if (rule.condition.isUrlFilterCaseSensitive === undefined) rule.condition.isUrlFilterCaseSensitive = false;
    rule.action.redirect?.transform?.queryTransform?.removeParams.reverse();
  }
  f.replaceRules(rules); const before = f.calls.length;
  assert.equal((await f.module.status()).phase, "active"); assert.equal(f.calls.length, before);
});

test("tracking baseline does not block first-party or main-frame navigation and never adds allow rules", () => {
  const rules = requestProtectionRules({ trackers: true, links: true, excludedDomains: [] });
  const block = rules.find(rule => rule.action.type === "block"), clean = rules.find(rule => rule.action.type === "redirect");
  assert.equal(block.condition.domainType, "thirdParty"); assert.ok(!block.condition.resourceTypes.includes("main_frame"));
  assert.deepEqual(clean.condition.resourceTypes, ["main_frame"]); assert.deepEqual(clean.condition.requestMethods, ["get"]);
  assert.equal(rules.some(rule => rule.action.type === "allow"), false, "no allow rule may suppress region header rule 7001");
});

test("cleaning grammar allows only explicit safe keys while queryTransform names only tracking keys", () => {
  const regex = new RegExp(CLEAN_LINK_REGEX);
  const inputs = ["https://example.com/?utm_source=mail", "http://example.com/article?q=hello&utm_medium=email&page=2#part", "https://example.com/path?fbclid=abc&gclid=def&q=a%26b", "https://example.com/?utm_source&utm_content="];
  for (const raw of inputs) {
    assert.equal(regex.test(raw), true, raw);
    const url = new URL(raw); for (const key of TRACKING_PARAMS) url.searchParams.delete(key);
    assert.ok(![...url.searchParams.keys()].some(key => TRACKING_PARAMS.includes(key)), url.href);
  }
  const transformed = new URL(inputs[1]); for (const key of TRACKING_PARAMS) transformed.searchParams.delete(key);
  assert.equal(transformed.searchParams.get("q"), "hello"); assert.equal(transformed.searchParams.get("page"), "2"); assert.equal(transformed.hash, "#part");
  for (const key of TRACKING_PARAMS) assert.equal(regex.test(`https://example.com/?${key}=value`), true, key);
});

test("OAuth, signed, unknown and case-variant queries are left untouched", () => {
  const regex = new RegExp(CLEAN_LINK_REGEX);
  assert.equal(regex.test("https://example.com/?q=hello"), true, "Chrome's native unchanged-URL guard must handle this no-op case in browser tests");
  for (const raw of ["https://example.com/", "https://example.com/?UTM_SOURCE=mail",
    "https://example.com/?utm_source=mail&state=xyz", "https://example.com/?code=xyz&utm_source=mail",
    "https://example.com/?nonce=xyz&gclid=x", "https://example.com/?signature=xyz&fbclid=x",
    "https://example.com/?token=xyz&fbclid=x", "https://example.com/?custom_business_key=1&utm_medium=email",
    "https://example.com/?utm_source=mail&X-Amz-Signature=xyz", "https://example.com/?utm_source=mail&payment_intent=xyz"])
    assert.equal(regex.test(raw), false, raw);
  const rule = requestProtectionRules({ links: true })[0];
  assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
});
