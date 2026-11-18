// Local, authored probes for the public who-are-you reflection/consistency checks.
// Does not download or execute that site's code or contact remote pages.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const currentSource = await readFile(path.join(root, "extension/page-context.js"), "utf8");
const baselinePath = process.argv[2];
const variants = baselinePath ? [["baseline", await readFile(baselinePath, "utf8")], ["current", currentSource]] : [["current", currentSource]];
const profile = await mkdtemp(path.join(tmpdir(), "privacy-reflection-"));
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store");
  res.end("<!doctype html><title>Local reflection checks</title><body>Local checks only</body>");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe",
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication",
  "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", "about:blank"
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let id = 0, buffer = "", stderr = "";
const pending = new Map(), report = { scope: "Local page-shim checks; not an online site verdict or all fingerprint tests", runs: [] };
chrome.stderr.on("data", data => { stderr = (stderr + data).slice(-3000); });
chrome.stdio[4].on("data", data => {
  buffer += data.toString();
  let end;
  while ((end = buffer.indexOf("\0")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    const item = pending.get(message.id); if (!item) continue;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(method + " timed out: " + stderr)); }, 10000);
  pending.set(next, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// This is our own implementation of a small subset of the documented checks.
// A fresh iframe is intentionally read synchronously; it exposes the real gap.
async function probe() {
  const frame = document.createElement("iframe"); document.body.appendChild(frame);
  const clean = frame.contentWindow, stringify = clean.Function.prototype.toString;
  const failures = [], shapeFailures = [];
  function check(label, fn, owner) {
    if (!/\{\s*\[native code\]\s*\}\s*$/.test(stringify.call(fn))) failures.push(label + ":source");
    if (Object.hasOwn(fn, "prototype")) failures.push(label + ":constructable");
    if (owner) {
      try { Reflect.apply(fn, Object.create(owner), []); failures.push(label + ":receiver"); }
      catch (error) { if (!(error instanceof TypeError) && !(error instanceof clean.TypeError)) failures.push(label + ":wrong-error"); }
    }
  }
  for (const name of ["language", "languages"]) {
    const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, name);
    check("Navigator." + name, descriptor.get, Navigator.prototype);
    const original = Object.getOwnPropertyDescriptor(clean.Navigator.prototype, name);
    if (descriptor.get.name !== original.get.name || descriptor.get.length !== original.get.length || descriptor.enumerable !== original.enumerable || descriptor.configurable !== original.configurable) shapeFailures.push("Navigator." + name);
  }
  for (const name of ["getTimezoneOffset", "toString", "getFullYear", "setHours", "toLocaleString"]) {
    const fn = Date.prototype[name], original = clean.Date.prototype[name];
    check("Date." + name, fn);
    if (fn.name !== original.name || fn.length !== original.length) shapeFailures.push("Date." + name);
  }
  check("Date.parse", Date.parse);
  if (Date.parse.name !== clean.Date.parse.name || Date.parse.length !== clean.Date.parse.length) shapeFailures.push("Date.parse");
  if (Function.prototype.toString !== globalThis.originalToString) shapeFailures.push("Function.prototype.toString modified");
  const read = win => ({ language: win.navigator.language, languages: [...win.navigator.languages].join(), timezone: win.Intl.DateTimeFormat().resolvedOptions().timeZone });
  const page = read(window), other = read(clean), frameDifferences = Object.keys(page).filter(key => page[key] !== other[key]);
  const workerCode = "postMessage({language:navigator.language,languages:[...navigator.languages].join(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})";
  const url = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
  const worker = new Worker(url);
  const workerValues = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker probe timed out")), 3000);
    worker.onmessage = event => { clearTimeout(timer); resolve(event.data); };
    worker.onerror = () => { clearTimeout(timer); reject(new Error("Worker probe failed")); };
  }).finally(() => { worker.terminate(); URL.revokeObjectURL(url); });
  const workerDifferences = Object.keys(page).filter(key => page[key] !== workerValues[key]);
  const now = new Date(), part = new Intl.DateTimeFormat("en-US", { timeZone: page.timezone, timeZoneName: "longOffset" }).formatToParts(now).find(part => part.type === "timeZoneName").value;
  const parseOffset = text => {
    const match = /GMT([+−-])(\d{1,2}):?(\d{2})?/.exec(text);
    return match ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] || 0)) : 0;
  };
  const offsets = { intl: parseOffset(part), getter: -now.getTimezoneOffset(), string: parseOffset(now.toString()) };
  const intlConstructors = ["DateTimeFormat", "NumberFormat", "Collator", "PluralRules", "RelativeTimeFormat", "ListFormat", "Segmenter"];
  const constructorMismatches = intlConstructors.filter(name => typeof Intl[name] === "function" && new Intl[name]().constructor !== Intl[name]);
  frame.remove();
  const siteReflectionFailures = failures.filter(label => /^(Navigator\.(language|languages)|Date\.(getTimezoneOffset|toString)):/.test(label));
  return { page, siteReflectionFailures, reflectionFailures: failures, shapeFailures, offsets, frameDifferences, workerDifferences, constructorMismatches };
}

try {
  report.browser = (await cdp("Browser.getVersion")).product;
  for (const [variant, source] of variants) {
    for (const region of [
      { id: "jp", timezone: "Asia/Tokyo", locale: "ja-JP", languages: ["ja-JP", "ja"] },
      { id: "us", timezone: "America/Los_Angeles", locale: "en-US", languages: ["en-US", "en"] }
    ]) {
      const { targetId } = await cdp("Target.createTarget", { url: `http://127.0.0.1:${server.address().port}/` });
      const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
      const evaluate = async expression => {
        const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      for (let i = 0; i < 30 && !(await evaluate("!!document.body")); i++) await delay(50);
      const nativeReadings = await evaluate("({language:navigator.language,languages:[...navigator.languages].join(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})");
      await evaluate("globalThis.originalToString=Function.prototype.toString");
      const functionName = /export function (\w+)/.exec(source)?.[1];
      assert.ok(functionName, "self-contained entry point");
      await evaluate(source.replace("export function", "function") + `\n${functionName}(${JSON.stringify(region)})`);
      const result = await evaluate(`(${probe.toString()})()`);
      report.runs.push({ variant, region: region.id, nativeReadings, ...result });
      assert.equal(result.page.timezone, region.timezone);
      assert.equal(result.page.language, region.locale);
      assert.equal(result.offsets.intl, result.offsets.getter);
      assert.equal(result.offsets.intl, result.offsets.string);
      if (variant === "current") {
        assert.deepEqual(result.reflectionFailures, [], "selected reflection checks");
        assert.deepEqual(result.shapeFailures, [], "function metadata and property descriptors");
        assert.deepEqual(result.constructorMismatches, [], "Intl instance constructor consistency");
      }
      const expectedDifferences = variant === "current" ? [] : Object.keys(result.page).filter(key => result.page[key] !== nativeReadings[key]);
      assert.deepEqual(result.frameDifferences, expectedDifferences, "fresh synchronous iframe readings");
      assert.deepEqual(result.workerDifferences, expectedDifferences, "supported Blob Worker readings");
      await cdp("Target.closeTarget", { targetId });
    }
  }
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally {
  try { await cdp("Browser.close"); } catch {}
  if (chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
  await writeFile(path.join(root, "verification/chrome-reflection-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
