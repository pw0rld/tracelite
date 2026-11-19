import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createRegions, readEarlyDocument } from "../extension/regions.js";
import { EARLY_PROFILES, earlyControlEvent } from "../extension/region-early.js";

function fixture(options = {}) {
  const data = { config: { enabled: options.enabled !== false }, regions: { custom: [], defaultProfileId: null } };
  const session = {};
  const permissions = new Set(["scripting", ...(options.permission === false ? [] : ["tabs", "declarativeNetRequestWithHostAccess"])]);
  let hosts = options.permission !== false, scripts = [], rules = structuredClone(options.rules || []), executions = [], reloads = [];
  const notifications = [], notificationStates = [], operations = [];
  const flags = { failRules: false, failRegister: false, failCleanup: false, staleDocument: false, failNotify: false, holdNotify: false, failEarly: false, holdEarly: false, scriptUnavailable: false, onNotify: null };
  const storage = data => ({
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(next) { Object.assign(data, structuredClone(next)); }
  });
  const api = {
    runtime: { id: "own-extension" },
    storage: { local: storage(data), session: storage(session) },
    permissions: { async contains(request) {
      return (request.permissions || []).every(p => permissions.has(p)) && (!(request.origins || []).length || hosts);
    } },
    declarativeNetRequest: {
      async getDynamicRules() { return structuredClone(rules); },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        operations.push({ type: "headers", add: addRules.length });
        if (flags.failRules && addRules.length || flags.failCleanup && !addRules.length) throw new Error("rules denied");
        rules = [...rules.filter(rule => !removeRuleIds.includes(rule.id)), ...structuredClone(addRules)];
      }
    },
    tabs: {
      async sendMessage(tabId, message, target) {
        operations.push({ type: "notify", documentId: target.documentId });
        notifications.push({ tabId, message, target });
        notificationStates.push(structuredClone(data.regionRuntime));
        flags.onNotify?.();
        if (flags.failNotify) throw new Error("Receiving document is gone");
        if (flags.holdNotify) return new Promise(() => {});
      },
      async reload(id) { reloads.push(id); },
      async get(id) { return { id, url: "https://example.com/", title: "Page " + id }; },
      async query() { return [{ id: 4, url: "https://example.com", title: "Page 4" }]; }
    },
    scripting: {
      async getRegisteredContentScripts({ ids } = {}) {
        if (!permissions.has("scripting") || flags.scriptUnavailable) throw new Error("scripting unavailable");
        return structuredClone(ids ? scripts.filter(script => ids.includes(script.id)) : scripts);
      },
      async registerContentScripts(values) {
        if (!permissions.has("scripting") || flags.scriptUnavailable) throw new Error("scripting unavailable");
        operations.push({ type: "register", ids: values.map(script => script.id) });
        if (flags.failRegister) throw new Error("registration failed");
        scripts = structuredClone(values);
      },
      async unregisterContentScripts({ ids } = {}) {
        if (!permissions.has("scripting") || flags.scriptUnavailable || flags.failCleanup) throw new Error("cleanup blocked");
        if (!scripts.length) throw new Error("Nonexistent content script ID");
        operations.push({ type: "unregister", ids });
        scripts = ids ? scripts.filter(script => !ids.includes(script.id)) : [];
      },
      async executeScript(injection) {
        if (!permissions.has("scripting") || flags.scriptUnavailable) throw new Error("scripting unavailable");
        if (!injection.target.documentIds) return [{ result: { timezone: "Asia/Tokyo", locale: "ja-JP", language: "ja-JP", languages: ["ja-JP", "ja"] } }];
        executions.push(injection);
        if (flags.staleDocument) throw new Error("No such document");
        if (flags.holdEarly && injection.func === readEarlyDocument) return new Promise(() => {});
        return [{ documentId: injection.target.documentIds[0], result: {
          applied: !flags.failEarly, changed: true, timeOrigin: 12345,
          ...(flags.failEarly ? { error: "Date 与 Intl 不一致" } : {})
        } }];
      }
    }
  };
  return { api, data, session, permissions, flags, setHosts: v => { hosts = v; },
    inspect: () => ({ scripts, rules, executions, reloads, notifications, notificationStates, operations }) };
}
const sender = (id = "doc-1") => ({ id: "own-extension", tab: { id: 4, title: "Page" }, frameId: 0, documentId: id, url: "https://example.com/" });
const apply = region => region.handle({ type: "regionApply", profileId: "jp", tabId: 4 });

test("a busy page's early readback is bounded and retains the token needed to stop its hooks", async () => {
  const f = fixture(), region = createRegions(f.api);
  await apply(region); f.flags.holdEarly = true;
  const started = Date.now();
  const result = await region.documentRequest({ type: "regionDocument", protocol: 2,
    generation: f.data.regionRuntime.generation, timeOrigin: 12345 }, sender());
  assert.equal(result.applied, false);
  assert.ok(Date.now() - started < 2000);
  assert.equal(f.session.regionDocuments.applied['doc-1'].verified, false);
  assert.equal(f.session.regionDocuments.applied['doc-1'].controlEvent, earlyControlEvent('jp',12345));
  assert.ok(f.session.regionDocuments.refresh[4]);
  await region.suspend();
  assert.deepEqual(f.inspect().scripts, []);
  assert.ok(f.inspect().notifications.some(item => item.target.documentId === 'doc-1'));
});

