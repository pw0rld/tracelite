// Real site cleanup through the extension UI/background. Both origins, cookies,
// data, service worker, HTTP cache and TLS certificate are disposable fixtures.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:https";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "privacy-cleanup-"));
const profile = path.join(scratch, "profile"), extension = path.join(scratch, "extension");
const hosts = ["cleanup-a.test", "cleanup-b.test"];
const report = { scope: "Real Chrome extension UI and background cleanup of authored HTTPS loopback fixtures only",
  setup: "Temporary profile; optional browsingData/tabs/hosts pregranted in temporary manifest; initial permission dialog not tested",
  network: "Both .test origins map to 127.0.0.1; only those hosts bypass a dead outbound proxy",
  certificate: "Disposable self-signed certificate; exact SPKI exception only in temporary Chrome process, no system trust changes",
  stages: [], dialogs: [], cacheNetworkCounts: {} };
const counts = new Map();
let chrome, cdp, server, stderr = "";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function command(binary, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", data => { error += data; });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${binary} exited ${code}: ${error}`)));
  });
}

function authoredFixture() {
  const dbName = "cleanup-smoke-db", cacheName = "cleanup-smoke-cache";
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  window.cleanupFixture = {
    async seed(label) {
      document.cookie = `cleanup_dummy=${label}; Path=/; Secure; SameSite=Lax`;
      localStorage.setItem("cleanup_dummy", label);
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("records");
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("records", "readwrite");
        transaction.objectStore("records").put(label, "dummy");
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
      }); db.close();
      const cache = await caches.open(cacheName);
      await cache.put(new Request(location.origin + "/cache-storage-entry"), new Response(label));
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/sw-scope/" });
      const until = performance.now() + 7000;
      while (registration.active?.state !== "activated") {
        if (performance.now() > until) throw new Error("Fixture service worker did not activate");
        await wait(25);
      }
      return this.snapshot();
    },
    async snapshot() {
      const databases = await indexedDB.databases();
      const cacheNames = await caches.keys();
      const registrations = await navigator.serviceWorker.getRegistrations();
      const storedResponse = await caches.match(location.origin + "/cache-storage-entry");
      const httpCache = await fetch("/http-cache-entry", { cache: "force-cache" }).then(response => response.json());
      return { cookie: document.cookie, localStorage: localStorage.getItem("cleanup_dummy"),
        indexedDB: databases.some(item => item.name === dbName), cacheNames,
        cacheStorage: storedResponse ? await storedResponse.text() : null,
        serviceWorkerScopes: registrations.map(item => item.scope), controlledByServiceWorker: !!navigator.serviceWorker.controller,
        httpCache };
    }
  };
}

