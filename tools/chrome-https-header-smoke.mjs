// Real-extension HTTPS header smoke test. All pages and TLS servers are authored
// here and bound to loopback; the disposable Chrome profile cannot reach the net.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createHttpsServer } from "node:https";
import { createSecureServer } from "node:http2";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeHosts = process.argv.includes("--runtime-hosts");
const headerCheck = process.argv.includes("--header-check");
const scratch = await mkdtemp(path.join(tmpdir(), "privacy-https-header-"));
const profile = path.join(scratch, "profile"), extension = path.join(scratch, "extension");
const hosts = ["privacy-header.test", "privacy-header-alt.test", ...(headerCheck ? ["who.1ms.dog"] : [])];
const reportPath = path.join(root, headerCheck ? "verification/chrome-header-check-smoke.json" : runtimeHosts ? "verification/chrome-https-header-runtime-hosts-smoke.json" : "verification/chrome-https-header-smoke.json");
const report = {
  scope: "Authored loopback HTTPS/1.1 and HTTP/2 pages, fresh Chrome profile, real extension; no online site or user session",
  certificate: "Disposable self-signed certificate; ignored only by disposable Chrome process",
  browserNetwork: "Only test hosts bypass dead proxy; both test host names resolve to 127.0.0.1",
  hostPermissionMode: runtimeHosts ? "Real optional_host_permissions granted through chrome://extensions in temporary profile" : "Optional hosts promoted to required in disposable manifest",
  profileLanguages: "zh-CN,zh", scenarios: [], requests: []
};
let chrome, cdp, stderr = "";
let headerEchoOverride = null;
const privateSentinel = "local-test-private-field-must-not-leave-page";
const servers = [], tlsSessions = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function command(binary, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", data => { error += data; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${binary} exited ${code}: ${error}`)));
  });
}

// Runs as the first inline page script, without waiting for extension readback.
function earlyProbe(navigation, crossOrigin) {
  const read = () => ({ language: navigator.language, languages: [...navigator.languages],
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dateOffset: new Date().getTimezoneOffset() });
  const state = window.httpsHeaderProbe = { navigation, initial: read(), worker: null,
    workerError: null, echoes: {}, errors: [], done: false };
  const echo = async (name, url) => {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.echoes[name] = await response.json();
    } catch (error) { state.errors.push({ name, error: String(error) }); }
  };
  const nonce = String(performance.timeOrigin);
  const worker = new Worker(URL.createObjectURL(new Blob([
    `const initial=(${read.toString()})(); fetch(${JSON.stringify(location.origin + "/api/worker-echo?nonce=") }+${JSON.stringify(nonce)}, {cache:'no-store'}).then(r=>r.json()).then(echo=>postMessage({initial,echo})).catch(error=>postMessage({initial,error:String(error)}));`
  ], { type: "text/javascript" })));
  const workerDone = new Promise(resolve => {
    const timer = setTimeout(() => { state.workerError = "Worker timed out"; worker.terminate(); resolve(); }, 5000);
    worker.onmessage = event => { state.worker = event.data; clearTimeout(timer); worker.terminate(); resolve(); };
    worker.onerror = event => { state.workerError = event.message; clearTimeout(timer); worker.terminate(); resolve(); };
  });
  Promise.all([
    echo("me", `/api/me?nonce=${nonce}`),
    echo("hints", `/api/hints?nonce=${nonce}`),
    echo("crossOrigin", `${crossOrigin}/api/cross-echo?nonce=${nonce}`), workerDone
  ]).then(() => { state.current = read(); state.done = true; });
}