test("a document not yet recorded receives every early stop token when pause wins the handshake", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const generation = f.data.regionRuntime.generation;
  await region.suspend();
  assert.equal(f.session.regionDocuments.applied['unrecorded'], undefined);
  for (const message of [{type:'regionBootstrap'},{type:'regionDocument',generation}]) {
    const response = await region.documentRequest({...message,protocol:2,timeOrigin:12345},sender('unrecorded'));
    assert.equal(response.applied,false);
    assert.deepEqual(response.stopEarlyTokens,EARLY_PROFILES.map(({key})=>earlyControlEvent(key,12345)));
  }
  assert.equal(f.inspect().executions.length,0);
});

test("the isolated handshake dispatches bounded stop tokens on either refused stage", async () => {
  const source = await readFile(new URL('../extension/region-bootstrap.js',import.meta.url),'utf8');
  const tokens=EARLY_PROFILES.map(({key})=>earlyControlEvent(key,12345));
  for (const refuseFirst of [true,false]) {
    const events=[],requests=[];
    vm.runInNewContext(source,{
      chrome:{runtime:{id:'own-extension',onMessage:{addListener(){}},sendMessage:async message=>{
        requests.push(message);
        return !refuseFirst&&requests.length===1 ? {generation:3} : {applied:false,stopEarlyTokens:[...tokens,'click',null]};
      }}},
      window:{addEventListener(){},dispatchEvent:event=>events.push(event.type)},Event,performance:{timeOrigin:12345}
    });
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(events,tokens);
    assert.equal(requests.length,refuseFirst?1:2);
    assert.ok(requests.every(request=>request.timeOrigin===12345));
  }
});

test("fresh install and legacy upgrade keep region requested off", async () => {
  const f = fixture({ permission: false }), region = createRegions(f.api);
  const fresh = await region.summary();
  assert.equal(fresh.requested, false); assert.equal(fresh.status, "off");
  await region.suspend(); assert.equal((await region.summary()).status, "off");
  assert.deepEqual(f.inspect().scripts, []);
  const old = fixture(); old.data.regions.defaultProfileId = "jp";
  const legacy = createRegions(old.api);
  const migrated = await legacy.summary();
  assert.equal(migrated.requested, false); assert.equal(migrated.selectedProfileId, "jp");
  assert.equal(migrated.needsRefresh, 1); assert.deepEqual(old.inspect().scripts, []);
});

test("schema-one enabled, paused and revoked states migrate without silently installing", async t => {
  const cases = [
    { name: "enabled", enabled: true, requested: true, phase: "active", reason: null },
    { name: "paused", enabled: false, requested: true, phase: "paused", reason: "paused" },
    { name: "revoked", enabled: true, requested: false, phase: "off", reason: "permission-revoked" }
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const f = fixture({ enabled: scenario.enabled, rules: [{ id: 7001 }, { id: 9000 }] });
    f.data.regions.defaultProfileId = "jp";
    f.data.regionRuntime = { schema: 1, requested: scenario.requested, phase: scenario.phase,
      reason: scenario.reason, generation: 8, revision: 6,
      cleanupPending: { scripts: true, headers: true }, errors: ["old cleanup message"] };
    const region = createRegions(f.api);
    const migrated = await region.summary();
    assert.equal(f.data.regionRuntime.schema, 2);
    assert.equal(f.data.regionRuntime.generation, 9, "old document authorizations are invalidated");
    assert.equal(f.data.regionRuntime.revision, 7);
    assert.equal(migrated.requested, scenario.requested, "migration preserves the user's intent");
    assert.equal(migrated.active, false);
    assert.equal(migrated.selectedProfileId, "jp");
    assert.equal(migrated.needsRefresh, 1);
    assert.deepEqual(migrated.cleanupPending, { scripts: false, headers: false });
    assert.deepEqual(f.inspect().scripts, [], "reading migrated state does not install scripts");
    assert.deepEqual(f.inspect().rules, [{ id: 9000 }], "only the legacy language rule is removed");
    assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 1, generation: 8 }, sender()), { applied: false });
    assert.deepEqual(await region.documentRequest({ type: "regionBootstrap", protocol: 2 }, sender()), { applied: false });
    await region.summary();
    assert.deepEqual(f.inspect().scripts, [], "repeated startup reconciliation stays passive");
    f.data.config.enabled = true;
    const resumed = await region.resume();
    assert.equal(resumed.active, scenario.requested);
    assert.equal(f.inspect().scripts.length, scenario.requested ? 2 : 0);
    if (!scenario.requested) {
      assert.deepEqual(f.inspect().rules, [{ id: 9000 }]);
      assert.ok(resumed.notices.length, "revocation remains a notice after migration");
    }
  });
});

