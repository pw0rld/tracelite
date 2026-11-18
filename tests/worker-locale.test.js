import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installWorkerLocale } from "../extension/worker-locale.js";

function fixture() {
  const urls = new Map(), revoked = [], calls = [], timers = new Map();
  let next = 0, timerId = 0, rejectGenerated = false;
  function Worker(...args) {
    calls.push({ args, newTarget: new.target });
    if (rejectGenerated && args[0] === `blob:local/${next}` && next > 1) {
      if (rejectGenerated === "type") throw new TypeError("TrustedScriptURL required");
      throw new DOMException("blocked", "SecurityError");
    }
    this.url = args[0]; this.listeners = new Map();
  }
  Worker.prototype.addEventListener = function (name, fn) { this.listeners.set(name, fn); };
  const root = { Blob, Function, WeakRef, Array, Object, Worker, structuredClone,
    URL: { createObjectURL(blob) { if (!(blob instanceof Blob)) throw new TypeError("not a Blob"); const url = `blob:local/${++next}`; urls.set(url, blob); return url; },
      revokeObjectURL(url) { revoked.push(url); urls.delete(String(url)); } },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }
  };
  const original = { Worker, Blob, create: root.URL.createObjectURL, revoke: root.URL.revokeObjectURL };
  function apply(profile) { globalThis.workerTestProfile = profile; }
  const cleanup = installWorkerLocale(root, { timezone: "Asia/Tokyo", languages: ["ja-JP"] }, apply);
  return { root, urls, revoked, calls, timers, cleanup, original, setRejectGenerated: value => { rejectGenerated = value; } };
}

test("captured JavaScript Blob default workers receive bundled initialization", async () => {
  const f = fixture();
  const blob = new f.root.Blob(["postMessage('original payload');"], { type: "text/javascript" });
  const originalURL = f.root.URL.createObjectURL(blob);
  const worker = new f.root.Worker(originalURL);
  assert.notEqual(worker.url, originalURL);
  const combined = f.urls.get(worker.url);
  assert.equal(combined.type, blob.type);
  const text = await combined.text();
  assert.match(text, /workerTestProfile/);
  assert.match(text, /Asia\/Tokyo/);
  assert.ok(text.endsWith("postMessage('original payload');"));
  assert.equal(f.urls.get(originalURL), blob, "original URL content is untouched");
  assert.ok(worker instanceof f.root.Worker);
  assert.equal(worker.constructor, f.root.Worker);
  worker.listeners.get("message")();
  assert.equal(f.urls.has(worker.url), false);
  assert.equal(f.urls.has(originalURL), true);
  f.cleanup();
});

test("URL objects and all options objects pass through without new property reads", () => {
  const f = fixture(), url = f.root.URL.createObjectURL(new f.root.Blob(["1"], { type: "application/javascript" }));
  let reads = 0;
  const options = { get type() { reads++; return "module"; } };
  new f.root.Worker(url, options);
  assert.equal(f.calls.at(-1).args[0], url);
  assert.equal(f.calls.at(-1).args[1], options);
  assert.equal(reads, 0);
  const trustedLike = { toString() { throw new Error("wrapper must not convert this"); } };
  new f.root.Worker(trustedLike);
  assert.equal(f.calls.at(-1).args[0], trustedLike);
  new f.root.Worker("https://example.invalid/worker.js");
  assert.equal(f.calls.at(-1).args[0], "https://example.invalid/worker.js");
  f.cleanup();
});

test("revoked, uncaptured and non-JavaScript Blob URLs remain native", () => {
  const f = fixture();
  const plain = f.root.URL.createObjectURL(new f.root.Blob(["1"], { type: "text/plain" }));
  new f.root.Worker(plain); assert.equal(f.calls.at(-1).args[0], plain);
  const noType = f.root.URL.createObjectURL(new f.root.Blob(["1"]));
  new f.root.Worker(noType); assert.equal(f.calls.at(-1).args[0], noType);
  const js = f.root.URL.createObjectURL(new f.root.Blob(["1"], { type: "text/javascript" }));
  f.root.URL.revokeObjectURL(js);
  new f.root.Worker(js); assert.equal(f.calls.at(-1).args[0], js);
  f.cleanup();
});

