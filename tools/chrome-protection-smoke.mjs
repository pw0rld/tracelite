// Real MV3 request-protection regression in a disposable browser profile.
// All HTTPS hosts, including the tracker name, map to authored loopback servers.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSecureServer } from "node:http2";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserName = process.argv.find(value => value.startsWith("--browser="))?.split("=")[1] || "chrome";
assert.ok(["chrome", "brave"].includes(browserName), "supported browser: chrome or brave");
const binary = browserName === "brave" ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const reportPath = path.join(root, `verification/${browserName === "brave" ? "brave" : "chrome"}-protection-smoke.json`);
const scratch = await mkdtemp(path.join(tmpdir(), "privacy-protection-"));
const extension = path.join(scratch, "extension"), profile = path.join(scratch, "profile");
const report = { scope: "Authored loopback HTTPS only, disposable profile, real unpacked extension",
  permissions: "Optional tabs, hosts, browsingData pregranted only in the disposable copy; first native permission dialogs not tested",
  isolation: "All test names map to 127.0.0.1 and only these hosts bypass a dead proxy; no daily browser configuration used",
  browserName, requests: [], stages: [], assertions: [], passed: false };
let chrome, cdp, stderr = "", server;
const sockets = new Set();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function command(binary, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", value => { error += value; });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(error)));
  });
}
function pageRead() {
  const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 32;
  const context = canvas.getContext("2d"); context.font = "14px sans-serif"; context.fillText("local privacy fixture", 2, 20);
  return { userAgent: navigator.userAgent, canvas: canvas.toDataURL(), language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
function assertStage(name, value) { report.assertions.push(name); if (value !== undefined) report.stages.push({ name, ...value }); console.log("PASS " + name); }

try {
  const tracking = await import(pathToFileURL(path.join(root, "extension/tracking-rules.js")));
  const domains = tracking.TRACKING_DOMAINS;
  assert.ok(Array.isArray(domains) && typeof domains[0] === "string", "tracking module exports the actual bundled domain list");
  const trackerHost = domains[0];
  const hosts = ["privacy-protection.test", "privacy-ordinary.test", trackerHost];
  report.trackerHost = trackerHost;
  await mkdir(path.join(profile, "Default"), { recursive: true });
  await writeFile(path.join(profile, "Default/Preferences"), JSON.stringify({ intl: { accept_languages: "zh-CN,zh" } }));
  await cp(path.join(root, "extension"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...new Set([...manifest.permissions, ...(manifest.optional_permissions || [])])];
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_permissions; delete manifest.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(manifest)); report.version = manifest.version;
  const certConfig = path.join(scratch, "openssl.cnf");
  await writeFile(certConfig, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${hosts[0]}\n[ext]\nsubjectAltName=${hosts.map(host => "DNS:" + host).join(",")},IP:127.0.0.1\n`);
  const keyPath = path.join(scratch, "key.pem"), certPath = path.join(scratch, "cert.pem");
  await command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath, "-out", certPath, "-config", certConfig]);
  server = createSecureServer({ key: await readFile(keyPath), cert: await readFile(certPath), allowHTTP1: true }, (request, response) => {
    const entry = { method: request.method, host: request.headers[":authority"] || request.headers.host,
      url: request.url, language: request.headers["accept-language"] || null, at: Date.now() };
    report.requests.push(entry);
    response.setHeader("Cache-Control", "no-store"); response.setHeader("Access-Control-Allow-Origin", "*");
    if (request.url === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    if (request.url.startsWith("/api/")) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(entry)); return; }
    if (request.url.startsWith("/tracker.js")) { response.setHeader("Content-Type", "text/javascript"); response.end("globalThis.localTrackerRan=true;"); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><title>Local protection fixture</title><script>globalThis.fixtureRequest=${JSON.stringify(entry)};globalThis.fixtureRead=${pageRead.toString()};globalThis.fixtureInitial=fixtureRead();</script></head><body>Authored loopback protection fixture</body></html>`);
  });
  server.on("session", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port, base = `https://${hosts[0]}:${port}`, ordinary = `https://${hosts[1]}:${port}`, tracker = `https://${trackerHost}:${port}`;
  report.endpoints = { base, ordinary, tracker };
  chrome = spawn(binary, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication", "--ignore-certificate-errors", "--lang=zh-CN",
    "--host-resolver-rules=" + hosts.map(host => `MAP ${host} 127.0.0.1`).join(", "),
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=" + hosts.join(";"), "about:blank"],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let id = 0, buffer = ""; const pending = new Map();
  chrome.stderr.on("data", value => { stderr = (stderr + value).slice(-5000); });
  chrome.stdio[4].on("data", value => {
    buffer += value.toString(); let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const entry = pending.get(message.id); if (!entry) continue;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  });
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(method + " timed out: " + stderr)); }, 12000);
    pending.set(next, { resolve, reject, timer }); chrome.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const evaluate = async (expression, sessionId) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const open = async (url, background = false) => {
    const target = await cdp("Target.createTarget", { url, background });
    return { ...target, sessionId: (await cdp("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId };
  };
  const waitFor = async (predicate, label) => {
    const until = Date.now() + 9000;
    while (Date.now() < until) {
      try { if (await predicate()) return; }
      catch (error) { if (!/context.*destroyed|Cannot find context|No execution context|Frame.*removed|No frame/i.test(error.message)) throw error; }
      await delay(40);
    }
    throw new Error("Timed out: " + label);
  };
  const click = async (selector, sessionId) => {
    await waitFor(() => evaluate(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`, sessionId), "clickable " + selector);
    const rect = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('control unavailable: '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`, sessionId);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...rect }, sessionId);
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...rect }, sessionId);
  };
  report.browser = await cdp("Browser.getVersion");
  const { id: extensionId } = await cdp("Extensions.loadUnpacked", { path: extension });
  const controller = await open(`chrome-extension://${extensionId}/popup.html`);
  await waitFor(() => evaluate("!!globalThis.chrome?.runtime", controller.sessionId), "extension APIs");
  const send = async message => {
    const response = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`, controller.sessionId);
    assert.ok(response.ok, JSON.stringify(response)); return response.data;
  };
  await send({ type: "status" });
  report.regexSupport = await evaluate(`chrome.declarativeNetRequest.isRegexSupported({regex:${JSON.stringify(tracking.CLEAN_LINK_REGEX)},isCaseSensitive:true})`, controller.sessionId);
  assert.equal(report.regexSupport.isSupported, true, "Chrome accepts the actual link-cleaning regex: " + JSON.stringify(report.regexSupport));
  const tab = await evaluate(`chrome.tabs.create({url:${JSON.stringify(base + "/native")},active:false})`, controller.sessionId);
  // Use the tab created through the extension for its stable tabId; attach CDP by URL.
  let pageTarget;
  await waitFor(async () => { pageTarget = (await cdp("Target.getTargets")).targetInfos.find(target => target.url === base + "/native"); return !!pageTarget; }, "fixture target created");
  const pageSession = (await cdp("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true })).sessionId;
  const read = () => evaluate("({request:globalThis.fixtureRequest,readings:globalThis.fixtureRead?.()})", pageSession);
  const navigate = async (route, origin = base) => {
    const url = origin + route;
    await evaluate(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(url)}})`, controller.sessionId);
    await waitFor(async () => (await read()).request?.url === route, "navigation " + route);
    return read();
  };
  await waitFor(async () => !!(await read()).readings, "native authored fixture");
  const native = await read(); report.native = native.readings;
  const state = async () => { const value = await send({ type: "protectionStatus", tabId: tab.id }); report.lastProtectionState = value; return value; };
  const rules = () => evaluate("chrome.declarativeNetRequest.getDynamicRules()", controller.sessionId);
  let initial = await state(); assert.equal(initial.config.trackers, false); assert.equal(initial.config.links, false); assert.equal(initial.active, false);
  assertStage("new features default off", { initial });
  const fetched = async (url, kind = "fetch") => evaluate(`(async()=>{try{
    ${kind === "script" ? `await new Promise((resolve,reject)=>{const e=document.createElement('script');e.src=${JSON.stringify(url)};e.onload=resolve;e.onerror=()=>reject(new Error('blocked'));document.head.append(e)});return{ok:true};` : `const r=await fetch(${JSON.stringify(url)},{cache:'no-store'});return{ok:r.ok,data:await r.json()};`}
  }catch(error){return{ok:false,error:String(error)}}})()`, pageSession);
  const trackerCount = value => report.requests.filter(request => request.host === `${trackerHost}:${port}` && request.url === value).length;
  const baselinePath = "/api/baseline?case=before";
  const baseline = await fetched(tracker + baselinePath);
  if (browserName === "brave" && !baseline.ok) {
    report.braveShieldsInterference = { nativeTrackerRequestBlocked: true, attribution: "This is Brave's baseline, before extension request protection. Actual tracker blocking attribution is skipped." };
  } else { assert.equal(baseline.ok, true); assert.equal(trackerCount(baselinePath), 1); }
  await send({ type: "regionApply", tabId: tab.id, profileId: "us-en" });
  await waitFor(async () => (await read()).readings?.language === "en-US", "US region reload");
  const manager = await open(`chrome-extension://${extensionId}/popup.html?view=manage&tab=${tab.id}`);
  await waitFor(() => evaluate("!!document.querySelector('#protect-trackers')&&!document.querySelector('#protect-trackers').disabled", manager.sessionId), "protection UI ready");
  await click("#protect-trackers", manager.sessionId);
  await waitFor(async () => (await state()).trackersActive === true, "tracking enabled through real UI");
  await click("#protect-links", manager.sessionId);
  await waitFor(async () => (await state()).linksActive === true, "link cleaning enabled through real UI");
  assertStage("both features enabled through actual UI clicks", { status: await state(), rules: await rules() });
  assert.ok((await rules()).some(rule => rule.id === 7001), "locale rule coexists");
  for (const kind of ["fetch", "script"]) {
    const route = kind === "fetch" ? "/api/blocked?case=active" : "/tracker.js?case=active";
    const result = await fetched(tracker + route, kind); assert.equal(result.ok, false, "tracker request blocked"); assert.equal(trackerCount(route), 0, "tracker server receives no blocked request");
  }
  assert.equal((await fetched(ordinary + "/api/ordinary?case=active")).ok, true);
  const direct = await navigate("/direct-tracker", tracker); assert.ok(direct.request);
  await navigate("/after-direct");
  assertStage("third-party tracker fetch/script blocked; ordinary and direct navigation preserved");
  const cleanedRoute = "/clean?q=hello&utm_source=test&fbclid=local-click";
  await evaluate(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(base + cleanedRoute)}})`, controller.sessionId);
  await waitFor(async () => (await read()).request?.url === "/clean?q=hello", "tracking parameters removed");
  const cleaned = await read(); assert.equal(cleaned.request.language, "en-US,en;q=0.9");
  assert.equal(cleaned.readings.userAgent, native.readings.userAgent); assert.equal(cleaned.readings.canvas, native.readings.canvas);
  for (const route of ["/safe?q=hello&utm_source=test&unknown_business_key=retain", "/oauth?utm_source=test&state=keep&code=keep", "/signed?utm_source=test&signature=keep", "/token?fbclid=test&token=keep"]) {
    const value = await navigate(route); assert.equal(value.request.url, route);
  }
  const plain = "/plain?q=hello&page=2"; const beforePlain = report.requests.filter(request => request.url === plain).length;
  await navigate(plain); assert.equal(report.requests.filter(request => request.url === plain).length - beforePlain, 1, "non-tracking URL is not redirected repeatedly");
  await evaluate(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(base + "/fragment?q=hello&utm_campaign=local#section")}})`, controller.sessionId);
  await waitFor(async () => (await read()).request?.url === "/fragment?q=hello", "fragment navigation cleaned");
  assert.equal(await evaluate("location.hash", pageSession), "#section", "fragment preserved during query transform");
  await evaluate(`(()=>{const f=document.createElement('form');f.method='POST';f.action=${JSON.stringify(base + "/post?utm_source=keep&fbclid=keep")};document.body.append(f);f.submit()})()`, pageSession);
  await waitFor(async () => (await read()).request?.method === "POST", "POST navigation");
  assert.equal((await read()).request.url, "/post?utm_source=keep&fbclid=keep");
  assertStage("GET navigation sanitization preserves safe query, unknown/auth/signed queries and POST; UA/Canvas unchanged");
  await navigate("/exception-setup");
  await evaluate("window.dispatchEvent(new Event('focus'))", manager.sessionId);
  await waitFor(() => evaluate("!document.querySelector('#protection-exclude').disabled", manager.sessionId), "exception control ready");
  await click("#protection-exclude", manager.sessionId);
  await waitFor(async () => (await state()).config.excludedDomains.includes(hosts[0]), "domain exception enabled");
  const exceptedPath = "/api/excepted?case=allowed";
  if (!report.braveShieldsInterference) assert.equal((await fetched(tracker + exceptedPath)).ok, true);
  await navigate("/excluded?q=hello&utm_source=keep");
  await click("#protection-exclude", manager.sessionId);
  await waitFor(async () => !(await state()).config.excludedDomains.includes(hosts[0]), "domain exception removed");
  await evaluate(`chrome.tabs.update(${tab.id},{url:${JSON.stringify(base + "/restored?q=hello&utm_source=remove")}})`, controller.sessionId);
  await waitFor(async () => (await read()).request?.url === "/restored?q=hello", "cleaning restored after exception removal");
  assertStage("domain exception releases both features; removal restores protection");
  await send({ type: "protectionConfigure", feature: "trackers", value: false, tabId: tab.id });
  await send({ type: "protectionConfigure", feature: "links", value: false, tabId: tab.id });
  assert.ok((await rules()).some(rule => rule.id === 7001)); assert.equal((await rules()).filter(rule => rule.id >= 8000 && rule.id <= 8999).length, 0);
  assert.equal((await fetched(base + "/api/after-protection-off")).data.language, "en-US,en;q=0.9");
  await send({ type: "protectionConfigure", feature: "trackers", value: true, tabId: tab.id });
  await send({ type: "protectionConfigure", feature: "links", value: true, tabId: tab.id });
  await send({ type: "enabled", value: false });
  const paused = await state(); assert.equal(paused.config.trackers, true); assert.equal(paused.config.links, true); assert.equal(paused.active, false);
  assert.equal((await rules()).filter(rule => rule.id >= 8000 && rule.id <= 8999).length, 0); assert.equal((await rules()).some(rule => rule.id === 7001), false);
  await send({ type: "enabled", value: true });
  const resumed = await state(); assert.equal(resumed.trackersActive, true); assert.equal(resumed.linksActive, true); assert.ok((await rules()).some(rule => rule.id === 7001));
  assertStage("feature switches preserve locale; global pause and resume preserve selections and independently manage rules", { paused, resumed });
  await evaluate("window.dispatchEvent(new Event('focus'))", manager.sessionId);
  await waitFor(() => evaluate("document.querySelector('#protection-status').textContent==='规则已启用'", manager.sessionId), "management active status");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1100, deviceScaleFactor: 1, mobile: false }, manager.sessionId);
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth", manager.sessionId), true, "management no horizontal overflow");
  await evaluate("scrollTo(0,0)", manager.sessionId);
  const managementPNG = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, manager.sessionId);
  const picturePrefix = browserName === "brave" ? "brave-protection" : "protection";
  await writeFile(path.join(root, `verification/${picturePrefix}-management.png`), Buffer.from(managementPNG.data, "base64"));
  await evaluate(`chrome.tabs.update(${tab.id},{active:true})`, controller.sessionId);
  const popup = await open(`chrome-extension://${extensionId}/popup.html`, true);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 430, height: 600, deviceScaleFactor: 1, mobile: false }, popup.sessionId);
  await waitFor(() => evaluate("!!document.querySelector('#protection-status')&&document.querySelector('#protection-status').textContent!=='检查中'", popup.sessionId), "popup rendered");
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth&&document.body.getBoundingClientRect().height<=600", popup.sessionId), true, "popup fits width and height");
  const popupPNG = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, popup.sessionId);
  await writeFile(path.join(root, `verification/${picturePrefix}-popup.png`), Buffer.from(popupPNG.data, "base64"));
  report.screenshots = [`${picturePrefix}-management.png`, `${picturePrefix}-popup.png`];
  assertStage("management and 430px popup render without overflow");
  const settings = await open("chrome://extensions/");
  await waitFor(() => evaluate("!!chrome.developerPrivate", settings.sessionId), "Chrome site-access APIs");
  const access = hostAccess => evaluate(`chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},hostAccess:${JSON.stringify(hostAccess)}})`, settings.sessionId);
  await access("ON_CLICK");
  await waitFor(async () => (await rules()).filter(rule => rule.id >= 8000 && rule.id <= 8999).length === 0, "permission revocation clears request rules");
  const revoked = await state(); assert.equal(revoked.active, false);
  await access("ON_ALL_SITES"); await delay(200);
  const regranted = await state(); assert.equal(regranted.active, false); assert.equal((await rules()).filter(rule => rule.id >= 8000 && rule.id <= 8999).length, 0);
  assertStage("website permission revoke clears rules and regrant does not silently restart", { revoked, regranted });
  report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(report.error); }
finally {
  try { if (cdp) await cdp("Browser.close"); } catch {}
  if (chrome?.exitCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
  if (chrome?.exitCode === null) chrome.kill("SIGKILL");
  for (const socket of sockets) socket.destroy();
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  await rm(scratch, { recursive: true, force: true });
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
}