test("schema-one permission-revoked intent is not revived by migration", async () => {
  const f = fixture({ rules: [{ id: 7001 }] });
  f.data.regions.defaultProfileId = "jp";
  f.data.regionRuntime = { schema: 1, requested: true, phase: "active", reason: "permission-revoked",
    generation: 2, revision: 3, cleanupPending: { scripts: true, headers: true } };
  const region = createRegions(f.api);
  assert.equal((await region.summary()).requested, false);
  assert.equal((await region.resume()).active, false);
  assert.deepEqual(f.inspect().rules, []); assert.deepEqual(f.inspect().scripts, []);
});

test("ordinary content-script lifecycle works without a userScripts namespace", async () => {
  const f = fixture(), region = createRegions(f.api);
  assert.equal("userScripts" in f.api, false);
  await apply(region);
  const grant = await region.documentRequest({ type: "regionBootstrap", protocol: 2 }, sender());
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation: grant.generation }, sender()), { applied: true });
  await region.handle({ type: "regionStop" });
  assert.deepEqual(f.inspect().scripts, []); assert.deepEqual(f.inspect().rules, []);
  assert.equal((await region.summary()).active, false);
});

test("same-valued language rules with different behavior are inactive until explicitly reapplied", async t => {
  const cases = [
    ["different header", rule => { rule.action.requestHeaders[0].header = "x-language"; }],
    ["append instead of set", rule => { rule.action.requestHeaders[0].operation = "append"; }],
    ["HTTP-only scope", rule => { rule.condition.regexFilter = "^http://"; }],
    ["missing fetch coverage", rule => { rule.condition.resourceTypes = rule.condition.resourceTypes.filter(type => type !== "xmlhttprequest"); }],
    ["extra domain constraint", rule => { rule.condition.requestDomains = ["example.com"]; }],
    ["case-sensitive filter", rule => { rule.condition.isUrlFilterCaseSensitive = true; }],
    ["different priority", rule => { rule.priority = 2; }],
    ["extra response modification", rule => { rule.action.responseHeaders = [{ header: "x-language", operation: "set", value: "ja-JP" }]; }]
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = fixture(), region = createRegions(f.api); await apply(region);
    const expected = structuredClone(f.inspect().rules[0]);
    mutate(f.inspect().rules[0]);
    assert.equal(f.inspect().rules[0].action.requestHeaders[0].value, expected.action.requestHeaders[0].value);
    const operations = f.inspect().operations.length;
    const status = await region.summary();
    assert.equal(status.active, false);
    assert.equal(status.status, "error");
    assert.equal(f.inspect().operations.length, operations, "status reads never repair mismatched rules silently");
    const repaired = await apply(region);
    assert.equal(repaired.lifecycle.active, true);
    assert.deepEqual(f.inspect().rules, [expected]);
    assert.equal((await region.summary()).active, true);
  });
});

test("language rule verification accepts equivalent Chrome defaults and resource-type ordering", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const rule = f.inspect().rules[0];
  delete rule.priority; // The documented default is 1.
  rule.condition.isUrlFilterCaseSensitive = false;
  rule.condition.resourceTypes.reverse();
  rule.action.requestHeaders[0].header = "Accept-Language";
  rule.action = { requestHeaders: rule.action.requestHeaders, type: rule.action.type };
  const operations = f.inspect().operations.length;
  assert.equal((await region.summary()).active, true);
  assert.equal(f.inspect().operations.length, operations);
});

test("built-in presets register early MAIN code and exact-document messages only verify it", async () => {
  const f = fixture(), region = createRegions(f.api);
  const state = await apply(region);
  assert.equal(state.lifecycle.active, true);
  const script = f.inspect().scripts[0];
  assert.equal(script.runAt, "document_start"); assert.equal(script.world, "ISOLATED");
  assert.deepEqual(script.js, ["region-bootstrap.js"]);
  assert.equal(script.persistAcrossSessions, false);
  const early = f.inspect().scripts.find(script => script.world === "MAIN");
  assert.ok(early); assert.equal(early.runAt, "document_start");
  assert.equal(early.persistAcrossSessions, false); assert.deepEqual(early.js, ["early/jp.js"]);
  const headerIndex = f.inspect().operations.findIndex(operation => operation.type === "headers" && operation.add);
  assert.ok(headerIndex >= 0 && headerIndex < f.inspect().operations.findIndex(operation => operation.type === "register"), "headers precede early script registration");
  const generation = f.data.regionRuntime.generation;
  const grant = await region.documentRequest({ type: "regionBootstrap", protocol: 2 }, sender());
  assert.deepEqual(grant, { generation });
  assert.equal(f.inspect().executions.length, 0, "stage one only authorizes, without patching the page");
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation: grant.generation }, sender()), { applied: true });
  assert.deepEqual(f.inspect().executions[0].target, { tabId: 4, documentIds: ["doc-1"] });
  assert.equal(f.inspect().executions[0].world, "MAIN");
  assert.equal(f.inspect().executions[0].injectImmediately, true);
  assert.equal(f.inspect().executions[0].func, readEarlyDocument, "verification cannot perform a late patch");
  assert.equal(f.inspect().executions[0].args.length, 1);
  const controlEvent = earlyControlEvent("jp", 12345);
  assert.match(controlEvent, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
  assert.equal(f.session.regionDocuments.applied["doc-1"].controlEvent, controlEvent);
  assert.equal(f.inspect().rules[0].action.requestHeaders[0].value, "ja-JP,ja;q=0.9");
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation }, sender());
  assert.equal(f.inspect().executions.length, 1, "one injection per document");
});

