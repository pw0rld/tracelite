import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { normalOrigin, normalizeConfig } from "../extension/settings.js";
import { isRegionDocumentSender } from "../extension/regions.js";
import { summarizeState } from "../extension/status.js";
import { withTimeout } from "../extension/rpc.js";

const extensionSender = { id: "own", url: "chrome-extension://own/popup.html" };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function beforeDeadline(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} was blocked by the IP lookup`)), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture() {
  const source = (await readFile(new URL("../extension/background.js", import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "");
  const saved = { config: normalizeConfig() }, listeners = [], mutations = [], lookupArguments = [];
  const flags = { factories: 0, hold: false, finish: null, error: null, factoryError: null };
  const recommendation = Object.freeze({ countryCode: "US", timezone: "America/Chicago", profileId: "us-chicago" });
  const event = () => ({ addListener() {} });
  const regions = {
    async summary() { return { status: "off", errors: [] }; },
    async suspend() { mutations.push("region-pause"); },
    async resume() { mutations.push("region-resume"); },
    async handle(message) { mutations.push({ regionMutation: message.type }); return {}; }
  };
  const protection = {
    async status() { return { phase: "off", errors: [] }; },
    async reconcile(enabled) { mutations.push({ reconcile: enabled }); }
  };
  const chrome = {
    runtime: { id: "own", getURL: path => "chrome-extension://own/" + path,
      onMessage: { addListener(listener) { listeners.push(listener); } }, onInstalled: event(), onStartup: event() },
    tabs: { onUpdated: event(), onRemoved: event() },
    permissions: { onRemoved: event(), onAdded: event() },
    storage: { local: {
      async get(keys) {
        return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(saved[key])]));
      },
      async set(values) {
        mutations.push({ storageWrite: Object.keys(values) });
        Object.assign(saved, structuredClone(values));
      }
    } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} }
  };
  vm.runInNewContext(source, {
    createRegions: () => regions,
    createRequestProtection: () => protection,
    createSiteCleanup: () => ({}), createHeaderCheck: () => ({}),
    createRegionIpLookup(api) {
      assert.equal(api, chrome);
      flags.factories++;
      if (flags.factoryError) throw flags.factoryError;
      return { async lookup(...args) {
        lookupArguments.push(args);
        if (flags.error) throw flags.error;
        if (flags.hold) return new Promise(resolve => { flags.finish = () => resolve(recommendation); });
        return recommendation;
      } };
    },
    DEFINITIONS: [], normalizeConfig, normalOrigin, isRegionDocumentSender, summarizeState, withTimeout,
    applySettings: async () => { mutations.push("apply-settings"); return []; },
    applySiteRules: async () => { mutations.push("apply-sites"); return []; },
    readSiteSetting: async () => null, earlyStopTokens: () => [], chrome, console, URL
  });
  const send = message => new Promise(resolve => assert.equal(listeners[0](message, extensionSender, resolve), true));
  return { listener: listeners[0], send, saved, mutations, lookupArguments, flags, recommendation };
}

test("websites, content scripts and other extensions cannot trigger the IP recommendation", async () => {
  const f = await fixture();
  assert.equal(f.flags.factories, 0, "starting the background never starts an IP service");
  for (const sender of [
    { id: "own", url: "https://example.test/" },
    { id: "own", url: "https://example.test/", tab: { id: 4 }, frameId: 0, documentId: "document" },
    { id: "foreign", url: "chrome-extension://own/popup.html" },
    { id: "own", url: "chrome-extension://own.example/popup.html" }
  ]) assert.equal(f.listener({ type: "regionIpRecommend" }, sender, () => assert.fail("untrusted sender")), false);
  await tick();
  assert.equal(f.flags.factories, 0);
  assert.deepEqual(f.lookupArguments, []);
  assert.deepEqual(f.mutations, []);
});

test("the popup receives only the lookup service recommendation without applying caller fields", async () => {
  const f = await fixture();
  const before = structuredClone(f.saved);
  const response = await f.send({ type: "regionIpRecommend", url: "https://caller-selected.invalid/", ip: "203.0.113.7",
    tabId: 4, profileId: "us-en", apply: true, enabled: true });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true, data: f.recommendation });
  assert.equal(f.flags.factories, 1);
  assert.deepEqual(f.lookupArguments, [[]], "caller data cannot select a network endpoint or supply an IP");
  assert.deepEqual(f.saved, before);
  assert.deepEqual(f.mutations, [], "recommendation never saves or applies a profile");
  await f.send({ type: "regionIpRecommend" });
  assert.equal(f.flags.factories, 1, "subsequent explicit queries reuse the service instance");
  assert.equal(f.lookupArguments.length, 2);
});

test("a pending IP lookup cannot block status or global pause, and a late result cannot resume protection", async () => {
  const f = await fixture(); f.flags.hold = true;
  const lookup = f.send({ type: "regionIpRecommend" });
  await tick();
  assert.equal(typeof f.flags.finish, "function");
  let finished = false;
  lookup.then(() => { finished = true; });
  try {
    const status = await beforeDeadline(f.send({ type: "status" }), "status");
    assert.equal(status.ok, true);
    assert.equal(status.data.config.enabled, true);
    assert.deepEqual(f.mutations, [], "status remains read-only while lookup is pending");
    const pause = await beforeDeadline(f.send({ type: "enabled", value: false }), "global pause");
    assert.equal(pause.ok, true);
    assert.equal(f.saved.config.enabled, false);
    assert.ok(f.mutations.includes("region-pause"));
    assert.ok(f.mutations.some(item => item.reconcile === false));
    assert.equal(finished, false, "status and pause complete before the network query");
    const writesAfterPause = structuredClone(f.mutations);
    f.flags.finish();
    const result = await lookup;
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, f.recommendation);
    await tick();
    assert.deepEqual(f.mutations, writesAfterPause, "finishing the lookup makes no settings writes");
    assert.equal(f.saved.config.enabled, false);
    assert.ok(!f.mutations.includes("region-resume"));
  } finally { f.flags.finish(); await lookup; }
});

test("IP lookup errors are explicit responses and leave configuration unchanged", async t => {
  for (const failure of ["factoryError", "error"]) await t.test(failure, async () => {
    const f = await fixture(), before = structuredClone(f.saved);
    f.flags[failure] = new Error("IP 查询暂时不可用，请稍后重试。");
    const result = await f.send({ type: "regionIpRecommend" });
    assert.equal(result.ok, false);
    assert.equal(result.error, f.flags[failure].message);
    assert.deepEqual(f.saved, before);
    assert.deepEqual(f.mutations, []);
    assert.equal((await beforeDeadline(f.send({ type: "status" }), "status after lookup failure")).ok, true);
  });
});