test("captured Blob count is bounded and generated URLs expire", () => {
  const f = fixture(), blobs = [], urls = [];
  for (let i = 0; i < 129; i++) { const blob = new f.root.Blob(["1"], { type: "text/javascript" }); blobs.push(blob); urls.push(f.root.URL.createObjectURL(blob)); }
  new f.root.Worker(urls[0]); assert.equal(f.calls.at(-1).args[0], urls[0]);
  const worker = new f.root.Worker(urls.at(-1)); assert.notEqual(worker.url, urls.at(-1));
  for (const timer of [...f.timers.values()]) timer();
  assert.equal(f.urls.has(worker.url), false);
  assert.equal(f.timers.size, 0);
  f.cleanup();
});

test("cleanup restores owned descriptors and cached wrappers stop changing workers", () => {
  const f = fixture(), Worker = f.root.Worker, create = f.root.URL.createObjectURL;
  const blob = new f.root.Blob(["1"], { type: "text/javascript" }), url = create(blob);
  const worker = new Worker(url);
  f.cleanup(); f.cleanup();
  assert.equal(f.root.Worker, f.original.Worker);
  assert.equal(f.root.Blob, f.original.Blob);
  assert.equal(f.root.URL.createObjectURL, f.original.create);
  assert.equal(f.root.URL.revokeObjectURL, f.original.revoke);
  assert.equal(f.urls.has(worker.url), false);
  assert.equal(f.timers.size, 0);
  assert.equal(new Worker(url).url, url);
  assert.equal(worker.url.startsWith("blob:"), true, "cleanup does not terminate active workers");
  const another = fixture();
  const external = function () {};
  another.root.Worker = external;
  another.cleanup();
  assert.equal(another.root.Worker, external, "later changes by another component are kept");
  const flags = fixture(), wrapper = flags.root.URL.createObjectURL;
  Object.defineProperty(flags.root.URL, "createObjectURL", { writable: false });
  flags.cleanup();
  assert.equal(flags.root.URL.createObjectURL, wrapper);
  assert.equal(Object.getOwnPropertyDescriptor(flags.root.URL, "createObjectURL").writable, false, "later property flags are kept");
});

test("native newTarget is preserved and setup or policy failures remain native", () => {
  const f = fixture(), url = f.root.URL.createObjectURL(new f.root.Blob(["1"], { type: "text/javascript" }));
  class Child extends f.root.Worker {}
  const child = new Child(url);
  assert.ok(child instanceof Child);
  assert.equal(f.calls.at(-1).newTarget, Child);
  f.cleanup();
  const policy = fixture(), policyURL = policy.root.URL.createObjectURL(new policy.root.Blob(["1"], { type: "text/javascript" }));
  policy.setRejectGenerated(true);
  assert.equal(new policy.root.Worker(policyURL).url, policyURL);
  assert.equal(policy.revoked.length, 1);
  policy.cleanup();
});

test("installer is self-contained when serialized into a different realm", () => {
  const f = fixture(); f.cleanup();
  const context = vm.createContext({ root: f.root });
  const cleanup = vm.runInContext(`(${installWorkerLocale.toString()})(root, {timezone:'Asia/Tokyo'}, function(){})`, context);
  const url = f.root.URL.createObjectURL(new f.root.Blob(["1"], { type: "text/javascript" }));
  const worker = new f.root.Worker(url);
  assert.notEqual(worker.url, url);
  cleanup();
});