test("document authorization rejects untrusted, stale and replaced documents", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const generation = f.data.regionRuntime.generation;
  for (const bad of [{ ...sender(), id: "other-extension" }, { ...sender(), url: "chrome://settings" }, { ...sender(), documentId: undefined }]) {
    assert.deepEqual(await region.documentRequest({ type: "regionBootstrap", protocol: 2 }, bad), { applied: false });
    assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation }, bad), { applied: false });
    assert.deepEqual(await region.documentRequest({ type: "regionRecheckDocument", protocol: 2 }, bad), { applied: false });
  }
  for (const protocol of [undefined, 1, "2"]) {
    assert.deepEqual(await region.documentRequest({ type: "regionBootstrap", protocol }, sender()), { applied: false });
    assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol, generation }, sender()), { applied: false });
  }
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2 }, sender()), { applied: false });
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation: generation - 1 }, sender()), { applied: false });
  f.flags.staleDocument = true;
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation }, sender()), { applied: false });
  assert.equal(f.inspect().executions.length, 1);
  assert.deepEqual(f.inspect().executions[0].target.documentIds, ["doc-1"]);
});

test("custom profiles retain the authorized asynchronous path without an early MAIN registration", async () => {
  const f = fixture(), region = createRegions(f.api);
  const saved = await region.handle({ type: "regionSave", profile: { name: "London", timezone: "Europe/London", locale: "en-GB", languages: ["en-GB", "en"] } });
  const id = saved.profiles.find(profile => profile.name === "London").id;
  const status = await region.handle({ type: "regionApply", profileId: id, tabId: 4 });
  assert.equal(status.lifecycle.timing, "after_authorization");
  assert.equal(f.inspect().scripts.length, 1);
  assert.equal(f.inspect().scripts[0].world, "ISOLATED");
  const result = await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
  assert.deepEqual(result, { applied: true });
  assert.equal(f.inspect().executions[0].func.name, "applyPageContext");
  const token = f.inspect().executions[0].args[1];
  assert.match(token, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  assert.equal(f.session.regionDocuments.applied["doc-1"].controlEvent, token);
});

test("failed early verification stays failed and requests refresh instead of patching late", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  f.flags.failEarly = true;
  const generation = f.data.regionRuntime.generation;
  const result = await region.documentRequest({ type: "regionDocument", protocol: 2, generation, timeOrigin: 67890 }, sender());
  assert.equal(result.applied, false); assert.equal(result.reloadRequired, true); assert.match(result.error, /Date/);
  assert.equal(f.inspect().executions[0].func, readEarlyDocument);
  assert.equal(f.session.regionDocuments.applied["doc-1"].controlEvent, earlyControlEvent("jp", 67890));
  assert.equal(f.session.regionDocuments.applied["doc-1"].verified, false);
  await region.tabChanged(4, { status: "complete" }, { url: "https://example.com" }, "doc-1");
  assert.equal((await region.summary()).needsRefresh, 1);
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation }, sender()), { applied: false, reloadRequired: true });
  assert.equal(f.inspect().executions.length, 1, "failed startup never falls back to a late patch");
  await region.suspend();
  assert.equal(f.inspect().notifications.length, 1, "even a partially modified early document can be stopped");
});

test("cleanup removes both owned registrations while leaving unrelated scripts alone", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  f.inspect().scripts.push({ id: "unrelated-feature", world: "ISOLATED" });
  await region.handle({ type: "regionStop" });
  assert.deepEqual(f.inspect().scripts, [{ id: "unrelated-feature", world: "ISOLATED" }]);
  assert.deepEqual(f.inspect().operations.find(operation => operation.type === "unregister").ids.sort(), ["privacy-guard-bootstrap-v2", "privacy-guard-early-v1"].sort());
});

test("stage-two authorization rejects a grant issued before pause and resume", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const previous = await region.documentRequest({ type: "regionBootstrap", protocol: 2 }, sender());
  f.data.config.enabled = false; await region.suspend();
  assert.deepEqual(await region.documentRequest({ type: "regionBootstrap", protocol: 2 }, sender()), { applied: false });
  f.data.config.enabled = true; await region.resume();
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation: previous.generation }, sender()), { applied: false });
  assert.equal(f.inspect().executions.length, 0);
  const current = await region.documentRequest({ type: "regionBootstrap", protocol: 2 }, sender());
  assert.ok(current.generation > previous.generation);
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation: current.generation }, sender()), { applied: true });
});

