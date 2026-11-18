// Real older -> current version reloads in disposable Chrome profiles, using only localhost.
// Usage: node tools/chrome-upgrade-smoke.mjs [path/to/older-source.zip]
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { READING_EXPRESSION } from "../extension/region-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const newVersion = JSON.parse(await readFile(path.join(root, "extension/manifest.json"), "utf8")).version;
const oldZip = path.resolve(process.argv[2] || path.join(root, "..", "chrome-privacy-guard-v0.3.1-source.zip"));
const workspace = await mkdtemp(path.join(tmpdir(), "privacy-guard-upgrade-"));
const report = [`Real upgrade regression: ${path.basename(oldZip)} -> current extension`, "Only temporary Chrome profiles and local HTTP pages are used.",
  "Test setup: developer mode is enabled only in disposable profiles. Without it, CDP's initial unpacked load worked but reload was disabled as unsupportedDeveloperExtension; no daily Chrome settings are changed."];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function unzip(source, destination) {
  await mkdir(destination, { recursive: true });
  await new Promise((resolve, reject) => {
    // The input is this project's trusted source archive, never downloaded code.
    const child = spawn("unzip", ["-q", source, "-d", destination], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`unzip exited ${code}: ${stderr}`)));
  });
}

async function copyPregranted(source, destination) {
  await cp(source, destination, { recursive: true });
  const manifestFile = path.join(destination, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  manifest.permissions = [...new Set([...(manifest.permissions || []), ...(manifest.optional_permissions || [])])];
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), ...(manifest.optional_host_permissions || [])])];
  delete manifest.optional_permissions;
  delete manifest.optional_host_permissions;
  // Headless cannot accept the permission dialog. Only this temporary copy changes.
  await writeFile(manifestFile, JSON.stringify(manifest));
  return manifest;
}

async function waitFor(check, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    try { if (await check()) return; }
    catch (error) {
      if (!/Frame.*removed|No frame|Cannot access contents|context.*destroyed|Cannot find context|Session.*not found|Target.*closed/i.test(error.message)) throw error;
    }
    await delay(100);
  }
  throw new Error("Timed out: " + label);
}

