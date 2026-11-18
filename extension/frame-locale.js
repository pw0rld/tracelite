// Self-contained so the page-world bundle can embed this function directly.
// Only same-origin frames are offered to the caller; policy and document-level
// deduplication remain the caller's responsibility.
export function installFrameLocale(root, applyToFrame) {
  "use strict";
  let active = true;
  const installed = [], notifying = new WeakSet();
  const frameProto = root.HTMLIFrameElement?.prototype;
  const nodeProto = root.Node?.prototype;
  const elementProto = root.Element?.prototype;
  const fragmentProto = root.DocumentFragment?.prototype;
  const documentProto = root.Document?.prototype;
  const document = root.document;
  const windowDescriptor = frameProto && Object.getOwnPropertyDescriptor(frameProto, "contentWindow");
  const documentDescriptor = frameProto && Object.getOwnPropertyDescriptor(frameProto, "contentDocument");
  const getWindow = windowDescriptor?.get;
  const getNodeType = nodeProto && Object.getOwnPropertyDescriptor(nodeProto, "nodeType")?.get;
  const getLocalName = elementProto && Object.getOwnPropertyDescriptor(elementProto, "localName")?.get;
  const queries = {
    1: elementProto && Object.getOwnPropertyDescriptor(elementProto, "querySelectorAll")?.value,
    9: documentProto && Object.getOwnPropertyDescriptor(documentProto, "querySelectorAll")?.value,
    11: fragmentProto && Object.getOwnPropertyDescriptor(fragmentProto, "querySelectorAll")?.value
  };
  let observer = null, loadListener = null;
  const addListener = document?.addEventListener;
  const removeListener = document?.removeEventListener;
  const disconnectObserver = root.MutationObserver?.prototype?.disconnect;

  function disconnect() {
    if (!observer) return;
    try { if (typeof disconnectObserver === "function") Reflect.apply(disconnectObserver, observer, []); } catch {}
    observer = null;
  }

  function notify(window) {
    if (!active || !window || window === root || notifying.has(window)) return;
    try {
      // Accessing an opaque/cross-origin WindowProxy throws here. Do not ask
      // the caller to inspect or modify a context the parent cannot access.
      if (!window.document) return;
      notifying.add(window);
      try { applyToFrame(window); } finally { notifying.delete(window); }
    } catch { /* Applying a locale must not change a DOM API's result/error. */ }
  }
  function notifyFrame(frame) {
    if (!active || typeof getWindow !== "function") return;
    try { notify(Reflect.apply(getWindow, frame, [])); } catch { /* Not a frame. */ }
  }
  function framesIn(node, output) {
    if (!active || !node || typeof getNodeType !== "function") return;
    let kind;
    try { kind = Reflect.apply(getNodeType, node, []); } catch { return; }
    if (kind === 1 && typeof getLocalName === "function") {
      try { if (Reflect.apply(getLocalName, node, []) === "iframe") output.add(node); } catch {}
    }
    const query = queries[kind];
    if (typeof query !== "function") return;
    try {
      for (const frame of Reflect.apply(query, node, ["iframe"])) output.add(frame);
    } catch { /* Native query methods reject values of the wrong DOM type. */ }
  }
  function notifyAll(frames) { if (active) for (const frame of frames) notifyFrame(frame); }
  function patch(owner, key, field, wrapper) {
    if (!owner) return;
    const before = Object.getOwnPropertyDescriptor(owner, key);
    if (!before || (field !== "value" && !before.configurable)
      || (field === "value" && !before.configurable && !before.writable)) return;
    const after = { ...before, [field]: wrapper };
    try {
      Object.defineProperty(owner, key, after);
      installed.push({ owner, key, before, after });
    } catch { /* Frozen/locked-down page: leave its API alone. */ }
  }
  if (typeof getWindow === "function") {
    patch(frameProto, "contentWindow", "get", new Proxy(getWindow, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        notify(result);
        return result;
      }
    }));
  }
  if (typeof documentDescriptor?.get === "function") {
    patch(frameProto, "contentDocument", "get", new Proxy(documentDescriptor.get, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        // The original getter has already checked the receiver and access.
        if (result) notifyFrame(receiver);
        return result;
      }
    }));
  }
  function insertion(owner, key, allArguments) {
    const target = owner && Object.getOwnPropertyDescriptor(owner, key)?.value;
    if (typeof target !== "function") return;
    patch(owner, key, "value", new Proxy(target, {
      apply(fn, receiver, args) {
        if (!active) return Reflect.apply(fn, receiver, args);
        const frames = new Set();
        // Capture descendants before native insertion empties a fragment.
        // This examines only the inserted subtree, never the whole document.
        const count = allArguments ? args.length : Math.min(args.length, 1);
        for (let index = 0; index < count; index++) framesIn(args[index], frames);
        const result = Reflect.apply(fn, receiver, args);
        notifyAll(frames);
        return result;
      }
    }));
  }
  for (const key of ["appendChild", "insertBefore", "replaceChild"]) insertion(nodeProto, key, false);
  for (const owner of [elementProto, fragmentProto, documentProto]) {
    for (const key of ["append", "prepend", "replaceChildren"]) insertion(owner, key, true);
  }
  const html = elementProto && Object.getOwnPropertyDescriptor(elementProto, "innerHTML");
  if (typeof html?.set === "function") patch(elementProto, "innerHTML", "set", new Proxy(html.set, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (active) { const frames = new Set(); framesIn(receiver, frames); notifyAll(frames); }
      return result;
    }
  }));
  if (document) {
    try {
      if (typeof root.MutationObserver === "function") {
        observer = new root.MutationObserver(records => {
          if (!active) return;
          const frames = new Set();
          for (const record of records) for (const node of record.addedNodes) framesIn(node, frames);
          notifyAll(frames);
        });
        observer.observe(document, { childList: true, subtree: true });
      }
    } catch { disconnect(); }
    if (typeof addListener === "function") {
      loadListener = event => { if (active) notifyFrame(event.target); };
      try { Reflect.apply(addListener, document, ["load", loadListener, true]); }
      catch { loadListener = null; }
    }
    // Existing frames are scanned once at installation, then only inserted
    // subtrees/load targets are checked.
    const existing = new Set(); framesIn(document, existing); notifyAll(existing);
  }
  return function cleanup() {
    if (!active) return;
    active = false;
    disconnect();
    if (loadListener && typeof removeListener === "function") {
      try { Reflect.apply(removeListener, document, ["load", loadListener, true]); } catch {}
    }
    loadListener = null;
    for (const { owner, key, before, after } of installed.reverse()) {
      const current = Object.getOwnPropertyDescriptor(owner, key);
      // Another script may have replaced only one accessor or a flag. Never
      // overwrite such a newer change with the old whole descriptor.
      if (!current || ["value", "get", "set", "writable", "enumerable", "configurable"].some(name => current[name] !== after[name])) continue;
      try { Object.defineProperty(owner, key, before); } catch {}
    }
    installed.length = 0;
  };
}