test("a mismatched execution result never authorizes or records another document", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  f.api.scripting.executeScript = async () => [{ documentId: "replacement", result: { applied: true } }];
  const result = await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
  assert.deepEqual(result, { applied: false });
  assert.equal(f.session.regionDocuments?.applied?.["doc-1"], undefined);
});

test("readback timeout preserves usable profiles and lifecycle state", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  f.api.scripting.executeScript = () => new Promise(() => {});
  const result = await region.readStatus(await region.prepareStatus(), 4);
  assert.ok(result.profiles.length);
  assert.equal(result.lifecycle.active, true);
  assert.equal(result.current.live, null);
  assert.match(result.readError, /超时/);
  assert.equal(result.stale, false);
});

test("a pending readback identifies a concurrently stopped region as stale", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const prepared = await region.prepareStatus();
  let finish, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.api.scripting.executeScript = () => { started(); return new Promise(resolve => { finish = resolve; }); };
  const reading = region.readStatus(prepared, 4); await entered;
  await region.handle({ type: "regionStop" });
  finish([{ result: { timezone: "Asia/Tokyo" } }]);
  assert.equal((await reading).stale, true);
  const fresh = region.unmeasuredStatus(await region.prepareStatus());
  assert.equal(fresh.lifecycle.active, false);
  assert.equal(fresh.current, null);
});

test("pause saves selection, cancels future patching and resumes only requested profile", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const oldGeneration = f.data.regionRuntime.generation;
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation: oldGeneration }, sender());
  f.data.config.enabled = false; await region.suspend();
  const paused = await region.summary();
  assert.equal(paused.status, "paused"); assert.equal(paused.requested, true); assert.equal(paused.active, false);
  assert.equal(paused.selectedProfileId, "jp"); assert.equal(paused.needsRefresh, 1);
  assert.deepEqual(f.inspect().notifications, [{ tabId: 4,
    message: { type: "regionStopPropagation", controlEvent: f.session.regionDocuments.applied["doc-1"].controlEvent },
    target: { documentId: "doc-1" } }]);
  assert.equal(f.inspect().notificationStates[0].phase, "paused", "authorization is revoked before notification");
  assert.deepEqual(f.inspect().notificationStates[0].cleanupPending, { scripts: false, headers: false }, "future registrations and headers are removed before notifying pages");
  assert.ok(f.inspect().notificationStates[0].generation > oldGeneration);
  assert.deepEqual(f.inspect().scripts, []); assert.deepEqual(f.inspect().rules, []);
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation: oldGeneration }, sender("old-doc")), { applied: false });
  f.data.config.enabled = true; await region.resume();
  assert.equal((await region.summary()).active, true);
  assert.deepEqual((await region.summary()).cleanupPending, { scripts: false, headers: false });
});

test("host permission removal cleans early registrations and stops existing context hooks", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
  f.setHosts(false);
  const revoked = await region.permissionsChanged({ removed: true, origins: ["https://*/*", "http://*/*"] });
  assert.equal(f.inspect().notifications.length, 1);
  assert.equal(f.inspect().notifications[0].target.documentId, "doc-1");
  assert.equal(f.inspect().notificationStates[0].requested, false);
  assert.equal(revoked.requested, false);
  assert.equal(revoked.needsRefresh, 1);
  assert.equal(revoked.cleanupPending.scripts, false);
  assert.deepEqual(f.inspect().scripts, [], "required scripting remains available to unregister after host access is revoked");
});

test("removing optional request-rule permission still unregisters MAIN and cannot auto-resume on regrant", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  f.permissions.delete("declarativeNetRequestWithHostAccess");
  const revoked = await region.permissionsChanged({ removed: true, permissions: ["declarativeNetRequestWithHostAccess"] });
  assert.equal(revoked.requested, false);
  assert.deepEqual(f.inspect().scripts, [], "required scripting can unregister future MAIN code independently");
  assert.equal(revoked.cleanupPending.headers, true);
  f.permissions.add("declarativeNetRequestWithHostAccess");
  const restored = await region.permissionsChanged({ removed: false, permissions: ["declarativeNetRequestWithHostAccess"] });
  assert.equal(restored.requested, false); assert.equal(restored.active, false);
  assert.deepEqual(f.inspect().scripts, []); assert.deepEqual(f.inspect().rules, []);
});

test("failed or stale stop notifications preserve refresh debt without claiming cleanup failure", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
  f.session.regionDocuments.applied.legacy = { tabId: 7, generation: 0 };
  f.flags.failNotify = true;
  await region.handle({ type: "regionStop" });
  const stopped = await region.summary();
  assert.equal(f.inspect().notifications.length, 1, "old records without tokens are ignored");
  assert.equal(stopped.needsRefresh, 1);
  assert.deepEqual(stopped.errors, []);
  assert.deepEqual(stopped.cleanupPending, { scripts: false, headers: false });
});

