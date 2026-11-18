import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { normalOrigin, normalizeConfig } from "../extension/settings.js";
import { isRegionDocumentSender } from "../extension/regions.js";
import { summarizeState } from "../extension/status.js";
import { withTimeout } from "../extension/rpc.js";

async function fixture() {
  const source = (await readFile(new URL("../extension/background.js", import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "");
  const saved = { config: normalizeConfig() }, listeners = [], calls = [];
  const flags = { holdCleanup: false, finish: null };
  const event = () => ({ addListener() {} });
  const region = { summary: async () => ({ status: "off", errors: [] }),
    suspend: async () => calls.push("region-pause"), resume: async () => calls.push("region-resume") };
  const protection = { status: async () => ({ phase: "off", errors: [] }),
    reconcile: async enabled => calls.push({ reconcile: enabled }),
    configure: async (message, enabled) => calls.push({ configure: message, enabled }) };
  const cleanup = {
    async prepare(tabId, kind) { calls.push({ prepare: { tabId, kind } }); return { token: "prepared-token" }; },
    async start(token) {
      calls.push({ start: token });
      if (flags.holdCleanup) return new Promise(resolve => { flags.finish = () => resolve({ id: "job", state: "running" }); });
      return { id: "job", state: "running" };
    },
    async getStatus(id) { calls.push({ readJob: id }); return { id: "job", state: "running" }; }
  };
  const chrome = {
    runtime: { id: "own", getURL: path => "chrome-extension://own/" + path,
      onMessage: { addListener(fn) { listeners.push(fn); } }, onInstalled: event(), onStartup: event() },
    tabs: { onUpdated: event(), onRemoved: event(), async get(id) { return { id, url: "https://example.test/path?private=ignored" }; } },
    permissions: { onRemoved: event(), onAdded: event() },
    storage: { local: { async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map(key => [key, structuredClone(saved[key])]));
    }, async set(values) { Object.assign(saved, structuredClone(values)); } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} }
  };
  vm.runInNewContext(source, {
    createRegions: () => region, createHeaderCheck: () => ({}), createRequestProtection: () => protection,
    createSiteCleanup: () => cleanup, DEFINITIONS: [], normalizeConfig, normalOrigin, isRegionDocumentSender,
    summarizeState, withTimeout, applySettings: async () => [], applySiteRules: async () => [], readSiteSetting: async () => null,
    earlyStopTokens: () => [], chrome, console, URL
  });
  const sender = { id: "own", url: "chrome-extension://own/popup.html" };
  const send = message => new Promise(resolve => assert.equal(listeners[0](message, sender, resolve), true));
  return { listener: listeners[0], send, calls, flags, saved };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("sites cannot start, prepare or read cleanup jobs or change tracking protection", async () => {
  const f = await fixture();
  for (const type of ["cleanupPrepare", "cleanupStart", "cleanupStatus", "protectionConfigure", "protectionRetry"])
    for (const sender of [
      { id: "own", url: "https://example.test/" },
      { id: "own", url: "https://example.test/", tab: { id: 4 }, frameId: 0, documentId: "doc" },
      { id: "foreign", url: "chrome-extension://own/popup.html" }
    ]) assert.equal(f.listener({ type, tabId: 4 }, sender, () => assert.fail("untrusted sender")), false);
  await tick(); assert.deepEqual(f.calls, []);
});

test("cleanup uses only the prepared token and never accepts caller-supplied removal scope", async () => {
  const f = await fixture();
  await f.send({ type: "cleanupPrepare", tabId: 4, kind: "cache", origin: "https://ignored.test/" });
  await f.send({ type: "cleanupStart", token: "prepared-token", origins: ["<all_urls>"], kind: "data" });
  assert.deepEqual(f.calls, [{ prepare: { tabId: 4, kind: "cache" } }, { start: "prepared-token" }]);
});

test("a hanging cleanup response cannot block global pause and does not initiate any new cleanup", async () => {
  const f = await fixture(); f.flags.holdCleanup = true;
  const job = f.send({ type: "cleanupStart", token: "prepared-token" });
  await tick(); assert.equal(typeof f.flags.finish, "function");
  const pause = await f.send({ type: "enabled", value: false });
  assert.equal(pause.ok, true); assert.equal(f.saved.config.enabled, false);
  assert.ok(f.calls.includes("region-pause"));
  assert.ok(f.calls.some(item => item.reconcile === false));
  assert.equal(f.calls.filter(item => item.start).length, 1);
  f.flags.finish(); assert.equal((await job).ok, true);
});

test("the protection status derives its current site from Chrome tab metadata", async () => {
  const f = await fixture();
  const result = await f.send({ type: "protectionStatus", tabId: 4, origin: "https://forged.test" });
  assert.equal(result.ok, true); assert.equal(result.data.currentOrigin, "https://example.test");
  assert.equal(result.data.currentHostname, "example.test"); assert.equal(result.data.globalEnabled, true);
  assert.deepEqual(f.calls, [], "status never configures protection or starts cleanup");
});
