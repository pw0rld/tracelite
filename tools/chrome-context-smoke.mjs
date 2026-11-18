// Only authored local pages and a disposable Chrome profile are used. This
// does not execute third-party detection code or access a daily Chrome profile.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "extension/page-context.js"), "utf8");
const directory = await mkdtemp(path.join(tmpdir(), "privacy-context-"));
const workerSource = '"use strict";\nfunction read(){return {language:navigator.language,languages:[...navigator.languages],timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,location:location.href,strict:(function(){return this})()===undefined,name:self.name};}\nonmessage=()=>postMessage(read());postMessage(read());';
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url === "/worker.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(workerSource); return;
  }
  if (request.url === "/csp") response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; worker-src blob:");
  if (request.url === "/trusted") response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; worker-src blob:; require-trusted-types-for 'script'; trusted-types 'none'");
  response.setHeader("Content-Type", "text/html");
  response.end("<!doctype html><title>Local context checks</title><body>Local context checks</body>");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--user-data-dir=${directory}`, "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication", "--proxy-server=http://127.0.0.1:9",
  "--proxy-bypass-list=127.0.0.1", "about:blank"
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
const pending = new Map(), report = { scope: "Local iframe, limited Blob Worker, native fallback and stop-propagation checks", checks: [] };
let id = 0, buffer = "", stderr = "";
chrome.stderr.on("data", value => { stderr = (stderr + value).slice(-3000); });
chrome.stdio[4].on("data", data => {
  buffer += data.toString(); let end;
  while ((end = buffer.indexOf("\0")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const entry = pending.get(message.id); if (!entry) continue;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(method + " timed out: " + stderr)); }, 10000);
  pending.set(next, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = { timezone: "Asia/Tokyo", locale: "ja-JP", languages: ["ja-JP", "ja"] };
const reading = "({language:navigator.language,languages:[...navigator.languages],timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})";
const check = (name, result = true) => { report.checks.push({ name, result }); console.log("PASS:", name); };

async function open(route = "/") {
  const { targetId } = await cdp("Target.createTarget", { url: base + route });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async expression => {
    const answer = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails));
    return answer.result.value;
  };
  for (let i = 0; i < 40 && !(await evaluate("!!document.body")); i++) await delay(50);
  const native = await evaluate(reading), controlEvent = randomUUID();
  const apply = () => evaluate(source.replace("export function", "function") + `\napplyPageContext(${JSON.stringify(profile)},${JSON.stringify(controlEvent)});`);
  return { targetId, evaluate, native, controlEvent, apply };
}

async function frames(navigateUrl) {
  const read = target => ({ language: target.navigator.language, languages: [...target.navigator.languages],
    timezone: target.Intl.DateTimeFormat().resolvedOptions().timeZone,
    ownArray: target.navigator.languages instanceof target.Array,
    ownArrayPrototype: Object.getPrototypeOf(target.navigator.languages) === target.Array.prototype });
  const first = document.createElement("iframe"); document.body.appendChild(first);
  const output = { blank: read(first.contentWindow), viaFrames: read(window.frames[window.frames.length - 1]) };
  const nested = first.contentDocument.createElement("iframe"); first.contentDocument.body.appendChild(nested);
  output.nested = read(nested.contentWindow);
  const fragment = document.createDocumentFragment(), fragmented = document.createElement("iframe");
  fragment.appendChild(fragmented); document.body.appendChild(fragment);
  output.fragment = read(fragmented.contentWindow);
  const container = document.createElement("div"); document.body.appendChild(container);
  container.innerHTML = "<iframe></iframe>"; output.html = read(container.firstElementChild.contentWindow);
  const windowIdentity = first.contentWindow, documentIdentity = first.contentDocument;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("iframe navigation timed out")), 2500);
    first.addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
    first.src = navigateUrl;
  });
  output.navigated = read(first.contentWindow);
  output.windowIdentityRetained = first.contentWindow === windowIdentity;
  output.documentChanged = first.contentDocument !== documentIdentity;
  const sandboxed = document.createElement("iframe"); sandboxed.sandbox = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sandbox iframe timed out")), 2500);
    sandboxed.addEventListener("load", () => { clearTimeout(timer); resolve(); }, { once: true });
    sandboxed.srcdoc = "<!doctype html><title>Opaque local frame</title>"; document.body.appendChild(sandboxed);
  });
  try { void sandboxed.contentWindow.document.body; output.sandboxError = null; }
  catch (error) { output.sandboxError = error.name; }
  first.remove(); fragmented.remove(); container.remove(); sandboxed.remove();
  return output;
}

async function workerProbe(code, options = {}) {
  const { mode = "blob", keep = false } = options;
  let objectUrl, worker, typeReads = 0, nameReads = 0;
  try {
    if (mode !== "http") objectUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    if (mode === "revoked") URL.revokeObjectURL(objectUrl);
    const opts = mode === "module" ? { type: "module" } : mode === "options" ? {
      get type() { typeReads++; return "classic"; }, get name() { nameReads++; return "local-probe"; }
    } : undefined;
    worker = opts === undefined ? new Worker(mode === "http" ? "/worker.js" : objectUrl) : new Worker(objectUrl, opts);
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ timeout: true }), 2500);
      worker.addEventListener("message", event => { clearTimeout(timer); resolve({ value: event.data }); }, { once: true });
      worker.addEventListener("error", event => { event.preventDefault(); clearTimeout(timer); resolve({ error: "WorkerError" }); }, { once: true });
    });
    if (keep && result.value) { globalThis.keptWorker = worker; globalThis.keptWorkerUrl = objectUrl; }
    else worker.terminate();
    return { ...result, objectUrl, typeReads, nameReads };
  } catch (error) { worker?.terminate(); return { error: error.name, typeReads, nameReads }; }
  finally { if (objectUrl && !keep) URL.revokeObjectURL(objectUrl); }
}

const sameReadings = (actual, expected, label) => {
  assert.equal(actual.language, expected.language ?? expected.locale, label + " language");
  assert.deepEqual(actual.languages, expected.languages, label + " language order");
  assert.equal(actual.timezone, expected.timezone, label + " timezone");
};

try {
  report.browser = (await cdp("Browser.getVersion")).product;
  const page = await open();
  const baselineOptions = await page.evaluate(`(${workerProbe.toString()})(${JSON.stringify(workerSource)},{mode:'options'})`);
  assert.ok(baselineOptions.value);
  await page.apply();
  sameReadings(await page.evaluate(reading), profile, "page");
  const frameResult = await page.evaluate(`(${frames.toString()})(${JSON.stringify(base + "/navigated")})`);
  for (const key of ["blank", "viaFrames", "nested", "fragment", "html", "navigated"]) {
    sameReadings(frameResult[key], profile, key);
    assert.equal(frameResult[key].ownArray, true, key + " array realm");
    assert.equal(frameResult[key].ownArrayPrototype, true, key + " array prototype realm");
  }
  assert.equal(frameResult.windowIdentityRetained, true);
  assert.equal(frameResult.documentChanged, true);
  assert.equal(frameResult.sandboxError, "SecurityError");
  check("synchronous blank/nested/fragment/innerHTML frames, own-realm arrays, navigation and sandbox isolation", frameResult);

  const captured = await page.evaluate(`(${workerProbe.toString()})(${JSON.stringify(workerSource)},{keep:true})`);
  assert.ok(captured.value, JSON.stringify(captured));
  sameReadings(captured.value, profile, "captured Blob Worker");
  assert.equal(captured.value.strict, true, "original strict directive remains active");
  assert.notEqual(captured.value.location, captured.objectUrl, "wrapper Blob URL remains an acknowledged difference");
  check("captured classic Blob Worker reads selected locale and retains strict mode", { ...captured, locationChanged: true });
  for (const mode of ["http", "module", "options"]) {
    const result = await page.evaluate(`(${workerProbe.toString()})(${JSON.stringify(workerSource)},{mode:${JSON.stringify(mode)}})`);
    assert.ok(result.value, JSON.stringify(result)); sameReadings(result.value, page.native, mode);
    if (mode === "options") {
      assert.equal(result.typeReads, baselineOptions.typeReads); assert.equal(result.nameReads, baselineOptions.nameReads);
      assert.equal(result.value.name, "local-probe");
    }
    check(mode + " Worker uses the native fallback", result);
  }
  const revoked = await page.evaluate(`(${workerProbe.toString()})(${JSON.stringify(workerSource)},{mode:'revoked'})`);
  assert.ok(revoked.error && !revoked.value && !revoked.timeout, JSON.stringify(revoked));
  check("revoking an original Blob URL does not revive the Worker from a source cache", revoked);

  const proxyBlob = await page.evaluate(`new Promise((resolve,reject)=>{
    const parts=new Proxy(["postMessage({wrongSource:true})"],{get(target,key,receiver){
      if(key===Symbol.iterator)return function*(){yield ${JSON.stringify(workerSource)}};
      return Reflect.get(target,key,receiver);
    }});
    const url=URL.createObjectURL(new Blob(parts,{type:'text/javascript'})),worker=new Worker(url);
    const timer=setTimeout(()=>{worker.terminate();URL.revokeObjectURL(url);reject(new Error('Proxy Blob timeout'))},2500);
    worker.onmessage=event=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);resolve({value:event.data,url})};
    worker.onerror=()=>{clearTimeout(timer);worker.terminate();URL.revokeObjectURL(url);reject(new Error('Proxy Blob failed'))};
  })`);
  sameReadings(proxyBlob.value, page.native, "Blob with custom Proxy iterator");
  assert.equal(proxyBlob.value.location, proxyBlob.url);
  check("Proxy Blob input preserves the bytes consumed by the native iterator", proxyBlob);

  await page.evaluate("window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));");
  const afterPersisted = await page.evaluate(`(${workerProbe.toString()})(${JSON.stringify(workerSource)})`);
  assert.ok(afterPersisted.value); sameReadings(afterPersisted.value, profile, "retained document after persisted lifecycle");
  const persistedFrame = await page.evaluate(`(()=>{const frame=document.createElement('iframe');document.body.appendChild(frame);const w=frame.contentWindow;const result={language:w.navigator.language,languages:[...w.navigator.languages],timezone:w.Intl.DateTimeFormat().resolvedOptions().timeZone};frame.remove();return result})()`);
  sameReadings(persistedFrame, profile, "persisted document new iframe");
  check("persisted pagehide/pageshow retains context hooks for the same document", {worker:afterPersisted.value,iframe:persistedFrame});

  const immediateStop = await page.evaluate(`new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}],{type:'text/javascript'}));
    const worker=new Worker(url);URL.revokeObjectURL(url);
    const timer=setTimeout(()=>{worker.terminate();reject(new Error('immediate-stop Worker timeout'))},2500);
    worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data)};
    worker.onerror=()=>{clearTimeout(timer);worker.terminate();reject(new Error('immediate-stop Worker failed'))};
    window.dispatchEvent(new Event(${JSON.stringify(page.controlEvent)}));
  })`);
  sameReadings(immediateStop, profile, "Worker created immediately before stop");
  check("immediate stop does not break a Worker already constructed", immediateStop);
  const afterStop = await page.evaluate(`(() => { const frame=document.createElement('iframe'); document.body.appendChild(frame); const w=frame.contentWindow; const out={language:w.navigator.language,languages:[...w.navigator.languages],timezone:w.Intl.DateTimeFormat().resolvedOptions().timeZone}; frame.remove(); return out; })()`);
  sameReadings(afterStop, page.native, "new iframe after stop");
  const newWorker = await page.evaluate(`(${workerProbe.toString()})(${JSON.stringify(workerSource)})`);
  assert.ok(newWorker.value); sameReadings(newWorker.value, page.native, "new Worker after stop");
  const oldWorker = await page.evaluate(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('existing Worker was terminated')),2000); keptWorker.addEventListener('message',event=>{clearTimeout(timer);resolve(event.data)},{once:true}); keptWorker.postMessage('read');})`);
  sameReadings(oldWorker, profile, "already running Worker after stop");
  await page.evaluate("keptWorker.terminate();URL.revokeObjectURL(keptWorkerUrl);delete globalThis.keptWorker;delete globalThis.keptWorkerUrl;");
  check("stop event disables future iframe/Worker propagation without terminating a running Worker", { afterStop, newWorker: newWorker.value, oldWorker });
  await cdp("Target.closeTarget", { targetId: page.targetId });

  const csp = await open("/csp"); await csp.apply();
  const cspWorker = await csp.evaluate(`(${workerProbe.toString()})(${JSON.stringify(workerSource)})`);
  assert.ok(cspWorker.value, JSON.stringify(cspWorker)); sameReadings(cspWorker.value, profile, "CSP Blob Worker");
  assert.equal(cspWorker.value.strict, true);
  check("script-src self and worker-src blob permit the supported path without eval/importScripts", cspWorker);
  await cdp("Target.closeTarget", { targetId: csp.targetId });

  const trusted = await open("/trusted");
  const nativeTrusted = await trusted.evaluate(`(${workerProbe.toString()})(${JSON.stringify(workerSource)})`);
  assert.equal(nativeTrusted.error, "TypeError", "native Trusted Types string Worker rejection");
  await trusted.apply();
  const wrappedTrusted = await trusted.evaluate(`(${workerProbe.toString()})(${JSON.stringify(workerSource)})`);
  assert.equal(wrappedTrusted.error, "TypeError", "wrapped Trusted Types string Worker rejection");
  assert.equal(wrappedTrusted.value, undefined);
  check("Trusted Types still rejects primitive string Worker URLs", wrappedTrusted);
  await cdp("Target.closeTarget", { targetId: trusted.targetId });
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(report.error); }
finally {
  try { await cdp("Browser.close"); } catch {}
  if (chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
  await writeFile(path.join(root, "verification/chrome-context-smoke.json"), JSON.stringify(report, null, 2) + "\n");
}
