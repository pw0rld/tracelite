import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFINITIONS, normalizeConfig, normalOrigin, originPattern, readSetting, readSiteSetting, applySettings, applySiteRules } from "../extension/settings.js";

function mockChrome(overrides = {}) {
  const calls = [];
  const api = { runtime: { lastError: undefined }, privacy: { network: {}, websites: {} }, contentSettings: {} };
  for (const definition of DEFINITIONS) {
    let value = definition.value === false ? true : "default";
    let level = "controllable_by_this_extension";
    const override = overrides[definition.id] || {};
    if (override.absent) continue;
    if (Object.hasOwn(override, "value")) value = override.value;
    if (override.level) level = override.level;
    const initialValue = value;
    api.privacy[definition.section][definition.key] = {
      get(options, done) { if (options.incognito) calls.push({ id: definition.id, method: "get", ...options }); done({ value, levelOfControl: level }); },
      set(options, done) {
        calls.push({ id: definition.id, method: "set", ...options });
        if (override.fail) { api.runtime.lastError = { message: "Mock set failed" }; done(); api.runtime.lastError = undefined; return; }
        if (!override.ignoreSet) { value = options.value; level = "controlled_by_this_extension"; }
        done();
      },
      clear(options, done) {
        calls.push({ id: definition.id, method: "clear", ...options });
        if (override.failClear) { api.runtime.lastError = { message: "Mock clear failed" }; done(); api.runtime.lastError = undefined; return; }
        value = initialValue; level = override.level || "controllable_by_this_extension"; done();
      }
    };
  }
  let siteRules = [];
  api.contentSettings.javascript = {
    clear(options, done) { siteRules = []; calls.push({ id: "javascript", method: "clear", ...options }); done(); },
    set(options, done) { siteRules.push(options); calls.push({ id: "javascript", method: "set", ...options }); done(); },
    get(options, done) { calls.push({ id: "javascript", method: "get", ...options }); done({ setting: "allow" }); }
  };
  return { api, calls, getSiteRules: () => siteRules };
}

test("fresh install chooses all supported controls; no fake fingerprint options", () => {
  const config = normalizeConfig();
  assert.equal(config.enabled, true);
  assert.equal(Object.values(config.selected).every(Boolean), true);
  assert.equal(Object.keys(config.selected).length, 7);
  assert.deepEqual(config.blockedOrigins, []);
});

test("normalizes origin allowlist and rejects non-web origins/credentials", () => {
  const config = normalizeConfig({ enabled: false, selected: { webrtc: false }, blockedOrigins: ["https://EXAMPLE.com/path?a=secret", "https://example.com/", "file:///etc/passwd", "chrome://settings", "http://user:pass@example.com"] });
  assert.deepEqual(config.blockedOrigins, ["https://example.com"]);
  assert.equal(config.enabled, false);
  assert.equal(config.selected.webrtc, false);
  assert.equal(config.selected.cookies, true);
  assert.equal(normalOrigin("javascript:alert(1)"), null);
  assert.equal(originPattern("https://example.com:8443/path"), "https://example.com:8443/*");
  assert.equal(originPattern("https://example.com/path"), "https://example.com:443/*");
  assert.equal(originPattern("http://example.com/path"), "http://example.com:80/*");
});

test("apply then verify all defaults using regular scope", async () => {
  const { api, calls } = mockChrome();
  const rows = await applySettings(api, normalizeConfig());
  assert.equal(rows.every(row => row.status === "active"), true);
  assert.equal(calls.length, 7);
  assert.ok(calls.every(call => call.method === "set" && call.scope === "regular"));
  assert.ok(calls.every(call => call.value !== true));
});