test("initialization follows explicit directives and keeps strict worker semantics", async () => {
  const f = fixture();
  const source = "/* leading comment */\n'use strict';\n\"another directive\";\ntry { strictLeak = 1; globalThis.wasStrict = false; } catch { globalThis.wasStrict = true; }";
  const url = f.root.URL.createObjectURL(new f.root.Blob([source], { type: "text/javascript" }));
  const worker = new f.root.Worker(url);
  const text = await f.urls.get(worker.url).text();
  assert.ok(text.indexOf("'use strict';") < text.indexOf("function apply"));
  assert.ok(text.indexOf('"another directive";') < text.indexOf("function apply"));
  const context = {};
  vm.runInNewContext(text, context);
  assert.equal(context.wasStrict, true);
  assert.equal(context.workerTestProfile.timezone, "Asia/Tokyo");
  assert.equal(Object.hasOwn(context, "strictLeak"), false);
  f.cleanup();
});

test("BOM, hashbang and comments remain before generated initialization", async () => {
  const f = fixture();
  for (const source of ["\ufeff'use strict';\nglobalThis.ready = true;", "#!/usr/bin/env worker\n// comment\n'use strict';\nglobalThis.ready = true;", "/* comment */\n// next\nglobalThis.ready = true;"]) {
    const url = f.root.URL.createObjectURL(new f.root.Blob([source], { type: "application/javascript" }));
    const worker = new f.root.Worker(url), text = await f.urls.get(worker.url).text();
    const context = {}; vm.runInNewContext(text, context);
    assert.equal(context.ready, true);
    assert.equal(context.workerTestProfile.timezone, "Asia/Tokyo");
  }
  f.cleanup();
});

test("ambiguous directives, custom iterators, holes and object parts are passed through", () => {
  const f = fixture();
  function expectNative(parts, options = { type: "text/javascript" }) {
    const url = f.root.URL.createObjectURL(new f.root.Blob(parts, options));
    assert.equal(new f.root.Worker(url).url, url);
  }
  expectNative(["'use strict'\nglobalThis.ready = true;"]);
  expectNative(["'prefix' + 'expression';"]);
  expectNative(["/* unterminated"]);
  expectNative(["'unterminated"]);
  expectNative(["<!-- legacy comment\n'use strict'; globalThis.ready = true;"]);
  expectNative(new Array(1));
  let reads = 0;
  expectNative([{ toString() { reads++; return "globalThis.ready = true;"; } }]);
  assert.equal(reads, 1);
  let iterations = 0;
  const iterable = ["globalThis.ready = true;"];
  iterable[Symbol.iterator] = function* () { iterations++; yield this[0]; };
  expectNative(iterable);
  assert.equal(iterations, 1);
  const foreign = vm.runInNewContext('["globalThis.ready = true;"]');
  expectNative(foreign);
  f.cleanup();
});

test("Blob options that can mutate parts after conversion are not reconstructed", async () => {
  const f = fixture(), parts = ["globalThis.version = 'original';"];
  let reads = 0;
  const options = { get type() { reads++; parts[0] = "globalThis.version = 'mutated';"; return "text/javascript"; } };
  const blob = new f.root.Blob(parts, options), url = f.root.URL.createObjectURL(blob);
  assert.equal(new f.root.Worker(url).url, url);
  assert.equal(reads, 1);
  assert.match(await blob.text(), /original/);
  class ChildBlob extends f.root.Blob {}
  const child = new ChildBlob(["globalThis.child = true;"], { type: "text/javascript" });
  assert.ok(child instanceof ChildBlob);
  const childURL = f.root.URL.createObjectURL(child);
  assert.equal(new f.root.Worker(childURL).url, childURL);
  f.cleanup();
});

