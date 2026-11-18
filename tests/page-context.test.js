import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { applyPageLocale } from "../extension/page-locale.js";
import { renderPageContext, renderEarlyEntry } from "../tools/build-page-context.mjs";
import { EARLY_PROFILES, earlyProfileFor, earlyControlEvent } from "../extension/region-early.js";

test("the shipped context entry point matches its bundled source functions", async () => {
  assert.equal(await readFile(new URL("../extension/page-context.js", import.meta.url), "utf8"), renderPageContext());
});

test("applying to a child realm creates language arrays in that realm", () => {
  const child = vm.createContext({});
  vm.runInContext("globalThis.navigator=Object.create({get language(){return 'zh-CN'},get languages(){return ['zh-CN','zh']}})", child);
  const parent = vm.createContext({ child: vm.runInContext("globalThis", child) });
  vm.runInContext(`(${applyPageLocale.toString()})({timezone:'Asia/Tokyo',locale:'ja-JP',languages:['ja-JP','ja']},child)`, parent);
  assert.equal(vm.runInContext("navigator.languages instanceof Array", child), true);
  assert.equal(vm.runInContext("Object.getPrototypeOf(navigator.languages)===Array.prototype", child), true);
  assert.equal(vm.runInContext("Object.isFrozen(navigator.languages)", child), true);
  assert.equal(vm.runInContext("Intl.DateTimeFormat().resolvedOptions().timeZone", child), "Asia/Tokyo");
  assert.equal(vm.runInContext("navigator.language", child), "ja-JP");
  assert.equal(vm.runInContext("typeof navigator", parent), "undefined");
});

test("only exact bundled override combinations select an early entry", () => {
  assert.deepEqual(EARLY_PROFILES.map(entry => entry.key), ["jp", "sg-en", "us-en", "us-ny"]);
  for (const { key, file, profile } of EARLY_PROFILES) {
    assert.deepEqual(earlyProfileFor(profile), { key, file });
    assert.deepEqual(earlyProfileFor({ ...profile, id: "custom-renamed", name: "My saved combination", timezoneMode: undefined, languageMode: undefined }), { key, file });
    assert.equal(earlyProfileFor({ ...profile, timezoneMode: "native" }), null);
    assert.equal(earlyProfileFor({ ...profile, languageMode: "native" }), null);
    assert.equal(earlyProfileFor({ ...profile, languages: [...profile.languages].reverse() }), null);
    assert.equal(earlyProfileFor({ ...profile, languages: [...profile.languages, "zh-CN"] }), null);
  }
  assert.equal(earlyProfileFor({ timezone: "Europe/London", locale: "en-GB", languages: ["en-GB", "en"] }), null);
  assert.equal(earlyProfileFor(null), null);
});

test("early stop tokens agree between independent realms and are document-specific", () => {
  const identity = 1794871234567.125;
  const token = earlyControlEvent("us-en", identity);
  assert.match(token, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(vm.runInNewContext(`(${earlyControlEvent.toString()})('us-en',${identity})`), token);
  assert.notEqual(earlyControlEvent("us-en", identity + 0.125), token);
  assert.notEqual(earlyControlEvent("us-ny", identity), token);
  for (const [key, time] of [["native", identity], ["bad", identity], ["us-en", NaN], ["us-en", Infinity], ["us-en", -1], ["us-en", String(identity)]]) {
    assert.throws(() => earlyControlEvent(key, time), TypeError);
  }
  let coerced = false;
  assert.throws(() => earlyControlEvent({ toString() { coerced = true; return "us-en"; } }, identity), TypeError);
  assert.equal(coerced, false);
});

test("all shipped early entries match their fixed generated profiles", async () => {
  for (const { key, file } of EARLY_PROFILES) {
    assert.equal(await readFile(new URL(`../extension/${file}`, import.meta.url), "utf8"), renderEarlyEntry(key));
  }
  assert.throws(() => renderEarlyEntry("custom"), TypeError);
});

test("an early entry synchronously applies its profile without a global configuration marker", () => {
  const context = vm.createContext({});
  const run = expression => vm.runInContext(expression, context);
  run(`globalThis.document={}; globalThis.performance={timeOrigin:1794871234567.125};
    globalThis.listeners=new Map();
    globalThis.addEventListener=(name,listener)=>listeners.set(name,listener);
    globalThis.removeEventListener=(name,listener)=>{if(listeners.get(name)===listener)listeners.delete(name)};
    globalThis.navigator=Object.create({get language(){return 'zh-CN'},get languages(){return ['zh-CN','zh']}});
    globalThis.keysBefore=Object.getOwnPropertyNames(globalThis);
  `);
  run(renderEarlyEntry("us-en"));
  assert.equal(run("navigator.language"), "en-US");
  assert.equal(run("navigator.languages.join()"), "en-US,en");
  assert.equal(run("Intl.DateTimeFormat().resolvedOptions().timeZone"), "America/Los_Angeles");
  assert.equal(run("Intl.DateTimeFormat().resolvedOptions().locale"), "en-US");
  assert.equal(run("typeof chrome"), "undefined");
  assert.equal(run("typeof applyPageContext"), "undefined");
  // keysBefore itself was created after its snapshot, so ignore that fixture key.
  assert.equal(run("Object.getOwnPropertyNames(globalThis).filter(key=>key!=='keysBefore').join()===keysBefore.filter(key=>key!=='keysBefore').join()"), true);
  assert.equal(run(`listeners.has(${JSON.stringify(earlyControlEvent("us-en", 1794871234567.125))})`), true);
});
