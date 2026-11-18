// Real current extension; disposable Chrome profile and authored loopback pages.
// The temporary copy pregrants requested site/tabs/DNR access to avoid headless
// permission dialogs. scripting remains a required permission as shipped.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "privacy-host-access-"));
const extension = path.join(scratch, "extension"), profile = path.join(scratch, "profile");
await mkdir(profile); await cp(path.join(root, "extension"), extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
assert.ok(manifest.permissions.includes("scripting") && !manifest.optional_permissions.includes("scripting"));
manifest.permissions = [...new Set([...manifest.permissions, ...manifest.optional_permissions])];
manifest.host_permissions = manifest.optional_host_permissions;
delete manifest.optional_permissions; delete manifest.optional_host_permissions;
await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
// This own-extension document has no polling/status script. Snapshot reads below
// cannot trigger reconcile and hide a missing permissions.onRemoved handler.
await writeFile(path.join(extension, "host-probe.html"), "<!doctype html><title>Local host access probe</title>");
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html"); response.setHeader("Cache-Control", "no-store");
  response.end("<!doctype html><script>globalThis.firstHostProbe={timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language,offset:new Date().getTimezoneOffset()};</script><title>Local host access</title><body>Local only</body>");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const url = `http://127.0.0.1:${server.address().port}/`;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", "about:blank"
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let id = 0, buffer = "", stderr = "", extensionSession, settingsSession, extensionId;
const pending = new Map(), report = { scope: "Real extension host withholding/regrant; no popup polling or automatic diagnostic reconciliation", version: manifest.version, stages: [] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
chrome.stderr.on("data", data => { stderr = (stderr + data).slice(-3000); });
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
const attach = async targetId => (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId;
const evaluate = async (sessionId, expression) => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
async function snapshot() {
  return evaluate(extensionSession, `(async()=>({
    runtime:(await chrome.storage.local.get('regionRuntime')).regionRuntime,
    permissions:await chrome.permissions.getAll(),
    hosts:await chrome.permissions.contains({origins:['http://*/*','https://*/*']}),
    scripts:await chrome.scripting.getRegisteredContentScripts(),
    rules:await chrome.declarativeNetRequest.getDynamicRules()
  }))()`);
}
async function waitFor(predicate, label) {
  const until = Date.now() + 6000;
  while (Date.now() < until) { if (await predicate()) return; await delay(25); }
  throw new Error("Timed out: " + label);
}
async function navigate(label) {
  const { targetId } = await cdp("Target.createTarget", { url: url + "?stage=" + label });
  const sessionId = await attach(targetId);
  let reading;
  await waitFor(async () => {
    reading = await evaluate(sessionId, "({first:globalThis.firstHostProbe,current:{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,language:navigator.language,offset:new Date().getTimezoneOffset()}})");
    return !!reading.first;
  }, "first page reading");
  const state = await snapshot(); report.stages.push({ label, reading, ...state });
  console.log(`${label}: first=${reading.first.timezone}/${reading.first.language}, hosts=${state.hosts}, requested=${state.runtime?.requested}, scripts=${state.scripts.length}`);
  await cdp("Target.closeTarget", { targetId });
  return { reading, ...state };
}
const send = message => evaluate(extensionSession, `chrome.runtime.sendMessage(${JSON.stringify(message)})`);
const access = mode => evaluate(settingsSession, `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},hostAccess:${JSON.stringify(mode)}})`);
async function applyLA() {
  const result = await send({ type: "regionApply", profileId: "us-en" });
  assert.ok(result.ok, JSON.stringify(result));
  await waitFor(async () => (await snapshot()).runtime?.phase === "active", "active region");
}

try {
  report.browser = (await cdp("Browser.getVersion")).product;
  extensionId = (await cdp("Extensions.loadUnpacked", { path: extension })).id;
  const diagnostic = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/host-probe.html` });
  extensionSession = await attach(diagnostic.targetId);
  await waitFor(() => evaluate(extensionSession, "!!globalThis.chrome?.storage"), "extension APIs");
  const settings = await cdp("Target.createTarget", { url: "chrome://extensions/" }); settingsSession = await attach(settings.targetId);
  await waitFor(() => evaluate(settingsSession, "!!globalThis.chrome?.developerPrivate"), "extension settings APIs");
  await evaluate(settingsSession, "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})");
  await send({ type: "status" });
  const native = (await navigate("native-before-apply")).reading.first;
  report.native = native;
  await applyLA();
  const active = await navigate("active-first-inline");
  assert.equal(active.reading.first.timezone, "America/Los_Angeles"); assert.equal(active.reading.first.language, "en-US");

  report.removeRequiredScripting = await evaluate(extensionSession, "chrome.permissions.remove({permissions:['scripting']}).then(value=>({value}),error=>({error:error.message}))");
  assert.ok(report.removeRequiredScripting.error || report.removeRequiredScripting.value === false, "required API permission cannot be removed");

  await access("ON_CLICK");
  const removed = await navigate("host-withheld-immediate-navigation");
  assert.deepEqual(removed.reading.first, native, "Chrome itself blocks early injection without host access");
  await waitFor(async () => { const state = await snapshot(); return state.runtime?.requested === false && state.scripts.length === 0; }, "automatic host revocation cleanup");
  report.afterAutomaticCleanup = await snapshot();
  await access("ON_ALL_SITES");
  const restored = await navigate("host-restored-without-apply");
  assert.deepEqual(restored.reading.first, native); assert.equal(restored.runtime.requested, false); assert.equal(restored.scripts.length, 0);

  for (const gap of [0, 100]) {
    await applyLA();
    const before = await navigate("before-fast-toggle-" + gap); assert.equal(before.reading.first.timezone, "America/Los_Angeles");
    await evaluate(settingsSession, `(async()=>{
      await chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},hostAccess:'ON_CLICK'});
      ${gap ? `await new Promise(resolve=>setTimeout(resolve,${gap}));` : ""}
      await chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},hostAccess:'ON_ALL_SITES'});
    })()`);
    const rapid = await navigate("fast-host-regrant-" + gap + "ms");
    const stale = rapid.reading.first.timezone === "America/Los_Angeles" && native.timezone !== "America/Los_Angeles";
    report.fastToggleResults ??= []; report.fastToggleResults.push({ gapMs: gap, staleEarlyProfileObserved: stale, first: rapid.reading.first, runtime: rapid.runtime, scripts: rapid.scripts });
    if (stale) throw new Error("Old MAIN registration revived during fast host regrant " + gap + "ms");
    await waitFor(async () => { const state = await snapshot(); return state.runtime?.requested === false && state.scripts.length === 0; }, "fast toggle cleanup");
  }
  await applyLA();
  const explicit = await navigate("explicit-apply-after-regrant");
  assert.equal(explicit.reading.first.timezone, "America/Los_Angeles"); assert.equal(explicit.reading.first.language, "en-US");
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(report.error); }
finally {
  try { await cdp("Browser.close"); } catch {}
  if (chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
  await writeFile(path.join(root, "verification/chrome-host-access-smoke.json"), JSON.stringify(report, null, 2) + "\n");
}
