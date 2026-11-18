import test from "node:test";
import assert from "node:assert/strict";
import { createSiteCleanup } from "../extension/site-cleanup.js";

function fixture() {
  const session = {}, calls = { tabs: [], permissions: [], remove: [], writes: [] };
  const flags = { allowed: true, tab: { id: 7, url: "https://example.com/private/path?secret=do-not-retain", incognito: false },
    failWrite: false, failRead: false, throwRemove: false };
  let resolveOperation, rejectOperation;
  const operation = new Promise((resolve, reject) => { resolveOperation = resolve; rejectOperation = reject; });
  const api = {
    tabs: { async get(id) { calls.tabs.push(id); if (!flags.tab) throw new Error("tab gone"); return structuredClone(flags.tab); } },
    permissions: { async contains(request) { calls.permissions.push(request); return flags.allowed; } },
    storage: { session: {
      async get(key) { if (flags.failRead) throw new Error("storage unavailable"); return { [key]: structuredClone(session[key]) }; },
      async set(value) { if (flags.failWrite) throw new Error("storage write failed"); Object.assign(session, structuredClone(value)); calls.writes.push(structuredClone(value)); }
    } },
    browsingData: { remove(options, types) {
      calls.remove.push({ options: structuredClone(options), types: structuredClone(types) });
      if (flags.throwRemove) throw new Error("synchronous API failure");
      return operation;
    } }
  };
  return { api, session, calls, flags, finish: resolveOperation, fail: rejectOperation, cleanup: createSiteCleanup(api) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("preparation is read-only, retains an exact origin and warns that Cookie deletion includes related subdomains", async () => {
  const f = fixture();
  const cache = await f.cleanup.prepare(7, "cache"), data = await f.cleanup.prepare(7, "data");
  assert.equal(cache.origin, "https://example.com"); assert.equal(cache.kind, "cache");
  assert.equal(data.incognito, false); assert.equal(data.tabId, 7);
  assert.ok(cache.expiresAt > Date.now()); assert.ok(data.expiresAt <= Date.now() + 60_000);
  assert.match(data.warning, /退出登录/); assert.match(data.warning, /主域及其子域/);
  assert.match(cache.warning, /HTTP 缓存/); assert.match(cache.warning, /另一个按钮/);
  assert.notEqual(cache.token, data.token);
  assert.doesNotMatch(JSON.stringify([cache, data]), /private\/path|secret|do-not-retain/);
  assert.deepEqual(f.calls.remove, []); assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.permissions, []);
});

test("cache cleanup uses only origin-filtered HTTP cache and returns before a hanging browser operation finishes", async () => {
  const f = fixture(), prepared = await f.cleanup.prepare(7, "cache");
  const job = await f.cleanup.start(prepared.token);
  assert.equal(job.state, "running"); assert.equal(job.origin, prepared.origin);
  assert.deepEqual(f.calls.remove, [{ options: { origins: ["https://example.com"], since: 0,
    originTypes: { unprotectedWeb: true, protectedWeb: true, extension: false } }, types: { cache: true } }]);
  assert.deepEqual(f.calls.permissions, [{ permissions: ["browsingData"] }]);
  assert.equal((await f.cleanup.getStatus()).state, "running");
  assert.equal((await f.cleanup.getStatus(job.id)).id, job.id);
  assert.equal(await f.cleanup.getStatus("unrelated-job"), null);
  assert.doesNotMatch(JSON.stringify(f.session), /secret|private\/path|do-not-retain/);
  f.finish(); await tick();
  assert.equal((await f.cleanup.getStatus(job.id)).state, "done");
  assert.equal((await f.cleanup.getStatus()).error, null);
});

test("site-data cleanup is separate from HTTP cache, history, downloads, passwords and form data", async () => {
  const f = fixture(); f.flags.tab.url = "https://example.com:8443/p?q=private";
  const prepared = await f.cleanup.prepare(7, "data");
  const job = await f.cleanup.start(prepared.token);
  assert.deepEqual(f.calls.remove, [{
    options: { origins: ["https://example.com:8443"], since: 0,
      originTypes: { unprotectedWeb: true, protectedWeb: true, extension: false } },
    types: { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true }
  }]);
  for (const key of ["cache", "history", "downloads", "passwords", "formData"]) assert.equal(key in f.calls.remove[0].types, false);
  assert.equal("owner" in job, false); assert.equal("schema" in job, false);
  f.finish(); await tick(); assert.equal((await f.cleanup.getStatus()).state, "done");
});

test("invalid kind, invalid tab, nonweb origins and credential-bearing URLs cannot prepare a deletion", async () => {
  const f = fixture();
  for (const kind of ["all", "cookies", undefined, null, {}, "CACHE"]) await assert.rejects(f.cleanup.prepare(7, kind), { code: "INVALID_KIND" });
  for (const id of [null, undefined, "7", -1, 1.1]) await assert.rejects(f.cleanup.prepare(id, "data"), { code: "INVALID_TAB" });
  for (const url of ["file:///private/file", "chrome://settings", "data:text/html,hello", "https://user:pass@example.com", "not-a-url"]) {
    f.flags.tab.url = url;
    await assert.rejects(f.cleanup.prepare(7, "cache"));
  }
  assert.equal(f.calls.remove.length, 0); assert.equal(f.calls.writes.length, 0);
});

test("incognito is rejected both at preparation and immediately before removal", async () => {
  const f = fixture(); f.flags.tab.incognito = true;
  await assert.rejects(f.cleanup.prepare(7, "data"), { code: "INCOGNITO_UNSUPPORTED" });
  f.flags.tab.incognito = false;
  const prepared = await f.cleanup.prepare(7, "data"); f.flags.tab.incognito = true;
  await assert.rejects(f.cleanup.start(prepared.token), { code: "INCOGNITO_UNSUPPORTED" });
  assert.equal(f.calls.remove.length, 0);
});

test("a changed or pending different-origin tab cannot redirect the deletion target", async () => {
  for (const changed of ["url", "pendingUrl", "closed"]) {
    const f = fixture(), prepared = await f.cleanup.prepare(7, "data");
    if (changed === "closed") f.flags.tab = null;
    else f.flags.tab[changed] = "https://another.example/new";
    await assert.rejects(f.cleanup.start(prepared.token), error => ["TAB_CHANGED", "INVALID_TAB"].includes(error.code));
    assert.equal(f.calls.remove.length, 0);
    await assert.rejects(f.cleanup.start(prepared.token), { code: "INVALID_TOKEN" });
  }
  const f = fixture(); f.flags.tab.pendingUrl = "https://other.example/";
  await assert.rejects(f.cleanup.prepare(7, "cache"), { code: "TAB_CHANGED" });
});

test("missing permissions, expired preparations and replayed double clicks never launch duplicate removals", async t => {
  const noPermission = fixture(), p = await noPermission.cleanup.prepare(7, "cache");
  noPermission.flags.allowed = false;
  await assert.rejects(noPermission.cleanup.start(p.token), { code: "PERMISSION_REQUIRED" });
  assert.equal(noPermission.calls.remove.length, 0);

  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const expired = fixture(), e = await expired.cleanup.prepare(7, "data");
  t.mock.timers.setTime(e.expiresAt);
  await assert.rejects(expired.cleanup.start(e.token), { code: "EXPIRED_TOKEN" });
  assert.equal(expired.calls.remove.length, 0);

  const duplicate = fixture(), d = await duplicate.cleanup.prepare(7, "cache");
  const responses = await Promise.allSettled([duplicate.cleanup.start(d.token), duplicate.cleanup.start(d.token)]);
  assert.equal(responses.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(responses.find(result => result.status === "rejected").reason.code, "INVALID_TOKEN");
  assert.equal(duplicate.calls.remove.length, 1);
  duplicate.finish(); await tick();
});

test("only one removal can be pending and a busy token cannot silently replay later", async () => {
  const f = fixture(), a = await f.cleanup.prepare(7, "cache"), b = await f.cleanup.prepare(7, "data");
  await f.cleanup.start(a.token);
  await assert.rejects(f.cleanup.start(b.token), { code: "CLEANUP_BUSY" });
  assert.equal(f.calls.remove.length, 1);
  f.finish(); await tick();
  await assert.rejects(f.cleanup.start(b.token), { code: "INVALID_TOKEN" });
});

test("browser API failures are recorded without falsely claiming no partial data loss", async () => {
  for (const sync of [false, true]) {
    const f = fixture(); f.flags.throwRemove = sync;
    const p = await f.cleanup.prepare(7, "data");
    const started = await f.cleanup.start(p.token); assert.equal(started.state, "running");
    if (!sync) f.fail(new Error("failed https://example.com/private?secret=never-retain"));
    await tick();
    const job = await f.cleanup.getStatus();
    assert.equal(job.state, "error"); assert.match(job.error, /部分数据可能已删除/);
    assert.doesNotMatch(job.error, /private|secret|never-retain/);
  }
});

test("a worker restart downgrades an unfinished operation to unknown and never starts it again", async () => {
  const f = fixture(), p = await f.cleanup.prepare(7, "cache");
  const started = await f.cleanup.start(p.token);
  const restarted = createSiteCleanup(f.api);
  const status = await restarted.getStatus(started.id);
  assert.equal(status.state, "unknown"); assert.match(status.error, /后台已重启/);
  assert.equal(f.calls.remove.length, 1);
  await assert.rejects(restarted.start(p.token), { code: "INVALID_TOKEN" });
  // A stale controller's completion cannot overwrite its replacement's record.
  f.finish(); await tick();
  assert.equal((await restarted.getStatus()).state, "unknown");
});

test("failure to record the running operation prevents any deletion", async () => {
  const f = fixture(), p = await f.cleanup.prepare(7, "data"); f.flags.failWrite = true;
  await assert.rejects(f.cleanup.start(p.token), /storage write failed/);
  assert.equal(f.calls.remove.length, 0);
});

test("a completion-record failure is visible as unknown and cannot strand the current UI in running", async () => {
  const f = fixture(), p = await f.cleanup.prepare(7, "cache");
  await f.cleanup.start(p.token); f.flags.failWrite = true;
  f.finish(); await tick();
  const result = await f.cleanup.getStatus();
  assert.equal(result.state, "unknown"); assert.match(result.error, /结果暂时无法保存/);
  assert.equal(f.calls.remove.length, 1);
  const another = await f.cleanup.prepare(7, "data");
  await assert.rejects(f.cleanup.start(another.token), /storage write failed/);
  assert.equal((await f.cleanup.getStatus()).state, "unknown", "a failed new start preserves the previous uncertain result");
  assert.equal(f.calls.remove.length, 1);
});

test("navigation or expiration while recording a job cancels it before any browser removal", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  for (const variant of ["navigation", "expired"]) {
    const f = fixture(), p = await f.cleanup.prepare(7, "data");
    const write = f.api.storage.session.set; let first = true;
    f.api.storage.session.set = async value => {
      await write(value);
      if (first) {
        first = false;
        if (variant === "navigation") f.flags.tab.url = "https://elsewhere.example/";
        else t.mock.timers.setTime(p.expiresAt + 1);
      }
    };
    await assert.rejects(f.cleanup.start(p.token), { code: variant === "navigation" ? "TAB_CHANGED" : "EXPIRED_TOKEN" });
    assert.equal(f.calls.remove.length, 0);
    const state = await f.cleanup.getStatus();
    assert.equal(state.state, "error"); assert.match(state.error, /没有开始清理/);
  }
});

test("prepare tokens are bounded and expire rather than accumulating without limit", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const f = fixture();
  for (let i = 0; i < 16; i++) await f.cleanup.prepare(7, "cache");
  await assert.rejects(f.cleanup.prepare(7, "cache"), { code: "TOO_MANY_PREPARES" });
  t.mock.timers.setTime(1800000060001);
  assert.ok((await f.cleanup.prepare(7, "cache")).token);
  assert.equal(f.calls.remove.length, 0);
});
