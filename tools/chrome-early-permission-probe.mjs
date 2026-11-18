// Authored localhost-only probe of registered MAIN document_start permissions.
// No production extension code, user profile, remote page, or automatic cleanup
// listener is loaded. This deliberately measures stale-registration behavior.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "privacy-early-permissions-"));
const extension = path.join(scratch, "extension"), profile = path.join(scratch, "profile");
await mkdir(extension); await mkdir(profile);
const origin = "http://127.0.0.1/*";
await writeFile(path.join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Temporary early permission probe", version: "1.0", permissions: ["tabs"], optional_permissions: ["scripting"], host_permissions: [origin], action: { default_popup: "popup.html" } }));
await writeFile(path.join(extension, "popup.html"), "<!doctype html><title>Permission probe</title>");
await writeFile(path.join(extension, "early.js"), "globalThis.earlyProbe = true;");
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "text/html"); response.setHeader("Cache-Control", "no-store");
  response.end("<!doctype html><script>globalThis.inlineProbe=globalThis.earlyProbe===true;</script><title>Local permission probe</title><body>Local only</body>");
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const url = `http://127.0.0.1:${server.address().port}/`;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
  "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", "about:blank"
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
let id = 0, buffer = "", stderr = "";
const pending = new Map(), report = { scope: "Temporary extension with no permission-change cleanup listeners; localhost only", stages: [] };
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
const evaluate = async (sessionId, expression, userGesture = false) => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
let extensionSession, settingsSession, extensionId;
async function snapshot() {
  return evaluate(extensionSession, `(async()=>{
    const permissions=await chrome.permissions.getAll();
    let scripts=null,error=null;try{scripts=await chrome.scripting.getRegisteredContentScripts()}catch(e){error=e.message}
    return {permissions,scriptingAvailable:!!chrome.scripting,scripts,error};
  })()`);
}
async function navigate(label) {
  const { targetId } = await cdp("Target.createTarget", { url: url + "?stage=" + label });
  const sessionId = await attach(targetId);
  let reading;
  for (let i = 0; i < 60; i++) {
    reading = await evaluate(sessionId, "({ready:document.readyState,inline:globalThis.inlineProbe,late:globalThis.earlyProbe===true})");
    if (reading.ready === "complete" && typeof reading.inline === "boolean") break;
    await delay(20);
  }
  const state = await snapshot(); report.stages.push({ label, reading, ...state });
  console.log(label + ": inline=" + reading.inline + ", scripting=" + state.scriptingAvailable + ", registered=" + (state.scripts?.length ?? "unavailable"));
  await cdp("Target.closeTarget", { targetId });
  return reading;
}
async function grant(request) {
  return evaluate(extensionSession, `chrome.permissions.request(${JSON.stringify(request)}).then(value=>({value}),error=>({error:error.message}))`, true);
}
async function register() {
  return evaluate(extensionSession, `chrome.scripting.registerContentScripts([{id:'early-probe',matches:[${JSON.stringify(origin)}],js:['early.js'],world:'MAIN',runAt:'document_start',allFrames:true,persistAcrossSessions:false}])`);
}

try {
  report.browser = (await cdp("Browser.getVersion")).product;
  extensionId = (await cdp("Extensions.loadUnpacked", { path: extension })).id;
  const popup = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
  extensionSession = await attach(popup.targetId);
  for (let i = 0; i < 50 && !(await evaluate(extensionSession, "!!globalThis.chrome?.permissions")); i++) await delay(30);
  const settings = await cdp("Target.createTarget", { url: "chrome://extensions/" }); settingsSession = await attach(settings.targetId);
  for (let i = 0; i < 50 && !(await evaluate(settingsSession, "!!globalThis.chrome?.developerPrivate")); i++) await delay(30);
  await evaluate(settingsSession, "chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})");
  // The manifest pregrants loopback only. Host revocation below uses Chrome's
  // real site-access withholding control, since required hosts cannot be
  // removed with permissions.remove and headless cannot accept host prompts.
  report.hostGrantSetup = "manifest host_permissions pregrants loopback only";
  report.initialGrant = await grant({ permissions: ["scripting"] });
  if (!(await evaluate(extensionSession, "chrome.permissions.contains({permissions:['scripting']})"))) await grant({ permissions: ["scripting"] });
  await register();
  assert.equal((await navigate("initial-registered")).inline, true, "registered MAIN runs before first page script");
  report.removeScripting = await evaluate(extensionSession, "chrome.permissions.remove({permissions:['scripting']})");
  await navigate("scripting-removed-host-retained");
  report.regrantScripting = await grant({ permissions: ["scripting"] });
  await navigate("scripting-regranted-without-cleanup");
  const scripts = await evaluate(extensionSession, "chrome.scripting.getRegisteredContentScripts()");
  if (!scripts.length) { await register(); report.hostScenarioRequiredReregistration = true; }
  await evaluate(settingsSession, `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},hostAccess:'ON_CLICK'})`);
  report.removeHost = { method: "Chrome site access ON_CLICK withholding" };
  await navigate("host-removed-scripting-retained");
  await evaluate(settingsSession, `chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},hostAccess:'ON_ALL_SITES'})`);
  report.regrantHost = { method: "Chrome site access ON_ALL_SITES restore", present: await evaluate(extensionSession, `chrome.permissions.contains({origins:[${JSON.stringify(origin)}]})`) };
  await navigate("host-regranted-without-cleanup");
  await evaluate(extensionSession, "chrome.scripting.unregisterContentScripts({ids:['early-probe']})");
  assert.equal((await navigate("explicit-unregister")).inline, false);
  report.completed = true;
} catch (error) { report.completed = false; report.error = error.stack; process.exitCode = 1; console.error(report.error); }
finally {
  try { await cdp("Browser.close"); } catch {}
  if (chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
  if (chrome.exitCode === null) chrome.kill("SIGKILL");
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
  await writeFile(path.join(root, "verification/chrome-early-permission-probe.json"), JSON.stringify(report, null, 2) + "\n");
}