try {
  await mkdir(profile); await cp(path.join(root, "extension"), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
  manifest.permissions = [...new Set([...manifest.permissions, ...manifest.optional_permissions, "browsingData", "tabs"])];
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_permissions; delete manifest.optional_host_permissions;
  await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(extension, "cleanup-probe.html"), "<!doctype html><title>Local cleanup status probe</title>");
  report.version = manifest.version;
  const certConfig = path.join(scratch, "openssl.cnf"), certPath = path.join(scratch, "cert.pem"), keyPath = path.join(scratch, "key.pem");
  await writeFile(certConfig, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${hosts[0]}\n[ext]\nsubjectAltName=${hosts.map(host => "DNS:" + host).join(",")},IP:127.0.0.1\n`);
  await command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certPath, "-config", certConfig]);
  const cert = await readFile(certPath), key = await readFile(keyPath);
  const certificateSPKI = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  server = createServer({ cert, key }, (request, response) => {
    const host = request.headers.host.split(":")[0];
    if (!hosts.includes(host)) { response.writeHead(403); response.end(); return; }
    if (request.url === "/http-cache-entry") {
      const count = (counts.get(host) || 0) + 1; counts.set(host, count);
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=31536000, immutable", ETag: `"${host}-dummy-cache-id"` });
      response.end(JSON.stringify({ host, networkCount: count, id: host + "-dummy-cache-id" })); return;
    }
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/sw.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end("self.addEventListener('install',event=>event.waitUntil(self.skipWaiting())); self.addEventListener('activate',event=>event.waitUntil(Promise.resolve()));"); return;
    }
    if (request.url === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>Authored cleanup fixture</title><script>(${authoredFixture.toString()})();</script><body>Local cleanup fixture; storage is created only by explicit test commands.</body>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port, originA = `https://${hosts[0]}:${port}`, originB = `https://${hosts[1]}:${port}`;
  report.origins = { a: originA, b: originB };
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication", `--ignore-certificate-errors-spki-list=${certificateSPKI}`,
    "--host-resolver-rules=" + hosts.map(host => `MAP ${host} 127.0.0.1`).join(", "),
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=" + hosts.join(";"), "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let id = 0, buffer = ""; const pending = new Map(), acceptedDialogs = new Set();
  chrome.stderr.on("data", data => { stderr = (stderr + data).slice(-5000); });
  chrome.stdio[4].on("data", data => {
    buffer += data.toString(); let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.method === "Page.javascriptDialogOpening") {
        report.dialogs.push({ type: message.params.type, message: message.params.message });
        cdp("Page.handleJavaScriptDialog", { accept: acceptedDialogs.has(message.sessionId) }, message.sessionId).catch(() => {});
        continue;
      }
      const entry = pending.get(message.id); if (!entry) continue;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  });
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(method + " timed out: " + stderr)); }, 12000);
    pending.set(next, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const evaluate = async (expression, sessionId, userGesture = false) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const attach = async targetId => ({ targetId, ...(await cdp("Target.attachToTarget", { targetId, flatten: true })) });
  const open = async url => attach((await cdp("Target.createTarget", { url })).targetId);
  const waitFor = async (test, label) => {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      try { if (await test()) return; }
      catch (error) { if (!/context.*destroyed|Cannot find context|No execution context|Frame.*removed|No frame/i.test(error.message)) throw error; }
      await delay(30);
    }
    throw new Error("Timed out: " + label);
  };
  report.browser = (await cdp("Browser.getVersion")).product;
  const extensionId = (await cdp("Extensions.loadUnpacked", { path: extension })).id;
  const probe = await open(`chrome-extension://${extensionId}/cleanup-probe.html`);
  await waitFor(() => evaluate("!!globalThis.chrome?.runtime", probe.sessionId), "extension APIs");
  const send = async message => {
    const response = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`, probe.sessionId);
    assert.ok(response?.ok, JSON.stringify(response)); return response.data;
  };
  await send({ type: "status" });
  const tabA = await evaluate(`chrome.tabs.create({url:${JSON.stringify(originA + "/fixture")},active:false})`, probe.sessionId);
  const tabB = await evaluate(`chrome.tabs.create({url:${JSON.stringify(originB + "/fixture")},active:false})`, probe.sessionId);
  const targets = (await cdp("Target.getTargets")).targetInfos;
  const targetA = await attach(targets.find(target => target.url === originA + "/fixture").targetId);
  const targetB = await attach(targets.find(target => target.url === originB + "/fixture").targetId);
  for (const target of [targetA, targetB]) await waitFor(() => evaluate("!!window.cleanupFixture", target.sessionId), "fixture helpers");
  const snapshot = target => evaluate("cleanupFixture.snapshot()", target.sessionId);
  const expectData = (value, present, label) => {
    assert.equal(value.localStorage, present ? label : null, "LocalStorage contents");
    assert.equal(value.cookie.includes("cleanup_dummy=" + label), present, "Cookie contents");
    assert.equal(value.indexedDB, present, "IndexedDB presence");
    assert.equal(value.cacheNames.includes("cleanup-smoke-cache"), present, "CacheStorage name");
    assert.equal(value.cacheStorage, present ? label : null, "CacheStorage contents");
    assert.equal(value.serviceWorkerScopes.some(scope => scope.endsWith("/sw-scope/")), present, "Service Worker registration");
    assert.equal(value.controlledByServiceWorker, false, "fixture requests never use a controlling Service Worker");
  };
  const baselineA = await evaluate("cleanupFixture.seed('a-dummy')", targetA.sessionId);
  const baselineB = await evaluate("cleanupFixture.seed('b-dummy')", targetB.sessionId);
  expectData(baselineA, true, "a-dummy"); expectData(baselineB, true, "b-dummy");
  assert.equal((await snapshot(targetA)).httpCache.networkCount, baselineA.httpCache.networkCount);
  assert.equal((await snapshot(targetB)).httpCache.networkCount, baselineB.httpCache.networkCount);
  report.stages.push({ name: "both-origins-seeded", a: baselineA, b: baselineB });

  let ui;
  const openUI = async () => {
    ui = await open(`chrome-extension://${extensionId}/popup.html?view=manage&tab=${tabA.id}`);
    await cdp("Page.enable", {}, ui.sessionId); acceptedDialogs.add(ui.sessionId);
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1180, height: 1000, deviceScaleFactor: 1, mobile: false }, ui.sessionId);
    await cdp("Page.bringToFront", {}, ui.sessionId);
    await waitFor(() => evaluate(`!!document.querySelector('#clear-site-cache') && !document.querySelector('#clear-site-cache').disabled && !document.querySelector('#enabled').disabled && document.querySelector('#origin').textContent===${JSON.stringify(originA)}`, ui.sessionId), "cleanup and native popup state ready");
    await evaluate("if(document.querySelector('#settings-drawer')&&!document.querySelector('#settings-drawer').hidden)document.querySelector('#settings-close').click()", ui.sessionId);
    await evaluate(`window.cleanupStarts=[];window.cleanupMessages=[];window.cleanupErrors=[];window.addEventListener('error',event=>cleanupErrors.push(event.message));window.addEventListener('unhandledrejection',event=>cleanupErrors.push(String(event.reason)));const originalSend=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(...args)=>{cleanupMessages.push(args[0]?.type);const response=originalSend(...args);if(args[0]?.type==='cleanupStart')response.then(result=>cleanupStarts.push(result));return response;};`, ui.sessionId);
  };
  const clickCleanup = async kind => {
    const count = await evaluate("cleanupStarts.length", ui.sessionId);
    await waitFor(() => evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(kind === "cache" ? "#clear-site-cache" : "#clear-site-data")});if(button.disabled)return false;button.click();return true;})()`, ui.sessionId, true), "enabled cleanup click " + kind);
    let answer;
    try { await waitFor(async () => { answer = await evaluate(`cleanupStarts[${count}]`, ui.sessionId); return !!answer; }, "cleanup start " + kind); }
    catch (error) {
      report.failedUICheck = await evaluate(`(async()=>({text:document.querySelector('#cleanup-result').textContent,scope:document.querySelector('#cleanup-scope').textContent,cacheDisabled:document.querySelector('#clear-site-cache').disabled,dataDisabled:document.querySelector('#clear-site-data').disabled,messages:cleanupMessages,errors:cleanupErrors,permissions:await chrome.permissions.getAll()}))()`,ui.sessionId);
      console.error(JSON.stringify(report.failedUICheck)); throw error;
    }
    assert.ok(answer.ok, JSON.stringify(answer)); assert.equal(answer.data.kind, kind); assert.equal(answer.data.origin, originA);
    return answer.data;
  };
  const awaitDone = async id => {
    let job;
    await waitFor(async () => { job = await send({ type: "cleanupStatus", id }); return job?.state !== "running"; }, "cleanup completion");
    assert.equal(job?.state, "done", JSON.stringify(job)); return job;
  };
  await openUI();
  const cacheJob = await clickCleanup("cache");
  const closedAt = Date.now(); await cdp("Target.closeTarget", { targetId: ui.targetId });
  const cacheDone = await awaitDone(cacheJob.id);
  report.popupClosedAfterCacheStart = { startedState: cacheJob.state, closedAt, completion: cacheDone,
    note: "Real removal may finish before popup closure; no artificial browser delay was introduced" };
  const afterCacheA = await snapshot(targetA), afterCacheB = await snapshot(targetB);
  expectData(afterCacheA, true, "a-dummy"); expectData(afterCacheB, true, "b-dummy");
  assert.ok(afterCacheA.httpCache.networkCount > baselineA.httpCache.networkCount, "A's HTTP cache was removed");
  assert.equal(afterCacheB.httpCache.networkCount, baselineB.httpCache.networkCount, "B's HTTP cache was retained");
  report.stages.push({ name: "cache-only-a", job: cacheDone, a: afterCacheA, b: afterCacheB });

  await send({ type: "enabled", value: false });
  await openUI();
  const dataJob = await clickCleanup("data"), dataDone = await awaitDone(dataJob.id);
  for (const target of [targetA, targetB]) {
    const oldTimeOrigin = await evaluate("performance.timeOrigin", target.sessionId);
    await cdp("Page.reload", {}, target.sessionId);
    await waitFor(() => evaluate(`performance.timeOrigin!==${oldTimeOrigin} && !!window.cleanupFixture`, target.sessionId), "fresh fixture document after data cleanup");
  }
  const afterDataA = await snapshot(targetA), afterDataB = await snapshot(targetB);
  expectData(afterDataA, false, "a-dummy"); expectData(afterDataB, true, "b-dummy");
  assert.equal(afterDataA.httpCache.networkCount, afterCacheA.httpCache.networkCount, "data cleanup retains A's independently cached HTTP resource");
  assert.equal(afterDataB.httpCache.networkCount, baselineB.httpCache.networkCount, "B's cache is still untouched");
  const paused = await send({ type: "status" });
  assert.equal(paused.config.enabled, false, "manual cleanup cannot resume paused settings");
  report.stages.push({ name: "data-only-a-while-paused-fresh-documents", job: dataDone, a: afterDataA, b: afterDataB, globalEnabled: paused.config.enabled });
  await waitFor(() => evaluate("document.querySelector('#cleanup-result').textContent.includes('站点数据清理已完成')", ui.sessionId), "UI completed text");
  const clip = await evaluate("(()=>{const r=document.body.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()",ui.sessionId);
  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip }, ui.sessionId);
  await writeFile(path.join(root, "verification/cleaning-panel.png"), Buffer.from(screenshot.data, "base64"));
  report.screenshot = "verification/cleaning-panel.png";
  assert.equal(report.dialogs.length, 2, "each destructive action has its own visible confirmation");
  assert.ok(report.dialogs.every(dialog => dialog.type === "confirm" && dialog.message.includes(originA)));
  assert.ok(report.dialogs.some(dialog => dialog.message.includes("同一可注册主域及其子域")));
  report.cacheNetworkCounts = Object.fromEntries(counts);
  report.passed = true;
  console.log(JSON.stringify({ passed: true, browser: report.browser, version: report.version,
    cacheNetworkCounts: report.cacheNetworkCounts, confirmedActions: report.dialogs.length,
    stages: report.stages.map(stage => stage.name) }));
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1; console.error(report.error);
} finally {
  try { if (cdp) await cdp("Browser.close"); } catch {}
  if (chrome?.exitCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
  if (chrome?.exitCode === null) chrome.kill("SIGKILL");
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  await rm(scratch, { recursive: true, force: true });
  await mkdir(path.join(root, "verification"), { recursive: true });
  await writeFile(path.join(root, "verification/chrome-cleanup-smoke.json"), JSON.stringify(report, null, 2) + "\n");
}