function handler(label, crossOrigin) {
  return (request, response) => {
    const received = { server: label, method: request.method, url: request.url,
      host: request.headers[":authority"] || request.headers.host,
      httpVersion: request.httpVersion, alpnProtocol: request.socket.alpnProtocol || null,
      language: request.headers["accept-language"] || null, h: { ...request.headers }, at: Date.now() };
    report.requests.push(received);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.url.startsWith("/api/")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(headerCheck ? { ...received,
        ip: privateSentinel, ptr: privateSentinel, cf: { city: privateSentinel },
        h: { ...received.h, ...(headerEchoOverride ? { "accept-language": headerEchoOverride } : {}),
          cookie: privateSentinel, "x-private-field": privateSentinel } } : received)); return;
    }
    if (request.url === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><title>Local HTTPS header probe</title><script>(${earlyProbe.toString()})(${JSON.stringify(received)},${JSON.stringify(crossOrigin())});</script></head><body>Authored local HTTPS probe</body></html>`);
  };
}

async function listen(server) {
  servers.push(server);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}

try {
  await mkdir(path.join(profile, "Default"), { recursive: true });
  // A fresh profile would otherwise inherit an English baseline on some Macs.
  await writeFile(path.join(profile, "Default/Preferences"), JSON.stringify({
    intl: { accept_languages: "zh-CN,zh", selected_languages: "zh-CN,zh" }
  }));
  await cp(path.join(root, "extension"), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, "manifest.json"), "utf8"));
  // Promote only the optional tabs API for both modes. Runtime mode preserves
  // the actual optional_host_permissions and obtains their real runtime grant.
  manifest.permissions = [...new Set([...manifest.permissions, ...manifest.optional_permissions])];
  delete manifest.optional_permissions;
  if (!runtimeHosts) {
    manifest.host_permissions = manifest.optional_host_permissions;
    delete manifest.optional_host_permissions;
  }
  await writeFile(path.join(extension, "manifest.json"), JSON.stringify(manifest));
  report.version = manifest.version;
  const certConfig = path.join(scratch, "openssl.cnf");
  await writeFile(certConfig, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${hosts[0]}\n[ext]\nsubjectAltName=${hosts.map(host => "DNS:" + host).join(",")},IP:127.0.0.1\n`);
  const certPath = path.join(scratch, "cert.pem"), keyPath = path.join(scratch, "key.pem");
  await command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-config", certConfig]);
  const tls = { cert: await readFile(certPath), key: await readFile(keyPath) };
  let h1Base, h2Base;
  const h1 = createHttpsServer(tls, handler("https-http1", () => h2Base));
  h1Base = `https://${hosts[0]}:${await listen(h1)}`;
  const h2 = createSecureServer({ ...tls, allowHTTP1: true }, handler("https-http2", () => h1Base));
  h2.on("session", session => { tlsSessions.add(session); session.on("close", () => tlsSessions.delete(session)); });
  h2Base = `https://${hosts[0]}:${await listen(h2)}`;
  const alternateH2 = `https://${hosts[1]}:${h2.address().port}`;
  report.endpoints = { h1Base, h2Base, alternateH2 };
  const headerCheckOrigin = headerCheck ? `https://who.1ms.dog:${h2.address().port}` : null;
  if (headerCheck) {
    // Testing only: map the exact production origin to this server's random
    // local port. Product source and its origin validation remain unchanged.
    report.testOnlyOriginReplacement = { from: "https://who.1ms.dog", to: headerCheckOrigin };
    for (const file of ["header-check.js", "region-ui.js"]) {
      const target = path.join(extension, file), source = await readFile(target, "utf8");
      assert.ok(source.includes("https://who.1ms.dog"), file + " has the expected exact origin literal");
      await writeFile(target, source.replaceAll("https://who.1ms.dog", headerCheckOrigin));
    }
  }
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication", "--lang=zh-CN", "--ignore-certificate-errors",
    "--host-resolver-rules=" + hosts.map(host => `MAP ${host} 127.0.0.1`).join(", "),
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=" + hosts.join(";"), "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let id = 0, buffer = ""; const pending = new Map();
  chrome.stderr.on("data", data => { stderr = (stderr + data).slice(-5000); });
  chrome.stdio[4].on("data", data => {
    buffer += data.toString(); let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const entry = pending.get(message.id); if (!entry) continue;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  });
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(method + " timed out: " + stderr)); }, 10000);
    pending.set(next, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const evaluate = async (expression, sessionId) => {
    const answer = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails)); return answer.result.value;
  };
  const waitFor = async (fn, name) => {
    for (let i = 0; i < 120; i++) {
      try { if (await fn()) return; }
      catch (error) { if (!/context.*destroyed|Cannot find context|No execution context|Frame.*removed|No frame/i.test(error.message)) throw error; }
      await delay(50);
    }
    throw new Error("Timed out: " + name);
  };
  report.browser = await cdp("Browser.getVersion");
  const { id: extensionId } = await cdp("Extensions.loadUnpacked", { path: extension });
  const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
  const { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await waitFor(() => evaluate("Boolean(globalThis.chrome?.runtime)", sessionId), "extension popup");
  const send = async message => {
    const result = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`, sessionId);
    assert.ok(result.ok, JSON.stringify(result)); return result.data;
  };
  if (runtimeHosts) {
    report.runtimeHostGrant = { before: await evaluate("chrome.permissions.getAll()", sessionId), supported: false };
    const { targetId: managerTarget } = await cdp("Target.createTarget", { url: "chrome://extensions/" });
    const { sessionId: managerSession } = await cdp("Target.attachToTarget", { targetId: managerTarget, flatten: true });
    await waitFor(() => evaluate("Boolean(chrome.developerPrivate?.addHostPermission)", managerSession), "chrome://extensions developerPrivate host grant API");
    const grant = await evaluate(`(async()=>{
      const invoke=(method,...args)=>new Promise((resolve,reject)=>chrome.developerPrivate[method](...args,(result)=>{
        const error=chrome.runtime.lastError;if(error)reject(new Error(error.message));else resolve(result??null);
      }));
      await invoke('updateProfileConfiguration',{inDeveloperMode:true});
      const results=[];
      for(const host of ['http://*/*','https://*/*']){
        results.push({host,result:await invoke('addHostPermission',${JSON.stringify(extensionId)},host)});
      }
      results.push({configuration:'ON_ALL_SITES',result:await invoke('updateExtensionConfiguration',{extensionId:${JSON.stringify(extensionId)},hostAccess:'ON_ALL_SITES'})});
      return results;
    })()`, managerSession);
    report.runtimeHostGrant.supported = true;
    report.runtimeHostGrant.results = grant;
    report.runtimeHostGrant.after = await evaluate("chrome.permissions.getAll()", sessionId);
    report.runtimeHostGrant.containsAllOrigins = await evaluate("chrome.permissions.contains({origins:['http://*/*','https://*/*']})", sessionId);
    try {
      await waitFor(() => evaluate("chrome.permissions.contains({origins:['http://*/*','https://*/*']})", sessionId), "real all-origins runtime host permission");
    } catch {
      report.unsupported = true;
      report.runtimeHostGrant.supported = false;
      report.runtimeHostGrant.unsupportedReason = "Chrome developerPrivate host grant APIs returned success but did not activate the unchanged optional host permissions (getAll().origins remains empty and contains() is false). Region mode was not applied; this run provides no runtime-host DNR verdict.";
      throw new Error(report.runtimeHostGrant.unsupportedReason);
    }
    report.runtimeHostGrant.after = await evaluate("chrome.permissions.getAll()", sessionId);
    report.runtimeHostGrant.containsAllOrigins = await evaluate("chrome.permissions.contains({origins:['http://*/*','https://*/*']})", sessionId);
    assert.equal(report.runtimeHostGrant.containsAllOrigins, true, "real runtime host grants present before apply");
    await cdp("Target.closeTarget", { targetId: managerTarget });
  }
  await send({ type: "status" });
  const tab = await evaluate(`chrome.tabs.create({url:${JSON.stringify(h2Base + "/native-h2")},active:false})`, sessionId);
  const readProbe = () => evaluate(`chrome.scripting.executeScript({target:{tabId:${tab.id}},world:'MAIN',func:()=>window.httpsHeaderProbe}).then(result=>result[0]?.result)`, sessionId);
  const collect = async (name, expectedPath) => {
    await waitFor(async () => { const probe = await readProbe(); return probe?.done && probe.navigation.url === expectedPath; }, name);
    const probe = await readProbe(); report.scenarios.push({ name, ...probe });
    assert.deepEqual(probe.errors, [], name + " fetches succeed");
    assert.equal(probe.workerError, null, name + " early Worker succeeds");
    assert.equal(probe.worker?.error, undefined, name + " Worker fetch succeeds");
    console.log(name + ": " + JSON.stringify({ protocol: probe.navigation.httpVersion,
      navigation: probe.navigation.language, me: probe.echoes.me?.language,
      hints: probe.echoes.hints?.language, crossOrigin: probe.echoes.crossOrigin?.language,
      worker: probe.worker?.echo?.language, pageLanguage: probe.initial.language,
      timezone: probe.initial.timezone, workerInitial: probe.worker?.initial }));
    return probe;
  };
  const native = await collect("native-http2", "/native-h2");
  report.native = native.initial;
  assert.ok(native.navigation.language?.startsWith("zh-CN"), "Chinese native navigation baseline");
  await evaluate(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(h1Base + "/native-h1")}})`, sessionId);
  await collect("native-http1", "/native-h1");
  report.apply = await send({ type: "regionApply", tabId: tab.id, profileId: "us-en" });
  report.rules = await evaluate("chrome.declarativeNetRequest.getDynamicRules()", sessionId);
  report.permissions = await evaluate("chrome.permissions.getAll()", sessionId);
  report.registeredScripts = await evaluate("chrome.scripting.getRegisteredContentScripts()", sessionId);
  const verifySelected = probe => {
    assert.equal(probe.initial.language, "en-US", "first script sees selected language");
    assert.deepEqual(probe.initial.languages, ["en-US", "en"]);
    assert.equal(probe.initial.timezone, "America/Los_Angeles");
    assert.deepEqual(probe.worker.initial, probe.initial, "first Worker matches first page read");
    assert.deepEqual(probe.current, probe.initial, "initial and final page readings agree");
    const received = [probe.navigation, ...Object.values(probe.echoes), probe.worker.echo];
    for (const echo of received) assert.equal(echo.language, "en-US,en;q=0.9", `${echo.server} ${echo.url} receives selected header`);
  };
  const applied = await collect("us-apply-http1", "/native-h1"); verifySelected(applied);
  for (const [name, base, route, version] of [
    ["us-fresh-http2", h2Base, "/us-h2", "2.0"],
    ["us-alternate-host-http2", alternateH2, "/us-alt-h2", "2.0"],
    ["us-fresh-http1", h1Base, "/us-h1", "1.1"]
  ]) {
    await evaluate(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(base + route)}})`, sessionId);
    const probe = await collect(name, route); verifySelected(probe);
    assert.equal(probe.navigation.httpVersion, version, name + " negotiated expected protocol");
  }
  if (headerCheck) {
    await evaluate(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(headerCheckOrigin + "/authored")}})`, sessionId);
    verifySelected(await collect("us-header-check-authored-page", "/authored"));
    const { targetId: uiTarget } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html?view=manage&tab=${tab.id}` });
    const { sessionId: uiSession } = await cdp("Target.attachToTarget", { targetId: uiTarget, flatten: true });
    await waitFor(() => evaluate("Boolean(document.querySelector('.region-header-check')&&!document.querySelector('.region-header-check').hidden&&![...document.querySelectorAll('button')].find(x=>x.textContent==='核对本站语言请求头')?.disabled)", uiSession), "real header-check UI ready");
    // Observe the actual runtime response without changing its value or request.
    await evaluate(`(()=>{
      window.observedHeaderChecks=[];
      const original=chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage=(...args)=>{
        const result=original(...args);
        if(args[0]?.type==='regionHeaderCheck') result.then(value=>window.observedHeaderChecks.push(value));
        return result;
      };
    })()`, uiSession);
    report.headerChecks = [];
    for (const [name, override, status] of [["server-echo-matches", null, "match"], ["controlled-server-echo-chinese", "zh-CN,zh;q=0.9", "mismatch"]]) {
      headerEchoOverride = override;
      const previous = await evaluate("window.observedHeaderChecks.length", uiSession);
      await evaluate("[...document.querySelectorAll('button')].find(x=>x.textContent==='核对本站语言请求头').click()", uiSession);
      await waitFor(() => evaluate(`window.observedHeaderChecks.length>${previous}&&![...document.querySelectorAll('button')].find(x=>x.textContent==='核对本站语言请求头').disabled`, uiSession), "header-check UI " + name);
      const actual = await evaluate("({response:window.observedHeaderChecks.at(-1),text:document.querySelector('.region-header-result').textContent,warning:document.querySelector('.region-header-result').classList.contains('is-warning')})", uiSession);
      const latestRequest = report.requests.filter(item => item.url.startsWith("/api/me?privacy_guard_check=")).at(-1);
      report.headerChecks.push({ name, controlledEchoOverride: override, actualRequestLanguage: latestRequest?.language, ...actual });
      assert.equal(actual.response?.ok, true, name + " real background response succeeds");
      assert.equal(actual.response.data.status, status, name + " classified correctly");
      assert.equal(latestRequest?.language, "en-US,en;q=0.9", name + " real request stays English");
      assert.equal(actual.warning, status !== "match", name + " UI warning state");
      assert.ok(actual.text.includes(status === "match" ? "首选语言一致" : "语言不一致"), name + " real UI result");
      assert.equal(JSON.stringify(actual).includes(privateSentinel), false, "private response fields do not cross back to extension UI");
      console.log("header-check " + name + ": " + JSON.stringify(actual));
    }
    await cdp("Emulation.setDeviceMetricsOverride", { width: 1060, height: 1000, deviceScaleFactor: 1, mobile: false }, uiSession);
    const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, uiSession);
    await writeFile(path.join(root, "verification/header-check.png"), Buffer.from(screenshot.data, "base64"));
    report.screenshot = "verification/header-check.png";
    report.headerCheckPassed = true;
  }
  report.httpsHeaderMismatchReproduced = report.scenarios.filter(item => item.name.startsWith("us-")).some(probe =>
    [probe.navigation, ...Object.values(probe.echoes), probe.worker?.echo].some(echo => echo?.language !== "en-US,en;q=0.9"));
  report.passed = true;
} catch (error) {
  report.passed = report.unsupported ? null : false;
  report.error = report.unsupported ? error.message : error.stack;
  process.exitCode = report.unsupported ? 0 : 1; console.error(report.error);
} finally {
  try { if (cdp) await cdp("Browser.close"); } catch {}
  if (chrome?.exitCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
  if (chrome?.exitCode === null) chrome.kill("SIGKILL");
  for (const session of tlsSessions) session.destroy();
  for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  await rm(scratch, { recursive: true, force: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
