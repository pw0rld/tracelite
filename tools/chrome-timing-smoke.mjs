// Reproduces page-first probing before the extension's asynchronous MAIN injection.
// Uses only authored loopback pages, a trusted prior release, and a temporary profile.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archive = process.argv[2] ? path.resolve(process.argv[2]) : null;
const expectConsistent = !archive || process.argv.includes("--expect-consistent");
const scratch = await mkdtemp(path.join(tmpdir(), "privacy-timing-"));
const profile = path.join(scratch, "profile"), extension = path.join(scratch, "extension");
await mkdir(profile); await mkdir(extension);
if (archive) await new Promise((resolve, reject) => {
  const child = spawn("unzip", ["-q", archive, "-d", extension], { stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; child.stderr.on("data", data => { error += data; });
  child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(error)));
});
else await cp(path.join(root, "extension"), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
manifest.permissions = [...new Set([...manifest.permissions, ...manifest.optional_permissions])];
manifest.host_permissions = manifest.optional_host_permissions;
delete manifest.optional_permissions; delete manifest.optional_host_permissions;
await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
const bootstrapPath = path.join(extension, "region-bootstrap.js");
const originalBootstrap = await readFile(bootstrapPath, "utf8");
// This delay exists only in the disposable copy. Normal pages use zero delay.
await writeFile(bootstrapPath, originalBootstrap.replace(
  'const grant = await chrome.runtime.sendMessage',
  'const timingDelay=Number(new URL(location.href).searchParams.get("test-bootstrap-delay"))||0; if(timingDelay) await new Promise(resolve=>setTimeout(resolve,timingDelay));\n    const grant = await chrome.runtime.sendMessage'
).replace('stopRefusedEarlyEntries(grant);', `window.dispatchEvent(new CustomEvent('timing-test-reply',{detail:JSON.stringify({reply:grant,timeOrigin:performance.timeOrigin})}));\n    stopRefusedEarlyEntries(grant);`));
const report = { scope: "First inline script, immediate Worker and request header consistency; not an online site test", archive: archive ? path.basename(archive) : "working tree", version: manifest.version, expectConsistent,
  bootstrapSHA256: createHash("sha256").update(originalBootstrap).digest("hex"), scenarios: [] };

function earlyProbe() {
  const started = performance.now(), timeline = [];
  const read = () => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const zoneText = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(new Date()).find(part => part.type === "timeZoneName").value;
    const offset = /GMT([+-])(\d{2}):?(\d{2})?/.exec(zoneText);
    const intlOffset = offset ? (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3] || 0)) : 0;
    return { at: +(performance.now() - started).toFixed(2), timezone, intlOffset,
      locale: Intl.DateTimeFormat().resolvedOptions().locale, language: navigator.language, languages: [...navigator.languages],
      dateOffset: new Date().getTimezoneOffset() };
  };
  const initial = read(); timeline.push({ stage: "first-inline-script", ...initial });
  const earlyOffset = Date.prototype.getTimezoneOffset;
  const state = window.timingProbe = { initial, timeline, worker: null, workerError: null, read, replies:[] };
  window.addEventListener('timing-test-reply',event=>{state.replies.push(JSON.parse(event.detail));});
  fetch('/echo',{cache:'no-store'}).then(response=>response.json()).then(headers=>{state.headerLanguage=headers['accept-language'];});
  const code = "postMessage({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language,languages:[...navigator.languages]})";
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  const worker = new Worker(url); URL.revokeObjectURL(url);
  worker.onmessage = event => {
    state.worker = event.data;
    timeline.push({ stage: "early-worker-returned", at: +(performance.now() - started).toFixed(2), ...event.data }); worker.terminate();
  };
  worker.onerror = event => { state.workerError = event.message; worker.terminate(); };
  let last = JSON.stringify(initial, (key, value) => key === "at" ? undefined : value);
  const timer = setInterval(() => {
    const current = read(), key = JSON.stringify(current, (key, value) => key === "at" ? undefined : value);
    if (key !== last) { timeline.push({ stage: "page-values-changed", ...current }); last = key; }
  }, 5);
  setTimeout(() => clearInterval(timer), 1500);
  state.finish = () => {
    const current = read();
    return { url:location.href, timeOrigin:performance.timeOrigin, replies:state.replies, initial, current, worker: state.worker, workerError: state.workerError, headerLanguage:state.headerLanguage, timeline: [...timeline, { stage: "final-read", ...current }],
      retainedNativeOffset: Reflect.apply(earlyOffset, new Date(), []),
      cachedIntlVsCurrentDateMismatch: initial.intlOffset !== -current.dateOffset,
      currentDateIntlConsistent: current.intlOffset === -current.dateOffset,
      cachedLanguageVsCurrentLanguageMismatch: initial.language !== current.language,
      workerDifferences: state.worker ? ["timezone", "language", "languages"].filter(key => JSON.stringify(state.worker[key]) !== JSON.stringify(current[key])) : null };
  };
}
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.url.startsWith("/echo")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(request.headers)); return; }
  response.setHeader("Content-Type", "text/html");
  response.end(`<!doctype html><html><head><title>Early probe timing</title><script>(${earlyProbe.toString()})();</script></head><body>Authored local early probe</body></html>`);
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const base = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", "about:blank"
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let id = 0, buffer = "", stderr = ""; const pending = new Map();
chrome.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
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
const evaluate = async (expression, sessionId) => {
  const answer = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails)); return answer.result.value;
};
const open = async url => {
  const { targetId } = await cdp("Target.createTarget", { url });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  return { targetId, sessionId };
};
const waitFor = async (fn, name) => {
  for (let i = 0; i < 90; i++) {
    try { if (await fn()) return; } catch (error) { if (!/context.*destroyed|Cannot find context|No execution context|Frame.*removed|No frame/i.test(error.message)) throw error; }
    await delay(50);
  }
  throw new Error("Timed out: " + name);
};

