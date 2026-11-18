import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installFrameLocale } from "../extension/frame-locale.js";

// A small authored DOM model: no site code, network, or DOM package is used.
function fixture() {
  const kinds = new WeakMap(), names = new WeakMap(), windows = new WeakMap();
  class Node {
    constructor(kind) { kinds.set(this, kind); this.children = []; }
    get nodeType() { if (!kinds.has(this)) throw new TypeError("Illegal invocation"); return kinds.get(this); }
    appendChild(node) {
      if (!kinds.has(this) || !kinds.has(node)) throw new TypeError("Invalid node");
      if (node.nodeType === 11) { this.children.push(...node.children); node.children = []; }
      else this.children.push(node);
      return node;
    }
    insertBefore(node) { return Node.prototype.appendChild.call(this, node); }
    replaceChild(node, old) {
      const index = this.children.indexOf(old);
      if (index < 0) throw new Error("Not found");
      this.children.splice(index, 1);
      Node.prototype.appendChild.call(this, node);
      return old;
    }
  }
  const query = function () {
    if (!kinds.has(this)) throw new TypeError("Invalid node");
    const result = [];
    const visit = node => {
      for (const child of node.children) { if (names.get(child) === "iframe") result.push(child); visit(child); }
    };
    visit(this); return result;
  };
  const append = function (...nodes) { for (const node of nodes) if (kinds.has(node)) Node.prototype.appendChild.call(this, node); };
  const prepend = function (...nodes) {
    const existing = this.children; this.children = [];
    append.apply(this, nodes); this.children.push(...existing);
  };
  const replace = function (...nodes) { this.children = []; append.apply(this, nodes); };
  class Element extends Node {
    constructor(name = "div") { super(1); names.set(this, name); }
    get localName() { if (!names.has(this)) throw new TypeError("Invalid element"); return names.get(this); }
    querySelectorAll(selector) { return query.call(this, selector); }
    append(...nodes) { append.apply(this, nodes); }
    prepend(...nodes) { prepend.apply(this, nodes); }
    replaceChildren(...nodes) { replace.apply(this, nodes); }
    set innerHTML(value) {
      if (!names.has(this)) throw new TypeError("Invalid element");
      this.children = value === "iframe" ? [new HTMLIFrameElement()] : [];
    }
  }
  class HTMLIFrameElement extends Element {
    constructor(window = { document: {} }) { super("iframe"); windows.set(this, window); }
    get contentWindow() { if (!windows.has(this)) throw new TypeError("Illegal invocation"); return windows.get(this); }
    get contentDocument() {
      if (!windows.has(this)) throw new TypeError("Illegal invocation");
      try { return windows.get(this)?.document || null; } catch { return null; }
    }
  }
  class DocumentFragment extends Node {
    constructor() { super(11); }
    querySelectorAll(selector) { return query.call(this, selector); }
    append(...nodes) { append.apply(this, nodes); }
    prepend(...nodes) { prepend.apply(this, nodes); }
    replaceChildren(...nodes) { replace.apply(this, nodes); }
  }
  const listeners = new Map();
  class Document extends Node {
    constructor() { super(9); }
    querySelectorAll(selector) { return query.call(this, selector); }
    append(...nodes) { append.apply(this, nodes); }
    prepend(...nodes) { prepend.apply(this, nodes); }
    replaceChildren(...nodes) { replace.apply(this, nodes); }
    addEventListener(name, callback) { listeners.set(name, callback); }
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); }
  }
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); this.connected = false; }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const document = new Document();
  const root = { Node, Element, HTMLIFrameElement, DocumentFragment, Document, MutationObserver, document };
  return { root, document, listeners, observers, Node, Element, HTMLIFrameElement, DocumentFragment, windows };
}

test("self-contained frame installer preserves getter errors and exact values", () => {
  const f = fixture(), seen = [];
  const ownWindow = { document: {} }, frame = new f.HTMLIFrameElement(ownWindow);
  const install = vm.runInNewContext("(" + installFrameLocale.toString() + ")");
  const cleanup = install(f.root, window => seen.push(window));
  assert.equal(frame.contentWindow, ownWindow);
  assert.equal(frame.contentDocument, ownWindow.document);
  assert.deepEqual(seen, [ownWindow, ownWindow]);
  const getter = Object.getOwnPropertyDescriptor(f.HTMLIFrameElement.prototype, "contentWindow").get;
  assert.throws(() => getter.call({}), TypeError);
  cleanup();
});

