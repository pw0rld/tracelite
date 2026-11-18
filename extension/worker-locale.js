// Only default classic Workers backed by a JavaScript Blob whose source was
// safely captured in this realm are considered. Unsupported inputs are passed
// through. The generated worker still has a different location.href.
export function installWorkerLocale(root, profile, applyPageLocale) {
  "use strict";
  const NativeWorker = root.Worker, NativeBlob = root.Blob, NativeURL = root.URL;
  const WeakReference = root.WeakRef, nativeClone = root.structuredClone;
  if (typeof NativeWorker !== "function" || typeof NativeBlob !== "function"
    || typeof NativeURL?.createObjectURL !== "function" || typeof NativeURL.revokeObjectURL !== "function"
    || typeof WeakReference !== "function" || typeof nativeClone !== "function") return () => {};
  const createDescriptor = Object.getOwnPropertyDescriptor(NativeURL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(NativeURL, "revokeObjectURL");
  const workerDescriptor = Object.getOwnPropertyDescriptor(root, "Worker");
  const blobDescriptor = Object.getOwnPropertyDescriptor(root, "Blob");
  const typeGetter = Object.getOwnPropertyDescriptor(NativeBlob.prototype, "type")?.get;
  if (!createDescriptor?.configurable || !revokeDescriptor?.configurable || !workerDescriptor?.configurable
    || !blobDescriptor?.configurable || typeof typeGetter !== "function" || !root.Array || !root.Object) return () => {};
  const nativeCreate = createDescriptor.value, nativeRevoke = revokeDescriptor.value;
  const arrayPrototype = root.Array.prototype, objectPrototype = root.Object.prototype;
  const arrayIterator = Object.getOwnPropertyDescriptor(arrayPrototype, Symbol.iterator)?.value;
  if (typeof arrayIterator !== "function" || arrayIterator !== arrayPrototype.values) return () => {};
  const stringifyFunction = root.Function.prototype.toString;
  let prelude;
  try { prelude = `\n;(${Reflect.apply(stringifyFunction, applyPageLocale, [])})(${JSON.stringify(profile)});\n`; }
  catch { return () => {}; }
  const sources = new WeakMap(), blobs = new Map(), resources = new Set(), replacements = [];
  let active = true;
  const allowedTypes = new Set(["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);
  const textLimit = 1024 * 1024;
  // Finding a safe insertion point does not require evaluating any source. A
  // string without an explicit semicolon may rely on ASI or start an expression;
  // that ambiguity makes the whole worker ineligible instead of guessing.
  function insertionPoint(text) {
    let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
    if (text.slice(index, index + 2) === "#!") {
      while (index < text.length && !/[\r\n\u2028\u2029]/.test(text[index])) index++;
    }
    function trivia() {
      while (index < text.length) {
        if (/\s/.test(text[index])) { index++; continue; }
        if (text.slice(index, index + 2) === "//") {
          index += 2;
          while (index < text.length && !/[\r\n\u2028\u2029]/.test(text[index])) index++;
          continue;
        }
        if (text.slice(index, index + 2) === "/*") {
          const end = text.indexOf("*/", index + 2);
          if (end < 0) return false;
          index = end + 2; continue;
        }
        break;
      }
      return true;
    }
    while (trivia()) {
      // Annex B HTML-like comments can participate in a directive prologue in
      // classic scripts. Do not guess their line-position-dependent grammar.
      if (text.slice(index, index + 4) === "<!--" || text.slice(index, index + 3) === "-->") return null;
      const quote = text[index];
      if (quote !== "'" && quote !== '"') return index;
      index++;
      let closed = false;
      while (index < text.length) {
        const character = text[index++];
        if (character === quote) { closed = true; break; }
        if (/[\r\n\u2028\u2029]/.test(character)) return null;
        if (character === "\\") {
          const escaped = text[index++];
          if (escaped === "\r" && text[index] === "\n") index++;
        }
      }
      if (!closed || !trivia() || text[index] !== ";") return null;
      index++;
    }
    return null;
  }
  function capturedText(args) {
    const parts = args[0], options = args[1];
    if (!root.Array.isArray(parts) || Object.getPrototypeOf(parts) !== arrayPrototype) return null;
    const iterator = Object.getOwnPropertyDescriptor(parts, Symbol.iterator);
    if (iterator && (!Object.hasOwn(iterator, "value") || iterator.value !== arrayIterator)) return null;
    if (Object.getOwnPropertyDescriptor(arrayPrototype, Symbol.iterator)?.value !== arrayIterator) return null;
    const length = Object.getOwnPropertyDescriptor(parts, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 16384) return null;
    const keys = Reflect.ownKeys(parts);
    if (keys.some(key => key !== "length" && key !== Symbol.iterator
      && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) return null;
    for (let i = 0; i < length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(parts, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") return null;
    }
    // Native newline conversion can change template literal raw strings. Only
    // transparent endings with ordinary option records can be captured safely.
    if (options !== undefined) {
      if (!options || typeof options !== "object") return null;
      const prototype = Object.getPrototypeOf(options);
      if (prototype !== objectPrototype && prototype !== null) return null;
      if (Reflect.ownKeys(options).some(key => key !== "type" && key !== "endings")) return null;
      const endings = Object.getOwnPropertyDescriptor(options, "endings");
      if (endings && (!Object.hasOwn(endings, "value") || endings.value !== "transparent")) return null;
      if (!endings && prototype && Object.getOwnPropertyDescriptor(prototype, "endings")) return null;
      // A type getter/object conversion could have mutated parts after native
      // sequence conversion. It would then be unsafe to reconstruct its bytes.
      const type = Object.getOwnPropertyDescriptor(options, "type");
      if (type && (!Object.hasOwn(type, "value") || typeof type.value !== "string")) return null;
      if (!type && prototype && Object.getOwnPropertyDescriptor(prototype, "type")) return null;
      // Descriptors cannot prove an object is not a Proxy. Native structured
      // cloning rejects Proxy inputs without trusting their reported shape.
      Reflect.apply(nativeClone, root, [options]);
    }
    // Extra accessors were excluded above, so cloning an ordinary dense string
    // array cannot invoke additional page getters. A Proxy is not cloneable.
    const copiedParts = Reflect.apply(nativeClone, root, [parts]);
    let text = "";
    for (let i = 0; i < length; i++) {
      // Blob converts each part to a Unicode scalar-value string separately.
      // Keep lone-surrogate replacement even at boundaries between parts.
      const part = copiedParts[i];
      if (text.length + part.length > textLimit) return null;
      for (let j = 0; j < part.length; j++) {
        const code = part.charCodeAt(j);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = part.charCodeAt(j + 1);
          if (next >= 0xdc00 && next <= 0xdfff) text += part[j] + part[++j];
          else text += "\ufffd";
        } else text += code >= 0xdc00 && code <= 0xdfff ? "\ufffd" : part[j];
      }
    }
    // Bound UTF-8 bytes too, without depending on TextEncoder availability.
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? (++i, 4) : 3;
      if (bytes > textLimit) return null;
    }
    const point = insertionPoint(text);
    return point === null ? null : { text, point };
  }
  const Blob = new Proxy(NativeBlob, {
    construct(target, args, newTarget) {
      const blob = Reflect.construct(target, args, newTarget);
      // Exotic newTarget.prototype lookups can mutate the argument array while
      // the native constructor is allocating. Only the ordinary constructor's
      // own results can be reconstructed without observing that behavior.
      if (active && (newTarget === Blob || newTarget === NativeBlob)) {
        try { const source = capturedText(args); if (source) sources.set(blob, source); } catch {}
      }
      return blob;
    }
  });
  const release = entry => {
    if (!resources.delete(entry)) return;
    if (entry.timer !== undefined) root.clearTimeout(entry.timer);
    try { Reflect.apply(nativeRevoke, NativeURL, [entry.url]); } catch {}
  };
  const remember = (url, blob) => {
    try {
      if (!sources.has(blob)) return;
      const type = Reflect.apply(typeGetter, blob, []);
      if (!allowedTypes.has(type.toLowerCase().split(";", 1)[0].trim())) return;
      blobs.delete(url);
      blobs.set(url, { blob: new WeakReference(blob), type });
      if (blobs.size > 128) blobs.delete(blobs.keys().next().value);
    } catch { /* The original URL operation already validated its argument. */ }
  };
  const create = new Proxy(nativeCreate, {
    apply(target, receiver, args) {
      const url = Reflect.apply(target, receiver, args);
      if (active && typeof url === "string") remember(url, args[0]);
      return url;
    }
  });
  const revoke = new Proxy(nativeRevoke, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (typeof args[0] === "string") blobs.delete(args[0]);
      return result;
    }
  });
  const Worker = new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      // Do not inspect URL objects, TrustedScriptURL or options getters. Native
      // conversion, module selection, CSP and Trusted Types remain in charge.
      if (!active || typeof args[0] !== "string" || args[1] !== undefined || resources.size >= 128)
        return Reflect.construct(target, args, newTarget);
      // A default Trusted Types policy can transform or reject URL strings.
      // Preserve its original URL and call count instead of trying a new URL.
      if (root.trustedTypes?.defaultPolicy) return Reflect.construct(target, args, newTarget);
      const saved = blobs.get(args[0]);
      const blob = saved?.blob.deref();
      if (!blob) { blobs.delete(args[0]); return Reflect.construct(target, args, newTarget); }
      const source = sources.get(blob);
      if (!source) return Reflect.construct(target, args, newTarget);
      let entry;
      try {
        const text = source.text.slice(0, source.point) + prelude + source.text.slice(source.point);
        const combined = new NativeBlob([text], { type: saved.type });
        entry = { url: Reflect.apply(nativeCreate, NativeURL, [combined]), timer: undefined };
        resources.add(entry);
        const copied = args.slice(); copied[0] = entry.url;
        const worker = Reflect.construct(target, copied, newTarget);
        // This bounded grace period avoids relying on immediate URL revocation
        // while a worker's script fetch is starting. It is not a load timeout.
        entry.timer = root.setTimeout(() => release(entry), 30000);
        if (typeof worker.addEventListener === "function") {
          worker.addEventListener("message", () => release(entry), { once: true });
          worker.addEventListener("error", () => release(entry), { once: true });
        }
        return worker;
      } catch (error) {
        if (entry) release(entry);
        // In particular, do not invoke an enforced Trusted Types sink twice.
        if (error instanceof TypeError || (typeof root.TypeError === "function" && error instanceof root.TypeError)) throw error;
        // Preserve a native policy error or valid original worker. Never weaken
        // CSP/Trusted Types and never replace a rejected worker with a fake one.
        return Reflect.construct(target, args, newTarget);
      }
    }
  });
  function replace(owner, name, descriptor, value) {
    const installed = { ...descriptor, value };
    Object.defineProperty(owner, name, installed);
    replacements.push({ owner, name, descriptor, installed });
  }
  function restore(item) {
    const current = Object.getOwnPropertyDescriptor(item.owner, item.name);
    if (current && ["value", "get", "set", "writable", "enumerable", "configurable"].every(key => current[key] === item.installed[key])) {
      Object.defineProperty(item.owner, item.name, item.descriptor);
    }
  }
  try {
    replace(NativeURL, "createObjectURL", createDescriptor, create);
    replace(NativeURL, "revokeObjectURL", revokeDescriptor, revoke);
    replace(root, "Blob", blobDescriptor, Blob);
    replace(root, "Worker", workerDescriptor, Worker);
    const constructor = Object.getOwnPropertyDescriptor(NativeWorker.prototype, "constructor");
    if (constructor?.configurable && constructor.value === NativeWorker) replace(NativeWorker.prototype, "constructor", constructor, Worker);
    const blobConstructor = Object.getOwnPropertyDescriptor(NativeBlob.prototype, "constructor");
    if (blobConstructor?.configurable && blobConstructor.value === NativeBlob) replace(NativeBlob.prototype, "constructor", blobConstructor, Blob);
  } catch {
    active = false;
    for (const item of replacements.reverse()) {
      try { restore(item); } catch {}
    }
    return () => {};
  }
  return function cleanup() {
    if (!active) return;
    active = false; blobs.clear();
    for (const entry of [...resources]) release(entry);
    for (const item of replacements.reverse()) {
      try { restore(item); } catch {}
    }
  };
}
