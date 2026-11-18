import test from "node:test";
import assert from "node:assert/strict";
import { sendRequest, withTimeout } from "../extension/rpc.js";

test("a hanging read has a bounded retry and then an explicit timeout", async () => {
  let calls = 0;
  const api = { runtime: { sendMessage() { calls++; return new Promise(() => {}); } } };
  await assert.rejects(sendRequest(api, { type: "status" }, { timeoutMs: 5 }), error => error.code === "RPC_TIMEOUT" && /重新检查/.test(error.message));
  assert.equal(calls, 2);
});

test("a read can recover after a service worker transport failure", async () => {
  let calls = 0;
  const api = { runtime: { sendMessage() { return ++calls === 1 ? Promise.reject(new Error("Receiving end does not exist")) : Promise.resolve({ ok: true, data: { active: false } }); } } };
  assert.deepEqual(await sendRequest(api, { type: "regionStatus" }, { timeoutMs: 20 }), { active: false });
  assert.equal(calls, 2);
});

test("a timed out write is never replayed and may still finish afterwards", async () => {
  let calls = 0, finish, committed = false;
  const api = { runtime: { sendMessage() { calls++; return new Promise(resolve => { finish = () => { committed = true; resolve({ ok: true, data: {} }); }; }); } } };
  await assert.rejects(sendRequest(api, { type: "regionApply" }, { timeoutMs: 5 }), /结果未确认/);
  assert.equal(calls, 1);
  finish(); await Promise.resolve();
  assert.equal(committed, true);
  assert.equal(calls, 1);
});

test("backend rejection is displayed without retrying even a read", async () => {
  let calls = 0;
  const api = { runtime: { sendMessage() { calls++; return Promise.resolve({ ok: false, error: "权限不可用" }); } } };
  await assert.rejects(sendRequest(api, { type: "status" }), /权限不可用/);
  assert.equal(calls, 1);
});

test("successful and failed browser reads settle before their timer", async () => {
  assert.equal(await withTimeout(Promise.resolve("ready"), 20), "ready");
  await assert.rejects(withTimeout(Promise.reject(new Error("tab closed")), 20), /tab closed/);
});

test("a timed out cleanup start is never repeated while cleanup status may retry", async () => {
  let starts = 0;
  const startApi = { runtime: { sendMessage() { starts++; return new Promise(() => {}); } } };
  await assert.rejects(sendRequest(startApi, { type: "cleanupStart", token: "once" }, { timeoutMs: 5 }), /结果未确认/);
  assert.equal(starts, 1);
  let reads = 0;
  const statusApi = { runtime: { sendMessage() { return ++reads === 1 ? Promise.reject(new Error("worker restarted"))
    : Promise.resolve({ ok: true, data: { state: "unknown" } }); } } };
  assert.deepEqual(await sendRequest(statusApi, { type: "cleanupStatus" }), { state: "unknown" });
  assert.equal(reads, 2);
});