test("policy and other-extension conflicts are not falsely reported as applied", async () => {
  const { api, calls } = mockChrome({ webrtc: { level: "controlled_by_other_extensions" }, cookies: { level: "not_controllable" }, topics: { absent: true }, audience: { ignoreSet: true } });
  const rows = await applySettings(api, normalizeConfig());
  const states = Object.fromEntries(rows.map(row => [row.id, row.status]));
  assert.equal(states.webrtc, "blocked");
  assert.equal(states.cookies, "blocked");
  assert.equal(states.topics, "unsupported");
  assert.equal(states.audience, "inactive");
  assert.ok(!calls.some(call => ["webrtc", "cookies", "topics"].includes(call.id)));
});

test("effective settings controlled externally remain labelled external", async () => {
  const { api } = mockChrome({ webrtc: { level: "controlled_by_other_extensions", value: "disable_non_proxied_udp" } });
  const rows = await applySettings(api, normalizeConfig());
  assert.equal(rows[0].status, "external");
});

test("API failures are surfaced with no success claim", async () => {
  const { api } = mockChrome({ prediction: { fail: true } });
  const rows = await applySettings(api, normalizeConfig());
  const row = rows.find(row => row.id === "prediction");
  assert.equal(row.status, "error");
  assert.match(row.error, /Mock set failed/);
});

test("pause releases rather than force-enables the browser's previous settings", async () => {
  const { api, calls } = mockChrome({ topics: { value: false } });
  await applySettings(api, normalizeConfig());
  calls.length = 0;
  const rows = await applySettings(api, normalizeConfig({ enabled: false }));
  assert.ok(calls.every(call => call.method === "clear"));
  assert.ok(rows.every(row => row.status === "released"));
  assert.equal(rows.find(row => row.id === "topics").effective, false);
});

test("deselecting only one control releases only that override", async () => {
  const { api, calls } = mockChrome();
  await applySettings(api, normalizeConfig({ selected: { topics: false } }));
  assert.deepEqual(calls.filter(call => call.method === "clear").map(call => call.id), ["topics"]);
});

test("site blocks use exact origin, pause clears and resume restores saved list", async () => {
  const { api, getSiteRules } = mockChrome();
  const config = normalizeConfig({ blockedOrigins: ["https://example.com/a", "http://example.net:8000"] });
  assert.deepEqual(await applySiteRules(api, config), []);
  assert.deepEqual(getSiteRules().map(rule => rule.primaryPattern), ["https://example.com:443/*", "http://example.net:8000/*"]);
  await applySiteRules(api, { ...config, enabled: false });
  assert.deepEqual(getSiteRules(), []);
  await applySiteRules(api, config);
  assert.equal(getSiteRules().length, 2);
});

test("unchanged site list leaves rules intact; additions are incremental", async () => {
  const { api, calls } = mockChrome();
  const config = normalizeConfig({ blockedOrigins: ["https://example.com"] });
  await applySiteRules(api, config, config);
  assert.deepEqual(calls, []);
  const added = normalizeConfig({ blockedOrigins: ["https://example.com", "https://example.org"] });
  await applySiteRules(api, added, config);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "set");
  assert.equal(calls[0].primaryPattern, "https://example.org:443/*");
});

test("failed release is not reported as released", async () => {
  const { api } = mockChrome({ webrtc: { failClear: true } });
  await applySettings(api, normalizeConfig());
  const rows = await applySettings(api, normalizeConfig({ enabled: false }));
  assert.equal(rows[0].status, "error");
  assert.match(rows[0].error, /clear failed/);
});

test("incognito status queries pass the mode to both APIs", async () => {
  const { api, calls } = mockChrome();
  await readSetting(api, DEFINITIONS[0], normalizeConfig(), null, true);
  await readSiteSetting(api, "https://example.com", true);
  assert.equal(calls.filter(call => call.method === "get" && call.incognito).length, 2);
});

test("manifest keeps website access optional and scripting available for cleanup", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.slice().sort(), ["activeTab", "contentSettings", "declarativeNetRequestWithHostAccess", "privacy", "scripting", "storage"]);
  assert.deepEqual(manifest.optional_permissions.slice().sort(), ["browsingData", "tabs"]);
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
});
