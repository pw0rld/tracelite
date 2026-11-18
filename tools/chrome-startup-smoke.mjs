// Verifies startup remains usable around loading/unresponsive pages. Use
// --reproduce-old to demonstrate the same scenarios against the saved v0.4.0.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reproduceOld = process.argv.includes("--reproduce-old");
const extensionSource = process.env.PRIVACY_GUARD_EXTENSION_DIR
  || (reproduceOld ? "/tmp/privacy-guard-startup-v040-unfixed" : path.join(root, "extension"));
const report = [];
const log = (...parts) => { const line = parts.join(" "); report.push(line); console.log(line); };
const profile = await mkdtemp(path.join(tmpdir(), "privacy-guard-startup-profile-"));
const extension = await mkdtemp(path.join(tmpdir(), "privacy-guard-startup-extension-"));
await cp(extensionSource, extension, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json")));
manifest.permissions.push(...manifest.optional_permissions);
manifest.host_permissions = manifest.optional_host_permissions;
delete manifest.optional_permissions;
delete manifest.optional_host_permissions;
await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
const held = new Map();
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/never") {
    held.set(url.searchParams.get("id"), res);
    req.on("close", () => {
      if (held.get(url.searchParams.get("id")) === res) held.delete(url.searchParams.get("id"));
    });
    return;
  }
  res.setHeader("Content-Type", "text/html");
  const pendingResource = url.pathname === "/parser-hang" ? `<script src="/never?id=${url.searchParams.get("id")}"></script>`
    : url.pathname === "/hang" ? `<img src="/never?id=${url.searchParams.get("id")}">` : "";
  res.end(`<!doctype html><title>${url.pathname}</title>${pendingResource}<h1>Local queue test</h1>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const release = id => {
  const response = held.get(id);
  assert.ok(response, `pending resource exists: ${id}`);
  held.delete(id);
  response.writeHead(204); response.end();
};
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication",
  "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
let stderr = "", socket;
chrome.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-5000); });
try {
  let portData;
  for (let i = 0; i < 100; i++) {
    try {
      const candidate = await readFile(path.join(profile, "DevToolsActivePort"), "utf8");
      if (/^\d+\n\/devtools\/browser\//.test(candidate)) { portData = candidate; break; }
    } catch {}
    if (chrome.exitCode !== null) throw new Error("Chrome exited: " + stderr);
    await delay(100);
  }
  assert.ok(portData, "Chrome debugger started");
  const [port, endpoint] = portData.trim().split("\n");
  socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map(), events = new Set();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id) { for (const listener of events) listener(message); return; }
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id); clearTimeout(callback.timer);
    if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out")); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evaluate = async (expression, sessionId) => {
    const result = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (check, label) => {
    for (let i = 0; i < 60; i++) { if (await check()) return; await delay(50); }
    throw new Error("Timed out: " + label);
  };
  const within = async (promise, milliseconds = 1500) => Promise.race([
    promise.then(value => ({ settled: true, value })), delay(milliseconds).then(() => ({ settled: false }))
  ]);
  log("Browser", (await cdp("Browser.getVersion")).product);
  log("Extension", manifest.version, reproduceOld ? "(expected old stalls)" : "(startup regression)");
  const { id: extensionId } = await cdp("Extensions.loadUnpacked", { path: extension });
  const { targetId: popupTarget } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
  const { sessionId: popup } = await cdp("Target.attachToTarget", { targetId: popupTarget, flatten: true });
  await delay(700);
  const send = message => evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`, popup);
  assert.equal((await send({ type: "status" })).ok, true);
  const createTab = async label => {
    const tab = await evaluate(`chrome.tabs.create({url:${JSON.stringify(base + "/" + label)},active:false})`, popup);
    const targets = (await cdp("Target.getTargets")).targetInfos;
    const target = targets.find(target => target.url === base + "/" + label);
    assert.ok(target, "local target found");
    const { sessionId } = await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    await cdp("Page.enable", {}, sessionId);
    await waitFor(async () => (await evaluate("document.readyState", sessionId)) === "complete", label + " loaded");
    return { id: tab.id, sessionId };
  };
  const a = await createTab("a"), b = await createTab("b");
  const checkPopup = async tabId => {
    const { targetId } = await cdp("Target.createTarget", {
      url: `chrome-extension://${extensionId}/popup.html?view=manage&tab=${tabId}`, background: true
    });
    const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
    try {
      await waitFor(() => evaluate(`document.querySelectorAll('#region-profile option').length >= 4
        && !document.querySelector('#region-profile').disabled
        && document.querySelectorAll('#settings .setting').length === 7
        && !document.querySelector('#enabled').disabled`, sessionId), "real popup settings and preset selector");
      const state = await evaluate(`({summary:document.querySelector('#summary').textContent,
        presets:Array.from(document.querySelectorAll('#region-profile option')).map(item=>item.value),
        applyEnabled:!document.querySelector('#region-panel .primary-button').disabled,
        settingsEnabled:Array.from(document.querySelectorAll('#settings input')).every(item=>!item.disabled)})`, sessionId);
      assert.equal(state.applyEnabled, true); assert.equal(state.settingsEnabled, true);
      log("PASS: real popup remains usable:", JSON.stringify(state));
    } finally { await cdp("Target.closeTarget", { targetId }); }
  };
  const navigateHang = async (tab, name, resource = "script") => {
    await cdp("Page.navigate", { url: base + (resource === "script" ? "/parser-hang" : "/hang") + "?id=" + name }, tab.sessionId);
    await waitFor(async () => held.has(name) && (await evaluate("document.readyState", tab.sessionId)) === (resource === "script" ? "loading" : "interactive"), name + " loading");
  };
  // A parser-blocking external script delays document_idle but still lets CDP
  // read the page. An image alone does not reliably defer Chrome's idle window.
  await navigateHang(b, "readback");
  const readback = send({ type: "regionStatus", tabId: b.id });
  const readbackResult = await within(readback);
  log("loading-page regionStatus settled within 1500ms:", readbackResult.settled);
  const statusBehindReadback = send({ type: "status" });
  const statusResult = await within(statusBehindReadback);
  log("base status queued behind loading readback settled within 1500ms:", statusResult.settled);
  assert.equal(readbackResult.settled, !reproduceOld, "loading-page regionStatus response");
  assert.equal(statusResult.settled, !reproduceOld, "base settings response around page readback");
  if (!reproduceOld) {
    assert.ok(readbackResult.value.data.profiles.length >= 4);
    assert.equal(statusResult.value.data.settings.length, 7);
    await checkPopup(b.id);
  }
  release("readback");
  assert.equal((await readback).ok, true);
  assert.equal((await statusBehindReadback).ok, true);
  log(reproduceOld ? "PASS: releasing only the parser-blocking script unblocks both old requests"
    : "PASS: loading-page readback and base settings complete before the page finishes");

  // Queue an old complete event while another tab occupies the queue. By the
  // time that event runs, its tab has navigated to a new never-completing page.
  assert.equal((await send({ type: "regionApply", profileId: "jp", tabId: a.id })).ok, true);
  await waitFor(async () => (await evaluate("document.readyState", a.sessionId)) === "complete", "applied page reload");
  assert.equal((await send({ type: "regionStop" })).ok, true);
  await navigateHang(b, "blocker");
  const blocker = send({ type: "regionStatus", tabId: b.id });
  assert.equal((await within(blocker, 1500)).settled, !reproduceOld);
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { events.delete(listener); reject(new Error("A complete event missing")); }, 5000);
    const listener = event => {
      if (event.method === "Page.loadEventFired" && event.sessionId === a.sessionId) {
        clearTimeout(timer); events.delete(listener); resolve();
      }
    };
    events.add(listener);
  });
  await cdp("Page.navigate", { url: base + "/a-loaded" }, a.sessionId);
  await loaded;
  await navigateHang(a, "old-complete");
  release("blocker");
  assert.equal((await blocker).ok, true);
  const statusBehindComplete = send({ type: "status" });
  const completeResult = await within(statusBehindComplete);
  log("base status behind stale complete event settled within 1500ms:", completeResult.settled);
  assert.equal(completeResult.settled, !reproduceOld, "base settings remain independent of a stale complete event");
  release("old-complete");
  assert.equal((await statusBehindComplete).ok, true);
  log(reproduceOld ? "PASS: releasing replacement page script unblocks old stale complete handler"
    : "PASS: complete-then-loading navigation does not stall popup startup status");

  if (!reproduceOld) {
    // Unlike an external script that has not arrived, synchronous page code can
    // prevent even injectImmediately from running. Only this disposable tab is
    // stopped, and CDP explicitly terminates the loop after observing fallback.
    const busy = await createTab("busy");
    const spinning = cdp("Runtime.evaluate", { expression: "while (true) {}" }, busy.sessionId)
      .then(result => ({ result }), error => ({ error }));
    try {
      await delay(100);
      const started = Date.now();
      const blockedReadback = send({ type: "regionStatus", tabId: busy.id });
      const basic = await within(send({ type: "status" }), 800);
      assert.equal(basic.settled, true, "blocked renderer does not block base settings");
      const timedOut = await within(blockedReadback, 1800);
      assert.equal(timedOut.settled, true, "page readback has a bounded timeout");
      assert.equal(timedOut.value.ok, true);
      assert.match(timedOut.value.data.readError, /超时/);
      assert.ok(timedOut.value.data.profiles.length >= 4);
      log("PASS: busy renderer readback returns timeout with presets after", Date.now() - started, "ms; base settings remain available");
      await checkPopup(busy.id);
    } finally {
      await cdp("Runtime.terminateExecution", {}, busy.sessionId);
      const stopped = await spinning;
      if (stopped.error) assert.match(stopped.error.message, /Execution was terminated/);
    }
  }
  await cdp("Browser.close");
} finally {
  const reportPath = reproduceOld ? path.join(tmpdir(), "privacy-guard-startup-smoke-old.txt") : path.join(root, "verification", "chrome-startup-smoke.txt");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report.join("\n") + "\n");
  for (const response of held.values()) response.destroy();
  held.clear();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  socket?.close();
  if (chrome.exitCode === null) chrome.kill("SIGTERM");
  await delay(300);
  await Promise.all([rm(profile, { recursive: true, force: true }), rm(extension, { recursive: true, force: true })]);
}