test("an unresponsive document cannot hold stop and future-script cleanup indefinitely", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
  f.flags.holdNotify = true;
  let notified;
  const entered = new Promise(resolve => { notified = resolve; });
  f.flags.onNotify = notified;
  const start = Date.now();
  const stopping = region.handle({ type: "regionStop" });
  await entered;
  assert.deepEqual(f.inspect().scripts, [], "future scripts are gone while an old page is still unresponsive");
  assert.deepEqual(f.inspect().rules, [], "future headers are gone while an old page is still unresponsive");
  const actions = f.inspect().operations;
  assert.ok(actions.findIndex(action => action.type === "unregister") < actions.findIndex(action => action.type === "notify"));
  await stopping;
  assert.ok(Date.now() - start < 2400, "stop notification is bounded");
  assert.deepEqual(f.inspect().scripts, []); assert.deepEqual(f.inspect().rules, []);
  assert.equal((await region.summary()).needsRefresh, 1);
});

test("isolated bootstrap accepts only the extension's bounded stop-only event", async () => {
  const source = await readFile(new URL("../extension/region-bootstrap.js", import.meta.url), "utf8");
  const listeners = [], events = [];
  vm.runInNewContext(source, {
    chrome: { runtime: { id: "own-extension", sendMessage: async () => ({}),
      onMessage: { addListener: listener => listeners.push(listener) } } },
    window: { dispatchEvent: event => events.push(event.type), addEventListener() {} }, Event, performance: { timeOrigin: 12345 }
  });
  assert.equal(listeners.length, 1, "listener is installed before the async handshake");
  const token = "94b41518-99a2-48b7-8c51-a692f115cd86";
  const stop = { type: "regionStopPropagation", controlEvent: token };
  for (const [message, sender] of [
    [stop, { id: "other-extension" }], [stop, {}],
    [{ ...stop, type: "regionApply" }, { id: "own-extension" }],
    [{ ...stop, controlEvent: "click" }, { id: "own-extension" }],
    [{ ...stop, controlEvent: {} }, { id: "own-extension" }]
  ]) listeners[0](message, sender);
  assert.deepEqual(events, []);
  assert.equal(listeners[0](stop, { id: "own-extension" }), undefined);
  assert.deepEqual(events, [token]);
});

test("a current BFCache document keeps its hooks without reinjection or mutation", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
  const previous = structuredClone(f.data), documents = structuredClone(f.session);
  assert.deepEqual(await region.documentRequest({ type: "regionRecheckDocument", protocol: 2 }, sender()), { applied: true });
  assert.equal(f.inspect().executions.length, 1);
  assert.deepEqual(f.inspect().notifications, []);
  assert.deepEqual(f.data, previous); assert.deepEqual(f.session, documents);
});

test("BFCache recheck stops a document missed during pause or profile change", async t => {
  for (const scenario of ["paused", "changed"]) await t.test(scenario, async () => {
    const f = fixture(), region = createRegions(f.api); await apply(region);
    await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
    const token = f.session.regionDocuments.applied["doc-1"].controlEvent;
    f.flags.failNotify = true; // The cached document missed the first notification.
    if (scenario === "paused") { f.data.config.enabled = false; await region.suspend(); }
    else await region.handle({ type: "regionApply", profileId: "sg-en" });
    f.flags.failNotify = false; f.inspect().notifications.length = 0;
    const previous = structuredClone(f.data), documents = structuredClone(f.session);
    assert.deepEqual(await region.documentRequest({ type: "regionRecheckDocument", protocol: 2 }, sender()), { applied: false, reloadRequired: true });
    assert.deepEqual(f.inspect().notifications, [{ tabId: 4, message: { type: "regionStopPropagation", controlEvent: token }, target: { documentId: "doc-1" } }]);
    assert.equal(f.inspect().executions.length, 1, "a restored old document is never repatched");
    assert.deepEqual(f.data, previous); assert.deepEqual(f.session, documents);
  });
});

test("BFCache recheck without a record does nothing and cannot repair missing artifacts", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  assert.deepEqual(await region.documentRequest({ type: "regionRecheckDocument", protocol: 2 }, sender("unknown")), { applied: false });
  assert.equal(f.inspect().notifications.length, 0);
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
  f.api.scripting.getRegisteredContentScripts = async () => [];
  const previous = structuredClone(f.data);
  assert.deepEqual(await region.documentRequest({ type: "regionRecheckDocument", protocol: 2 }, sender()), { applied: false, reloadRequired: true });
  assert.equal(f.inspect().notifications.length, 1);
  assert.equal(f.inspect().executions.length, 1);
  assert.deepEqual(f.data, previous, "recheck only reads settings, even when artifacts are missing");
});