try {
  report.browser = (await cdp("Browser.getVersion")).product;
  const { id: extensionId } = await cdp("Extensions.loadUnpacked", { path: extension });
  const popup = await open(`chrome-extension://${extensionId}/popup.html`);
  await waitFor(() => evaluate("Boolean(globalThis.chrome?.runtime)", popup.sessionId), "extension popup");
  const send = async message => {
    const result = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`, popup.sessionId);
    assert.ok(result.ok, JSON.stringify(result)); return result.data;
  };
  await send({ type: "status" });
  const tab = await evaluate(`chrome.tabs.create({url:${JSON.stringify(base + "/natural")},active:false})`, popup.sessionId);
  await waitFor(() => evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>!!window.timingProbe?.worker}).then(result=>result[0]?.result)`, popup.sessionId), "native first probe");
  const readProbe = () => evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>window.timingProbe?.finish()}).then(result=>result[0]?.result)`, popup.sessionId);
  report.native = (await readProbe()).initial;
  const scenarios = expectConsistent ? [
    {name:'us-first-load',delay:0,profileId:'us-en',timezone:'America/Los_Angeles',language:'en-US'},
    {name:'jp-first-load',delay:0,profileId:'jp',timezone:'Asia/Tokyo',language:'ja-JP'},
    {name:'sg-first-load',delay:0,profileId:'sg-en',timezone:'Asia/Singapore',language:'en-SG'},
    {name:'us-ny-first-load',delay:0,profileId:'us-ny',timezone:'America/New_York',language:'en-US'},
    {name:'background-bootstrap-delayed',delay:200,profileId:'us-en',timezone:'America/Los_Angeles',language:'en-US'}
  ] : [{ name: "natural", delay: 0, profileId:'us-en',timezone:'America/Los_Angeles',language:'en-US' }, { name: "controlled-bootstrap-delay", delay: 200,profileId:'us-en',timezone:'America/Los_Angeles',language:'en-US' }];
  for (const scenario of scenarios) {
    if (scenario.delay) {
      await evaluate(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(base + "/delayed?test-bootstrap-delay=200")}})`, popup.sessionId);
      await delay(400);
    }
    await send({ type: "regionApply", tabId: tab.id, profileId: scenario.profileId });
    await waitFor(async () => {
      const probe = await readProbe(); return probe?.worker && probe.current.timezone === scenario.timezone && probe.current.language === scenario.language && probe.headerLanguage;
    }, scenario.name + " late applied page");
    await delay(100);
    const probe = await readProbe();
    const freshWorker = await evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>new Promise((resolve,reject)=>{
      const code="postMessage({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language,languages:[...navigator.languages]})";
      const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'})),worker=new Worker(url);URL.revokeObjectURL(url);
      worker.onmessage=event=>{worker.terminate();resolve(event.data)};worker.onerror=()=>{worker.terminate();reject(new Error('fresh worker failed'))};
      setTimeout(()=>{worker.terminate();reject(new Error('fresh worker timed out'))},2500);
    })}).then(result=>result[0]?.result)`, popup.sessionId);
    const data = { ...scenario, ...probe, workerCreatedAfterApply: freshWorker };
    report.scenarios.push(data);
    assert.equal(probe.current.timezone, scenario.timezone);
    assert.equal(freshWorker.timezone, scenario.timezone);
    assert.equal(freshWorker.language, scenario.language);
    if (expectConsistent) {
      assert.equal(probe.initial.timezone,scenario.timezone,'first script sees selected timezone');
      assert.equal(probe.initial.language,scenario.language,'first script sees selected language');
      assert.equal(probe.cachedIntlVsCurrentDateMismatch,false);
      assert.equal(probe.currentDateIntlConsistent,true);
      assert.equal(probe.cachedLanguageVsCurrentLanguageMismatch,false);
      assert.deepEqual(probe.workerDifferences,[],'Worker created in first script agrees');
      assert.ok(probe.headerLanguage.startsWith(scenario.language),'header matches page from first request');
    } else if (scenario.delay) {
      assert.equal(probe.initial.timezone, report.native.timezone);
      assert.equal(probe.cachedIntlVsCurrentDateMismatch, true);
      assert.ok(probe.workerDifferences.length > 0);
    }
    console.log(scenario.name + ": " + JSON.stringify(data));
  }
  report.reproduced = report.scenarios.some(item => item.cachedIntlVsCurrentDateMismatch && item.workerDifferences?.length);
  assert.equal(report.reproduced, !expectConsistent);
  if (expectConsistent) {
    // The MAIN entry runs first even when the isolated handshake is delayed.
    // Pause before this new document has been recorded by the background.
    await evaluate(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(base+'/pause-before-bootstrap?test-bootstrap-delay=2000')}})`,popup.sessionId);
    await waitFor(async()=>{const value=await readProbe();return value?.url.includes('/pause-before-bootstrap')&&value.worker},'unrecorded early document');
    const unrecorded=await readProbe();
    assert.equal(unrecorded.initial.timezone,'America/Los_Angeles');
    const newDocumentId=await evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>null}).then(result=>result[0].documentId)`,popup.sessionId);
    const saved=await evaluate(`chrome.storage.session.get('regionDocuments').then(value=>value.regionDocuments?.applied?.[${JSON.stringify(newDocumentId)}])`,popup.sessionId);
    assert.equal(saved,undefined,'pause precedes recording of the new document');
    await send({type:'enabled',value:false});
    await waitFor(async()=>{
      const value=await readProbe();
      return value?.replies.some(item=>item.reply?.stopEarlyTokens?.length);
    },'delayed handshake receives refusal stop tokens');
    const future=await evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:async()=>{
      const frame=document.createElement('iframe');document.body.appendChild(frame);
      const iframe={timezone:frame.contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone,language:frame.contentWindow.navigator.language};frame.remove();
      const url=URL.createObjectURL(new Blob(["postMessage({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language})"],{type:'text/javascript'}));
      const worker=new Worker(url);URL.revokeObjectURL(url);
      const result=await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=()=>reject(new Error('future Worker failed'));setTimeout(()=>reject(new Error('future Worker timed out')),2500)});
      worker.terminate();return {iframe,worker:result};
    }}).then(result=>result[0].result)`,popup.sessionId);
    report.pausedBeforeBootstrap={...future,probe:await readProbe()};
    assert.equal(future.iframe.timezone,report.native.timezone);
    assert.equal(future.iframe.language,report.native.language);
    assert.equal(future.worker.timezone,report.native.timezone);
    assert.equal(future.worker.language,report.native.language);
  }
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(report.error); }
finally {
  try { await cdp("Browser.close"); } catch {}
  if (chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  await new Promise(resolve => server.close(resolve)); await rm(scratch, { recursive: true, force: true });
  await writeFile(path.join(root, expectConsistent ? "verification/chrome-timing-smoke.json" : "verification/chrome-timing-baseline.json"), JSON.stringify(report, null, 2) + "\n");
}