test("cross-origin frames and callback failures leave native DOM behavior intact", () => {
  const f = fixture(), cross = { get document() { throw new Error("SecurityError"); } };
  let calls = 0;
  const cleanup = installFrameLocale(f.root, () => { calls++; throw new Error("locale failure"); });
  const crossFrame = new f.HTMLIFrameElement(cross);
  assert.equal(crossFrame.contentWindow, cross);
  assert.equal(crossFrame.contentDocument, null);
  assert.equal(calls, 0);
  const frame = new f.HTMLIFrameElement();
  assert.doesNotThrow(() => frame.contentWindow);
  assert.equal(calls, 1);
  cleanup();
});

test("fragment frames are captured before native insertion empties the fragment", () => {
  const f = fixture(), seen = new Set();
  const holder = new f.Element(), fragment = new f.DocumentFragment();
  const first = new f.HTMLIFrameElement(), nested = new f.Element(), second = new f.HTMLIFrameElement();
  nested.appendChild(second); fragment.append(first, nested);
  const cleanup = installFrameLocale(f.root, window => seen.add(window));
  assert.equal(holder.appendChild(fragment), fragment);
  assert.equal(fragment.children.length, 0);
  assert.equal(seen.size, 2);
  assert.ok(seen.has(f.windows.get(first))); assert.ok(seen.has(f.windows.get(second)));
  cleanup();
});

test("append/prepend/replaceChildren and innerHTML report inserted subtrees", () => {
  const f = fixture(), seen = new Set(), container = new f.Element();
  const cleanup = installFrameLocale(f.root, window => seen.add(window));
  for (const method of ["append", "prepend", "replaceChildren"]) {
    const frame = new f.HTMLIFrameElement(); container[method]("text", frame);
    assert.ok(seen.has(f.windows.get(frame)));
  }
  container.innerHTML = "iframe";
  assert.ok(seen.has(f.windows.get(container.children[0])));
  cleanup();
});

test("observer and load fallback scan added subtrees and stop on cleanup", () => {
  const f = fixture(), seen = [];
  const cleanup = installFrameLocale(f.root, window => seen.push(window));
  const added = new f.HTMLIFrameElement();
  f.observers[0].callback([{ addedNodes: [added] }]);
  f.listeners.get("load")({ target: added });
  assert.equal(seen.length, 2);
  cleanup();
  assert.equal(f.observers[0].connected, false); assert.equal(f.listeners.size, 0);
  f.observers[0].callback([{ addedNodes: [new f.HTMLIFrameElement()] }]);
  assert.equal(seen.length, 2);
});

test("cleanup restores only descriptors still wholly owned by this installer", () => {
  const f = fixture(), seen = [];
  const original = Object.getOwnPropertyDescriptor(f.HTMLIFrameElement.prototype, "contentWindow");
  const originalAppend = f.Node.prototype.appendChild;
  const cleanup = installFrameLocale(f.root, window => seen.push(window));
  const wrapper = Object.getOwnPropertyDescriptor(f.HTMLIFrameElement.prototype, "contentWindow").get;
  // A later extension changes just one descriptor flag. Preserve its change.
  Object.defineProperty(f.HTMLIFrameElement.prototype, "contentWindow", { enumerable: !original.enumerable });
  const frame = new f.HTMLIFrameElement(); cleanup(); cleanup();
  assert.equal(f.Node.prototype.appendChild, originalAppend);
  assert.equal(Object.getOwnPropertyDescriptor(f.HTMLIFrameElement.prototype, "contentWindow").get, wrapper);
  assert.equal(frame.contentWindow, f.windows.get(frame));
  assert.equal(seen.length, 0, "remaining wrapper is inert after cleanup");
});

test("failed native insertions do not run the frame callback", () => {
  const f = fixture(), seen = [];
  const cleanup = installFrameLocale(f.root, window => seen.push(window));
  const frame = new f.HTMLIFrameElement();
  assert.throws(() => f.Node.prototype.appendChild.call({}, frame), TypeError);
  assert.equal(seen.length, 0);
  cleanup();
});

test("reentrant locale application is bounded for the same window", () => {
  const f = fixture(), frame = new f.HTMLIFrameElement(); let calls = 0;
  const cleanup = installFrameLocale(f.root, () => { calls++; void frame.contentWindow; });
  void frame.contentWindow;
  assert.equal(calls, 1);
  cleanup();
});