test("bootstrap rechecks only a trusted persisted pageshow", async () => {
  const source = await readFile(new URL("../extension/region-bootstrap.js", import.meta.url), "utf8");
  const requests = [], events = new Map();
  vm.runInNewContext(source, {
    chrome: { runtime: { id: "own-extension", sendMessage: async message => { requests.push(message); return {}; }, onMessage: { addListener() {} } } },
    window: { dispatchEvent() {}, addEventListener: (name, listener) => events.set(name, listener) }, Event, performance: { timeOrigin: 12345 }
  });
  requests.length = 0;
  events.get("pageshow")({ persisted: false, isTrusted: true });
  events.get("pageshow")({ persisted: true, isTrusted: false });
  assert.deepEqual(requests, []);
  events.get("pageshow")({ persisted: true, isTrusted: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "regionRecheckDocument"); assert.equal(requests[0].protocol, 2);
});

test("an unavailable scripting API records cleanup debt and recovery cannot re-enable stale scripts", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const generation = f.data.regionRuntime.generation;
  f.flags.scriptUnavailable = true;
  const revoked = await region.summary();
  assert.equal(revoked.requested, false); assert.equal(revoked.cleanupPending.scripts, true);
  assert.deepEqual(f.inspect().rules, [], "DNR cleaned independently of scripting availability");
  f.flags.scriptUnavailable = false;
  assert.deepEqual(await region.documentRequest({ type: "regionDocument", protocol: 2, generation }, sender()), { applied: false });
  const granted = await region.permissionsChanged({ removed: false });
  assert.equal(granted.requested, false); assert.equal(granted.active, false);
  assert.equal(granted.status,"off"); assert.deepEqual(granted.errors,[]); assert.ok(granted.notices.length);
  assert.deepEqual(granted.cleanupPending, { scripts: false, headers: false });
  assert.deepEqual(f.inspect().scripts, []);
  assert.equal(f.inspect().executions.length, 0);
});

test("cleanup failures survive controller restart and remain visible until retried", async () => {
  const f = fixture(); let region = createRegions(f.api); await apply(region);
  f.flags.failCleanup = true; await region.handle({ type: "regionStop" });
  let status = await region.summary();
  assert.equal(status.status, "cleanup"); assert.equal(status.requested, false); assert.ok(status.errors.length);
  region = createRegions(f.api);
  status = await region.summary(); assert.equal(status.status, "cleanup");
  f.flags.failCleanup = false;
  status = (await region.handle({ type: "regionRetryCleanup" })).lifecycle;
  assert.equal(status.status, "off"); assert.deepEqual(status.cleanupPending, { scripts: false, headers: false });
});

test("partial apply failure leaves no active authorization or residual headers", async () => {
  const f = fixture(); f.flags.failRules = true;
  const region = createRegions(f.api);
  await assert.rejects(apply(region), /未完整应用/);
  assert.equal(f.data.regionRuntime.requested, false);
  assert.deepEqual(f.inspect().scripts, []); assert.deepEqual(f.inspect().rules, []);
});

test("registration failure cleans the already-installed language header", async () => {
  const f = fixture(); f.flags.failRegister = true;
  const region = createRegions(f.api);
  await assert.rejects(apply(region), /未完整应用/);
  assert.equal(f.data.regionRuntime.requested, false);
  assert.deepEqual(f.inspect().scripts, []); assert.deepEqual(f.inspect().rules, []);
  assert.deepEqual(f.data.regionRuntime.cleanupPending, { scripts: false, headers: false });
});

test("explicit stop retains chosen preset and never auto-reloads existing pages", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const before = f.inspect().reloads.length;
  await region.handle({ type: "regionStop", tabId: 4 });
  const status = await region.summary();
  assert.equal(status.requested, false); assert.equal(status.selectedProfileId, "jp");
  assert.equal(f.inspect().reloads.length, before); assert.equal(status.needsRefresh, 1);
  await region.handle({ type: "regionRefreshCurrent", tabId: 4 });
  assert.equal((await region.summary()).needsRefresh, 0);
});

test("editing selected custom profile while paused does not enable it", async () => {
  const f = fixture({ enabled: false }), region = createRegions(f.api);
  f.data.regions = { defaultProfileId: "custom-one", custom: [{ id:"custom-one",name:"old",timezone:"Asia/Tokyo",locale:"ja-JP",languages:["ja-JP","ja"] }] };
  await region.handle({ type:"regionSave",id:"custom-one",profile:{name:"new",timezone:"Asia/Singapore",locale:"en-SG",languages:["en-SG","en"]} });
  assert.deepEqual(f.inspect().scripts, []); assert.deepEqual(f.inspect().rules, []);
  assert.equal(f.data.regions.custom[0].name, "new");
});

test("without optional permissions Apply keeps desired region off", async () => {
  const f = fixture({ permission: false }), region = createRegions(f.api);
  await assert.rejects(apply(region), /授权/);
  assert.equal((await region.summary()).requested, false);
  assert.equal(f.data.regions.defaultProfileId, null);
});

test("native preset needs no optional permissions and never installs overrides", async () => {
  const f = fixture({ permission: false, enabled: false }), region = createRegions(f.api);
  const result = await region.handle({ type: "regionApply", profileId: "native", tabId: 4 });
  assert.equal(result.lifecycle.requested, false);
  assert.equal(result.lifecycle.selectedProfileId, "native");
  assert.equal(result.lifecycle.active, false);
  assert.deepEqual(f.inspect().scripts, []); assert.deepEqual(f.inspect().rules, []);
  assert.deepEqual(f.inspect().reloads, [4]);
});

