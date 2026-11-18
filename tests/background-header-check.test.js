import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { isRegionDocumentSender } from "../extension/regions.js";

async function fixture() {
  const source = (await readFile(new URL("../extension/background.js", import.meta.url), "utf8"))
    .replace(/^import .*;\n/gm, "");
  const calls = [], listeners = [];
  const flags = { changed: false, finish: null };
  const event = () => ({ addListener() {} });
  const prepared = { lifecycle: { revision: 1 }, enabled: true };
  const regions = {
    async prepareStatus() { return prepared; },
    async readStatus(value) { return value; },
    async statusChanged() { return flags.changed; },
    unmeasuredStatus(value) { return value; },
    async documentRequest() { calls.push("document"); return { applied: false }; },
    async summary() { return {}; }
  };
  vm.runInNewContext(source, {
    createRegions: () => regions,
    createRequestProtection: () => ({ status: async () => ({ phase: "off", errors: [] }) }),
    createSiteCleanup: () => ({}),
    createHeaderCheck: () => ({ check(value, tabId) {
      calls.push({ prepared: value, tabId });
      return new Promise(resolve => { flags.finish = () => resolve({ status: "match", receivedHeader: "en-US,en;q=0.9" }); });
    } }),
    DEFINITIONS: [], isRegionDocumentSender, earlyStopTokens: () => [], console,
    chrome: {
      runtime: { id: "own", getURL: path => "chrome-extension://own/" + path,
        onMessage: { addListener(listener) { listeners.push(listener); } },
        onInstalled: event(), onStartup: event() },
      tabs: { onUpdated: event(), onRemoved: event() },
      permissions: { onRemoved: event(), onAdded: event() }
    }
  });
  return { listener: listeners[0], calls, flags };
}
const extensionSender = { id: "own", url: "chrome-extension://own/popup.html" };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("websites and other extensions cannot trigger a language-header network check", async () => {
  const f = await fixture();
  for (const sender of [
    { id: "own", url: "https://who.1ms.dog/zh-cn/" },
    { id: "own", url: "https://who.1ms.dog/zh-cn/", tab: { id: 4 }, frameId: 0, documentId: "doc" },
    { id: "other", url: "chrome-extension://own/popup.html" },
    { id: "own", url: "chrome-extension://own.example/popup.html" }
  ]) assert.equal(f.listener({ type: "regionHeaderCheck", tabId: 4 }, sender, () => assert.fail("must not respond")), false);
  await tick(); assert.deepEqual(f.calls, []);
});

test("a pending header check does not block status and a changed region cannot return success", async () => {
  const f = await fixture();
  const response = new Promise(resolve => {
    assert.equal(f.listener({ type: "regionHeaderCheck", tabId: 4 }, extensionSender, resolve), true);
  });
  await tick(); assert.equal(f.calls[0].tabId, 4);
  const status = await new Promise(resolve => {
    assert.equal(f.listener({ type: "regionStatus", tabId: 4 }, extensionSender, resolve), true);
  });
  assert.equal(status.ok, true);
  f.flags.changed = true; f.flags.finish();
  const result = await response;
  assert.equal(result.ok, true); assert.equal(result.data.status, "unknown");
  assert.equal(result.data.stale, true); assert.match(result.data.error, /设置已变化/);
});