test("Blob accessors are not read again and native endings are left unchanged", () => {
  const f = fixture();
  let partReads = 0, endingsReads = 0;
  const parts = [];
  Object.defineProperty(parts, "0", { configurable: true, enumerable: true, get() { partReads++; return "globalThis.ready = true;"; } });
  const first = f.root.URL.createObjectURL(new f.root.Blob(parts, { type: "text/javascript" }));
  assert.equal(new f.root.Worker(first).url, first);
  assert.equal(partReads, 1);
  const options = { type: "text/javascript", get endings() { endingsReads++; return "transparent"; } };
  const second = f.root.URL.createObjectURL(new f.root.Blob(["globalThis.ready = true;"], options));
  assert.equal(new f.root.Worker(second).url, second);
  assert.equal(endingsReads, 1);
  const third = f.root.URL.createObjectURL(new f.root.Blob(["globalThis.ready = true;"], { type: "text/javascript", endings: "native" }));
  assert.equal(new f.root.Worker(third).url, third);
  f.cleanup();
});

test("captured strings preserve per-part Unicode conversion and enforce byte limits", async () => {
  const f = fixture();
  const original = new f.root.Blob(["globalThis.part = '", "\ud800", "\udc00", "';"], { type: "text/javascript" });
  const url = f.root.URL.createObjectURL(original), worker = new f.root.Worker(url);
  const context = {}; vm.runInNewContext(await f.urls.get(worker.url).text(), context);
  assert.equal(context.part, "\ufffd\ufffd");
  const huge = f.root.URL.createObjectURL(new f.root.Blob(["//" + "汉".repeat(400000)], { type: "text/javascript" }));
  assert.equal(new f.root.Worker(huge).url, huge);
  f.cleanup();
});

test("default Trusted Types policies get the original URL exactly once", () => {
  const f = fixture(), url = f.root.URL.createObjectURL(new f.root.Blob(["globalThis.ready = true;"], { type: "text/javascript" }));
  f.root.trustedTypes = { defaultPolicy: {} };
  const worker = new f.root.Worker(url);
  assert.equal(worker.url, url);
  assert.equal(f.calls.length, 1);
  assert.equal(f.urls.size, 1);
  f.cleanup();
});

test("native TypeError rejects once without repeating the Trusted Types sink", () => {
  const f = fixture(), url = f.root.URL.createObjectURL(new f.root.Blob(["globalThis.ready = true;"], { type: "text/javascript" }));
  f.setRejectGenerated("type");
  assert.throws(() => new f.root.Worker(url), /TrustedScriptURL required/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.revoked.length, 1);
  f.cleanup();
});

test("Proxy Blob parts with native-looking descriptors preserve their actual iteration bytes", async () => {
  const f = fixture();
  const parts = new Proxy(["globalThis.source = 'descriptor';"], {
    get(target, key, receiver) {
      if (key === Symbol.iterator) return function* () { yield "globalThis.source = 'iterator';"; };
      return Reflect.get(target, key, receiver);
    }
  });
  const blob = new f.root.Blob(parts, { type: "text/javascript" });
  const url = f.root.URL.createObjectURL(blob);
  assert.equal(await blob.text(), "globalThis.source = 'iterator';");
  assert.equal(new f.root.Worker(url).url, url);
  f.cleanup();
});

test("Proxy Blob options and unrelated option accessors are passed through", async () => {
  const f = fixture(), parts = ["globalThis.source = 'original';"];
  const options = new Proxy({ type: "text/javascript" }, {
    get(target, key, receiver) {
      if (key === "type") parts[0] = "globalThis.source = 'changed';";
      return Reflect.get(target, key, receiver);
    }
  });
  const blob = new f.root.Blob(parts, options), url = f.root.URL.createObjectURL(blob);
  assert.equal(await blob.text(), "globalThis.source = 'original';");
  assert.equal(new f.root.Worker(url).url, url);
  let unrelatedReads = 0;
  const accessorOptions = { type: "text/javascript", get unrelated() { unrelatedReads++; return "unused"; } };
  const accessorURL = f.root.URL.createObjectURL(new f.root.Blob(["globalThis.ready = true;"], accessorOptions));
  assert.equal(new f.root.Worker(accessorURL).url, accessorURL);
  assert.equal(unrelatedReads, 0);
  f.cleanup();
});