async function runScenario(mode, oldExtension, localUrl) {
  const directory = path.join(workspace, mode);
  const profile = path.join(directory, "profile");
  const extension = path.join(directory, "extension");
  await mkdir(profile, { recursive: true });
  const oldManifest = await copyPregranted(oldExtension, extension);
  assert.ok(["0.3.1", "0.5.1", "0.6.0", "0.7.1", "0.8.0"].includes(oldManifest.version), "archive must contain a supported prior version");
  const oldUserScripts = oldManifest.permissions.includes("userScripts");
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-sync", "--disable-default-apps", "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication",
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "", socket;
  chrome.stderr.on("data", data => { stderr = (stderr + data).slice(-4000); });
  let launchError;
  chrome.once("error", error => { launchError = error; });
  try {
    let portData;
    await waitFor(async () => {
      if (launchError) throw launchError;
      if (chrome.exitCode !== null) throw new Error("Chrome exited before DevTools opened: " + stderr);
      try { portData = await readFile(path.join(profile, "DevToolsActivePort"), "utf8"); return true; } catch { return false; }
    }, mode + " DevTools");
    const [port, endpoint] = portData.trim().split("\n");
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("DevTools connection timed out")), 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", event => { clearTimeout(timer); reject(new Error(event.message || "DevTools connection failed")); }, { once: true });
    });
    let id = 0, sessionId;
    const pending = new Map();
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
    });
    const cdp = (method, params = {}, session) => new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(method + " timed out")); }, 10000);
      pending.set(next, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: next, method, params, ...(session ? { sessionId: session } : {}) }));
    });
    const evaluate = async (expression, session = sessionId) => {
      const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const send = async message => {
      const response = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
      assert.ok(response?.ok, JSON.stringify(response)); return response.data;
    };
    const openPage = async url => {
      const { targetId } = await cdp("Target.createTarget", { url });
      const attached = await cdp("Target.attachToTarget", { targetId, flatten: true });
      await cdp("Runtime.enable", {}, attached.sessionId);
      return { targetId, sessionId: attached.sessionId };
    };
    report.push(`${mode}: ${(await cdp("Browser.getVersion")).product}`);
    const { id: extensionId } = await cdp("Extensions.loadUnpacked", { path: extension });
    assert.ok(extensionId, "old extension loaded");
    await delay(500);
    const settings = await openPage("chrome://extensions/");
    await waitFor(() => evaluate("Boolean(globalThis.chrome?.developerPrivate)", settings.sessionId), "temporary extension settings");
    // CDP can initially load unpacked extensions with developer mode off, but
    // Chrome disables their later reload. Match the documented installation flow.
    await evaluate("chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})", settings.sessionId);
    if (oldUserScripts) await evaluate(`chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},userScriptsAccess:true})`, settings.sessionId);
    const extensionInfo = () => evaluate(`chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}).then(items=>items.find(item=>item.id===${JSON.stringify(extensionId)}))`, settings.sessionId);
    const diagnostics = info => JSON.stringify({ version: info?.version, state: info?.state, disableReasons: info?.disableReasons, installWarnings: info?.installWarnings, manifestErrors: info?.manifestErrors });
    sessionId = (await openPage(`chrome-extension://${extensionId}/popup.html`)).sessionId;
    await waitFor(() => evaluate(`Boolean(globalThis.chrome?.runtime && chrome.scripting ${oldUserScripts ? "&& chrome.userScripts" : ""})`), "old popup APIs");
    await send({ type: "status" });
    const tab = await evaluate(`chrome.tabs.create({url:${JSON.stringify(localUrl)},active:false})`);
    const readLive = async () => {
      const readings = await evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>(${READING_EXPRESSION})})`);
      return readings?.[0]?.result;
    };
    await waitFor(async () => Boolean((await readLive())?.language), "initial local document");
    const native = await readLive();
    await send({ type: "regionSave", profile: { name: "Upgrade retained preset", timezone: "Europe/London", locale: "en-GB", languages: ["en-GB", "en"] } });
    await send({ type: "regionApply", profileId: "jp", tabId: tab.id });
    await waitFor(async () => (await readLive())?.language === "ja-JP", "old Japanese override");
    assert.equal((await readLive()).timezone, "Asia/Tokyo");
    if (oldUserScripts) assert.ok((await evaluate("chrome.userScripts.getScripts()")).length > 0, "old user script really registered");
    assert.equal((await evaluate("chrome.storage.local.get('regionRuntime')")).regionRuntime.schema, oldUserScripts ? 1 : 2);
    report.push(`PASS ${mode}: v${oldManifest.version} override works on a real local page before upgrade`);

    if (mode === "paused") await send({ type: "enabled", value: false });
    if (mode === "stopped") await send({ type: "regionStop", tabId: tab.id });
    const before = await evaluate("chrome.storage.local.get(['regions','regionRuntime','config'])");
    const requested = mode !== "stopped";
    assert.equal(before.regionRuntime.requested, requested);
    assert.equal(before.config.enabled, mode !== "paused");

    // Keep the exact unpacked path so Chrome keeps the extension ID and its storage.
    // Do not remove the loaded directory: Chrome may observe a temporarily missing
    // manifest and disable the extension while the replacement is still copying.
    const newManifest = await copyPregranted(path.join(root, "extension"), extension);
    assert.equal(newManifest.version, newVersion);
    assert.ok(!newManifest.permissions.includes("userScripts"), "new manifest drops userScripts");
    await evaluate("setTimeout(() => chrome.runtime.reload(), 50); true");
    await delay(700);
    let info = await extensionInfo();
    report.push(`${mode}: after runtime.reload ${diagnostics(info)}`);
    if (info?.version !== newVersion || info?.state !== "ENABLED") {
      await evaluate(`chrome.developerPrivate.reload(${JSON.stringify(extensionId)},{failQuietly:true})`, settings.sessionId);
      await delay(300);
      info = await extensionInfo();
      report.push(`${mode}: after developerPrivate.reload ${diagnostics(info)}`);
      const reloaded = await cdp("Extensions.loadUnpacked", { path: extension });
      assert.equal(reloaded.id, extensionId, "same-path reload must keep the extension ID");
      report.push(`${mode}: same-path Extensions.loadUnpacked completed after runtime.reload`);
      info = await extensionInfo();
      if (info?.state === "DISABLED") {
        await evaluate(`chrome.management.setEnabled(${JSON.stringify(extensionId)},true)`, settings.sessionId);
        report.push(`${mode}: explicitly re-enabled the temporary unpacked extension`);
      }
    }
    await waitFor(async () => {
      info = await extensionInfo();
      return info?.version === newVersion && info?.state === "ENABLED";
    }, "enabled same-ID " + newVersion + " extension");
    // Only navigate once the extension is enabled. If the target raced with
    // startup, reopen it instead of polling forever inside an ERR_BLOCKED page.
    await waitFor(async () => {
      const page = await openPage(`chrome-extension://${extensionId}/popup.html`);
      if (await evaluate(`globalThis.chrome?.runtime?.getManifest?.().version === ${JSON.stringify(newVersion)}`, page.sessionId)) {
        sessionId = page.sessionId; return true;
      }
      await cdp("Target.closeTarget", { targetId: page.targetId });
      return false;
    }, "same-ID " + newVersion + " popup");
    await cdp("Target.closeTarget", { targetId: settings.targetId });
    assert.equal(await evaluate("chrome.runtime.id"), extensionId);
    await waitFor(async () => {
      const current = await send({ type: "regionStatus", tabId: tab.id });
      return mode === "active" ? current.lifecycle.active : !current.lifecycle.active;
    }, mode + " migration reconciliation");
    const after = await evaluate("chrome.storage.local.get(['regions','regionRuntime','config'])");
    assert.equal(after.regionRuntime.schema, 2);
    assert.equal(after.regionRuntime.requested, requested);
    assert.equal(after.config.enabled, before.config.enabled);
    assert.equal(after.regions.defaultProfileId, before.regions.defaultProfileId);
    assert.deepEqual(after.regions.custom.map(({timezoneMode,languageMode,...p})=>p),
      before.regions.custom.map(({timezoneMode,languageMode,...p})=>p), "saved custom preset survives normalization");
    const permissions = await evaluate("chrome.permissions.getAll()");
    assert.ok(!permissions.permissions.includes("userScripts"), "old userScripts permission removed by Chrome");
    const registered = await evaluate("chrome.scripting.getRegisteredContentScripts()");
    if (mode === "active") {
      assert.ok(registered.some(script => script.id === "privacy-guard-bootstrap-v2" && script.world === "ISOLATED"
        && script.runAt === "document_start" && script.js?.includes("region-bootstrap.js")), "ordinary content script registered");
    } else {
      assert.equal(registered.length, 0, "paused/stopped migration installs no content script");
      assert.equal((await evaluate("chrome.declarativeNetRequest.getDynamicRules()")).length, 0, "paused/stopped migration leaves no language rules");
    }
    await evaluate(`chrome.tabs.reload(${tab.id})`);
    const expected = mode === "active" ? { language: "ja-JP", timezone: "Asia/Tokyo" } : native;
    await waitFor(async () => {
      const live = await readLive();
      return live?.language === expected.language && live.timezone === expected.timezone;
    }, mode + " page after upgraded reload");
    const headers = await evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>fetch('/echo').then(response=>response.json())})`);
    assert.ok(headers[0].result["accept-language"].startsWith(expected.language));
    report.push(`PASS ${mode}: same ID/storage upgraded to schema 2; custom preset and requested=${requested} retained; userScripts permission absent`);
    report.push(`PASS ${mode}: refreshed page and Accept-Language ${mode === "active" ? "use Japan through ordinary content scripts" : "retain native values without region scripts/rules"}`);
    if (mode === "paused") {
      await send({ type: "enabled", value: true });
      await evaluate(`chrome.tabs.reload(${tab.id})`);
      await waitFor(async () => (await readLive())?.language === "ja-JP", "resume migrated paused intent");
      report.push("PASS paused: explicit global resume restores the previously selected Japan preset");
    }
    if (mode === "stopped") {
      await send({ type: "enabled", value: false });
      await send({ type: "enabled", value: true });
      assert.equal((await send({ type: "regionStatus", tabId: tab.id })).lifecycle.requested, false);
      assert.equal((await evaluate("chrome.scripting.getRegisteredContentScripts()")).length, 0);
      report.push("PASS stopped: global pause/resume does not reactivate explicitly stopped region intent");
    }
    await cdp("Browser.close");
  } finally {
    socket?.close();
    if (chrome.exitCode === null) chrome.kill("SIGTERM");
    if (chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
    if (chrome.exitCode === null) {
      chrome.kill("SIGKILL");
      await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1000)]);
    }
  }
}

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", request.url === "/echo" ? "application/json" : "text/html");
  response.end(request.url === "/echo" ? JSON.stringify(request.headers) : "<!doctype html><title>Local upgrade test</title><h1>Local upgrade test</h1>");
});
let failure;
try {
  const unpacked = path.join(workspace, "old-source");
  await unzip(oldZip, unpacked);
  const oldExtension = path.join(unpacked, "chrome-privacy-guard", "extension");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const localUrl = `http://127.0.0.1:${server.address().port}/`;
  for (const mode of ["active", "paused", "stopped"]) await runScenario(mode, oldExtension, localUrl);
  report.push("Network DNS/WebRTC/Shadowrocket tests and daily Chrome profiles: not accessed.");
} catch (error) {
  failure = error;
  report.push("FAIL: " + (error.stack || error.message));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(workspace, { recursive: true, force: true });
  await mkdir(path.join(root, "verification"), { recursive: true });
  await writeFile(path.join(root, "verification", "chrome-upgrade-smoke.txt"), report.join("\n") + "\n");
  console.log(report.join("\n"));
}
if (failure) throw failure;