test("language-native mode removes the previous language rule and retains timezone coverage", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const saved = await region.handle({ type: "regionSave", profile: { name: "Only timezone", languageMode: "native", timezone: "Asia/Tokyo" } });
  const id = saved.profiles.find(p => p.name === "Only timezone").id;
  const selected = await region.handle({ type: "regionApply", profileId: id, tabId: 4 });
  assert.equal(selected.lifecycle.active, true);
  assert.equal(f.inspect().rules.some(rule => rule.id === 7001), false);
  assert.equal(f.inspect().scripts.length, 1);
  const status = await region.status(4);
  assert.equal(status.current.status, "partial");
});

test("selecting native stops all overrides and cannot be revived by global resume", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  await region.handle({ type: "regionApply", profileId: "native", tabId: 4 });
  assert.deepEqual(f.inspect().scripts, []); assert.deepEqual(f.inspect().rules, []);
  assert.equal((await region.resume()).active, false);
  assert.equal(f.data.regions.defaultProfileId, "native");
});

test("an unchanged document keeps valid observation metadata without marking a page modified", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  f.api.scripting.executeScript = async injection => [{ documentId: injection.target.documentIds?.[0], result: { applied: true, changed: false, timeOrigin: 12345 } }];
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
  assert.equal(f.session.regionDocuments.modified[4], undefined);
  assert.deepEqual(f.session.regionDocuments.observed[4], { title: "Page" });
  await region.handle({ type: "regionStop" });
  assert.ok((await region.prepareStatus()).refreshTabs.every(tab => typeof tab.title === "string"));
});

test("refresh into an unchanged document clears the previous modified flag", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  const generation = f.data.regionRuntime.generation;
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation }, sender());
  f.api.tabs.reload = async () => {
    f.session.regionDocuments.applied.replacement = { tabId: 4, generation, changed: false };
  };
  await region.handle({ type: "regionRefreshCurrent", tabId: 4 });
  assert.equal(f.session.regionDocuments.modified[4], undefined);
  assert.equal(f.session.regionDocuments.applied.replacement.changed, false);
});

test("a new child frame cannot clear stale top-level page refresh debt", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, sender());
  // Switch profile without refreshing this page, then a new frame appears in it.
  await region.handle({ type: "regionApply", profileId: "sg-en" });
  assert.equal((await region.summary()).needsRefresh, 1);
  await region.documentRequest({ type: "regionDocument", protocol: 2, generation: f.data.regionRuntime.generation }, { ...sender("frame-new"), frameId: 5 });
  assert.equal((await region.summary()).needsRefresh, 1);
});

test("loading notifications never prove the modified document was replaced", async () => {
  const f=fixture(),region=createRegions(f.api);await apply(region);
  await region.documentRequest({type:"regionDocument",protocol:2,generation:f.data.regionRuntime.generation},sender());
  await region.handle({type:"regionStop"});
  await region.tabChanged(4,{status:"loading"},{url:"https://example.com/"});
  assert.equal((await region.summary()).needsRefresh,1);
  f.api.scripting.executeScript=async()=>[{documentId:"doc-1",result:null}];
  await region.tabChanged(4,{status:"complete"},{url:"https://example.com/"},await region.checkTabDocument(4));
  assert.equal((await region.summary()).needsRefresh,1,"old document still present");
  f.api.scripting.executeScript=async()=>[{documentId:"doc-replaced",result:null}];
  await region.tabChanged(4,{status:"complete"},{url:"https://example.com/"},await region.checkTabDocument(4));
  assert.equal((await region.summary()).needsRefresh,0);
});

test("bounded document guards fail closed instead of evicting a live document", async () => {
  const f = fixture(), region = createRegions(f.api); await apply(region);
  f.session.regionDocuments = { modified: {}, refresh: {}, observed: {}, applied: Object.fromEntries(Array.from({length:128}, (_, i) => ["doc-"+i,{tabId:4,generation:f.data.regionRuntime.generation}])) };
  const result = await region.documentRequest({type:"regionDocument",protocol:2,generation:f.data.regionRuntime.generation},sender("doc-overflow"));
  assert.deepEqual(result,{applied:false,reloadRequired:true});
  assert.equal(f.inspect().executions.length,0);
  assert.equal(Object.keys(f.session.regionDocuments.applied).length,128);
  await region.handle({type:"regionRefreshCurrent",tabId:4});
  assert.equal(Object.keys(f.session.regionDocuments.applied).length,0);
});

test("granting tabs access resolves an unknown refresh census without enabling regions", async () => {
  const f = fixture(); f.data.regions.defaultProfileId="jp"; f.permissions.delete("tabs");
  const region=createRegions(f.api);
  assert.equal((await region.summary()).refreshUnknown,true);
  f.permissions.add("tabs");
  await region.handle({type:"regionRefreshAll"});
  const result=await region.summary();
  assert.equal(result.refreshUnknown,false); assert.equal(result.needsRefresh,0); assert.equal(result.requested,false);
});
