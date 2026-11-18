import test from "node:test";
import assert from "node:assert/strict";
import { summarizeState } from "../extension/status.js";

const clean = (enabled = true) => ({ config:{enabled}, settings:[], siteErrors:[], region:{status:"off",errors:[],needsRefresh:0,cleanupPending:{scripts:false,headers:false}} });
test("clean pause is OFF; pending cleanup cannot falsely be OFF", () => {
  assert.equal(summarizeState(clean(false)).text, "OFF");
  const state=clean(false);state.region.cleanupPending.scripts=true;
  assert.equal(summarizeState(state).text,"!");
  assert.equal(summarizeState(state).failed,true);
});
test("paused badge remains OFF while its title explains refresh debt", () => {
  const state=clean(false);state.region.needsRefresh=2;
  assert.equal(summarizeState(state).text,"OFF");
  assert.equal(summarizeState(state).refresh,true);
  assert.match(summarizeState(state).title,/已暂停.*需刷新/);
});
test("enabled badge shows refresh debt; failure takes precedence over paused state", () => {
  const state=clean();state.region.needsRefresh=2;
  assert.equal(summarizeState(state).text,"↻");
  state.config.enabled=false;
  state.region.cleanupPending.headers=true;
  assert.equal(summarizeState(state).text,"!");
});
test("unknown old-page count still leaves paused badge OFF with refresh guidance", () => {
  const state=clean(false);state.region.refreshUnknown=true;
  assert.equal(summarizeState(state).text,"OFF");
  assert.match(summarizeState(state).title,/已暂停.*需刷新/);
});
test("native failure and region permission failure share warning priority", () => {
  const native=clean();native.settings=[{wanted:true,status:"blocked"}];
  const region=clean();region.region.status="setup";region.region.requested=true;
  assert.equal(summarizeState(native).text,"!");
  assert.equal(summarizeState(region).text,"!");
});
test("a revoked region that was fully cleaned is informational, not a failure", () => {
  const state=clean(false);state.region.notices=["已停止地区模式"];
  assert.equal(summarizeState(state).text,"OFF");
  assert.equal(summarizeState(state).failed,false);
});
test("request-rule cleanup failure takes warning priority even while paused", () => {
  const state = clean(false); state.protection = { phase: "cleanup", cleanupPending: true, errors: [] };
  assert.equal(summarizeState(state).text, "!");
  state.protection = { phase: "paused", cleanupPending: false, errors: [] };
  assert.equal(summarizeState(state).text, "OFF");
});
