// Runs only this extension in a new disposable Chrome profile; never opens a remote site.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { READING_EXPRESSION } from "../extension/region-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const debugTrace = process.argv.includes("--trace");
const profile = await mkdtemp(path.join(tmpdir(), "privacy-guard-smoke-"));
// Pregrant only this disposable copy. Headless cannot accept the initial tabs
// warning, so the real revocation test uses Chrome's Site Access controls. The
// shipping extension keeps tabs and website access optional.
const testExtension = await mkdtemp(path.join(tmpdir(), "privacy-guard-test-extension-"));
await cp(path.join(root, "extension"), testExtension, { recursive: true });
if (debugTrace) {
  const background = path.join(testExtension, "background.js");
  await writeFile(background, await readFile(background, "utf8") + `\n
globalThis.__smokeTrace = [];
globalThis.__smokeWrapped = new WeakSet();
globalThis.__smokeSetupTrace = () => {
for (const [owner, label, names] of [
  [chrome.storage.local,'local',['get','set']], [chrome.storage.session,'session',['get','set']],
  [chrome.permissions,'permissions',['contains']], [chrome.scripting,'scripting',['getRegisteredContentScripts','registerContentScripts','unregisterContentScripts','executeScript']],
  [chrome.tabs,'tabs',['get','query','reload','sendMessage']], [chrome.declarativeNetRequest,'dnr',['getDynamicRules','updateDynamicRules']]
]) for (const name of names) {
  const original = owner?.[name]; if (typeof original !== 'function' || __smokeWrapped.has(original)) continue;
  owner[name] = function (...args) {
    const record = { at:Date.now(),op:label+'.'+name,phase:'start',details:name==='executeScript'?{target:args[0]?.target,func:args[0]?.func?.name}:name==='registerContentScripts'?args[0]?.map(s=>s.id):undefined };
    const add = value => { __smokeTrace.push(value); if (__smokeTrace.length>500) __smokeTrace.shift(); };
    add(record);
    try { const result=Reflect.apply(original,this,args); if(result?.then) result.then(()=>add({...record,at:Date.now(),phase:'done'}),error=>add({...record,at:Date.now(),phase:'error',error:error.message}));return result; }
    catch(error){add({...record,at:Date.now(),phase:'throw',error:error.message});throw error;}
  };
  __smokeWrapped.add(owner[name]);
}
};
__smokeSetupTrace();
chrome.runtime.onMessage.addListener(()=>{__smokeSetupTrace();return false;});
`);
}
const manifest = JSON.parse(await readFile(path.join(testExtension, "manifest.json")));
assert.ok(!manifest.permissions.includes("userScripts") && !manifest.optional_permissions.includes("userScripts"), "v0.4 must not request userScripts");
const pregranted = manifest.optional_permissions;
manifest.permissions.push(...pregranted);
manifest.host_permissions = manifest.optional_host_permissions;
manifest.optional_permissions = [];
delete manifest.optional_host_permissions;
await writeFile(path.join(testExtension, "manifest.json"), JSON.stringify(manifest));
const localServer = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/echo") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(req.headers)); return; }
  if (req.url === "/worker.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end("postMessage({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,locale:Intl.DateTimeFormat().resolvedOptions().locale,language:navigator.language,languages:Array.from(navigator.languages)});"); return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end("<!doctype html><title>Local region test</title><h1>Local test only</h1>" + (req.url === "/frame" ? "" : "<iframe src='/frame'></iframe><iframe src='about:blank'></iframe>"));
});
await new Promise(resolve => localServer.listen(0, "127.0.0.1", resolve));
const localUrl = `http://127.0.0.1:${localServer.address().port}/`;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
  "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
  "--disable-sync", "--disable-default-apps", "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication",
  "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1", "about:blank"
], { stdio: ["ignore", "ignore", "pipe"] });
let log = "";
chrome.stderr.on("data", data => { log = (log + data.toString()).slice(-5000); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket, report = [], dumpTrace;
try {
  let portData;
  for (let i = 0; i < 100; i++) {
    try { portData = await readFile(path.join(profile, "DevToolsActivePort"), "utf8"); break; } catch { await delay(100); }
    if (chrome.exitCode !== null) throw new Error("Chrome exited before DevTools opened: " + log);
  }
  if (!portData) throw new Error("Chrome DevTools timed out: " + log);
  const [port, endpoint] = portData.trim().split("\n");
  socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id); pending.delete(message.id); clearTimeout(timer);
    if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); reject(new Error(method + " timed out")); }, 10000);
    pending.set(next, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const version = await cdp("Browser.getVersion");
  report.push("Browser: " + version.product);
  const loaded = await cdp("Extensions.loadUnpacked", { path: testExtension });
  const extensionId = loaded.id;
  dumpTrace = async () => {
    const targets = (await cdp("Target.getTargets")).targetInfos;
    const worker = targets.find(target => target.type === "service_worker" && target.url.includes(extensionId));
    if (!worker) return { error: "service worker missing", targets: targets.map(target => ({ type: target.type, url: target.url })) };
    const attached = await cdp("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
    const result = await cdp("Runtime.evaluate", { expression: "Promise.all([chrome.storage.local.get(['regionRuntime','regions']),chrome.scripting.getRegisteredContentScripts()]).then(([state,scripts])=>({trace:globalThis.__smokeTrace,state,scripts,dnrKeys:Object.keys(chrome.declarativeNetRequest||{})}))", awaitPromise: true, returnByValue: true }, attached.sessionId);
    return result.result.value;
  };
  assert.ok(extensionId, "unpacked extension loaded"); report.push("PASS: unpacked Manifest V3 extension loaded");
  const settingsTarget = await cdp("Target.createTarget", { url: "chrome://extensions/" });
  const settingsSession = (await cdp("Target.attachToTarget", { targetId: settingsTarget.targetId, flatten: true })).sessionId;
  for (let i=0;i<50;i++) {
    const ready=await cdp("Runtime.evaluate",{expression:"!!chrome.developerPrivate",returnByValue:true},settingsSession);
    if(ready.result.value)break;
    await delay(30);
  }
  const changeHostAccess = async value => {
    const result=await cdp("Runtime.evaluate",{expression:`chrome.developerPrivate.updateExtensionConfiguration({extensionId:${JSON.stringify(extensionId)},hostAccess:${JSON.stringify(value)}})`,awaitPromise:true,returnByValue:true},settingsSession);
    if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
  };
  report.push("Test setup: only the temporary copy pregrants tabs and website access; real Site Access controls exercise revoke/restore. The initial permission-warning dialog is not tested.");
  await delay(800);
  const { targetId } = await cdp("Target.createTarget", { url: `chrome-extension://${extensionId}/popup.html` });
  let { sessionId } = await cdp("Target.attachToTarget", { targetId, flatten: true });
  await cdp("Runtime.enable", {}, sessionId);
  await delay(700);
  const evaluate = async expression => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)
      .catch(error => { throw new Error(expression.slice(0, 200) + ": " + error.message); });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const send = message => {
    if (debugTrace) console.log("SEND", message.type, message.profileId || "");
    return evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  };
  const grantRegionAPI = async () => {
    await changeHostAccess("ON_ALL_SITES");
    assert.equal(await evaluate("chrome.permissions.contains({permissions:['tabs'],origins:['http://*/*','https://*/*']})"), true);
  };
  const waitFor = async (check, label) => {
    const end=Date.now()+6000;
    while(Date.now()<end) {
      try { if(await check()) return; }
      catch(error) { if(!/Frame.*removed|No frame|Cannot access contents/i.test(error.message)) throw error; }
      await delay(100);
    }
    throw new Error("Timed out: "+label);
  };
  let state = await send({ type: "status", origin: "https://example.com" });
  assert.ok(state.ok, JSON.stringify(state));
  assert.equal(state.data.config.enabled, true);
  assert.ok(state.data.settings.every(row => ["active", "unsupported"].includes(row.status)), JSON.stringify(state.data.settings));
  report.push("PASS: defaults applied and verified against real Chrome privacy API");
  report.push(...state.data.settings.map(row => `  ${row.id}: ${row.status} (${JSON.stringify(row.effective)})`));
  assert.ok((await evaluate("document.querySelector('#native-count').textContent")).includes("7"));
  report.push("PASS: popup renders actual status");
  state = await send({ type: "site", origin: "https://example.com", block: true });
  assert.ok(state.ok);
  let site = await evaluate("chrome.contentSettings.javascript.get({primaryUrl:'https://example.com/'})");
  assert.equal(site.setting, "block");
  site = await evaluate("chrome.contentSettings.javascript.get({primaryUrl:'https://example.com:8443/'})");
  assert.equal(site.setting, "allow");
  report.push("PASS: JavaScript block is isolated to the selected origin and port");
  state = await send({ type: "enabled", value: false });
  assert.ok(state.ok);
  assert.ok(state.data.settings.every(row => ["released", "unsupported"].includes(row.status)));
  site = await evaluate("chrome.contentSettings.javascript.get({primaryUrl:'https://example.com/'})");
  assert.equal(site.setting, "allow");
  report.push("PASS: pause releases privacy overrides and site block");
  state = await send({ type: "enabled", value: true });
  assert.ok(state.ok);
  site = await evaluate("chrome.contentSettings.javascript.get({primaryUrl:'https://example.com/'})");
  assert.equal(site.setting, "block");
  report.push("PASS: resume restores saved settings and site rule");
  state = await send({ type: "site", origin: "https://example.com", block: false }); assert.ok(state.ok);
  await grantRegionAPI();
  const newPopup = await cdp("Target.createTarget", {url:`chrome-extension://${extensionId}/popup.html`});
  sessionId = (await cdp("Target.attachToTarget", {targetId:newPopup.targetId,flatten:true})).sessionId;
  await delay(500);
  console.log('Test popup context', await evaluate("({url:location.href, runtime:!!chrome.runtime,tabs:!!chrome.tabs,scripting:!!chrome.scripting})"));
  const testTab = await evaluate(`chrome.tabs.create({url:${JSON.stringify(localUrl)},active:false})`);
  await delay(400);
  const readLive = async () => evaluate(`chrome.scripting.executeScript({target:{tabId:${testTab.id}},world:'MAIN',func:()=>(${READING_EXPRESSION})})`);
  const initial = (await readLive())[0].result;
  const functionState = () => evaluate(`chrome.scripting.executeScript({target:{tabId:${testTab.id}},world:'MAIN',func:()=>({
    dateParse:Function.prototype.toString.call(Date.parse), dateOffset:Function.prototype.toString.call(Date.prototype.getTimezoneOffset),
    dateString:Function.prototype.toString.call(Date.prototype.toString), numberFormat:Function.prototype.toString.call(Intl.NumberFormat),
    navigatorLanguage:Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype,'language').get),
    navigatorLanguages:Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype,'languages').get)
  })})`).then(r=>r[0].result);
  const originalFunctions = await functionState();
  let fresh = await send({type:"regionStatus",tabId:testTab.id});
  assert.equal(fresh.data.lifecycle.requested,false);
  assert.equal(fresh.data.lifecycle.active,false);
  report.push("PASS: new install retains regions but defaults OFF");
  for (const [profileId, timezone, language] of [["jp","Asia/Tokyo","ja-JP"],["sg-en","Asia/Singapore","en-SG"],["us-en","America/Los_Angeles","en-US"]]) {
    let region = await send({ type: "regionApply", tabId: testTab.id, profileId });
    assert.ok(region.ok, JSON.stringify(region));
    await waitFor(async()=> (await readLive())[0]?.result?.language===language,profileId+" region bootstrap");
    region = await send({ type: "regionStatus", tabId: testTab.id });
    assert.equal(region.data.current.live.timezone, timezone, JSON.stringify(region));
    assert.equal(region.data.current.live.language, language, JSON.stringify(region));
    assert.equal(region.data.current.live.locale, language);
    assert.equal(region.data.current.live.userAgent, initial.userAgent);
    assert.equal(region.data.current.live.hasClientHints, true);
    assert.deepEqual(region.data.current.live.languages, [language, language.split("-")[0]]);
    await waitFor(async()=> {
      const frames=await evaluate(`chrome.scripting.executeScript({target:{tabId:${testTab.id},allFrames:true},world:'MAIN',func:()=>({url:location.href,language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})})`);
      return frames.some(frame=>frame.result.url===localUrl+"frame" && frame.result.language===language && frame.result.timezone===timezone);
    }, profileId+" HTTP iframe bootstrap");
    const headers = await evaluate(`chrome.scripting.executeScript({target:{tabId:${testTab.id}},world:'MAIN',func:()=>fetch('/echo').then(r=>r.json())})`);
    assert.ok(headers[0].result["accept-language"].startsWith(language));
    report.push(`PASS: ${profileId} page + HTTP iframe timezone/locale/language + request Accept-Language; UA/CH retained`);
    const contexts = await evaluate(`chrome.scripting.executeScript({target:{tabId:${testTab.id}},world:'MAIN',func:async()=>{
      const frame=document.createElement('iframe'); document.body.appendChild(frame);
      const child=frame.contentWindow;
      const iframe={language:child.navigator.language,timezone:child.Intl.DateTimeFormat().resolvedOptions().timeZone,array:child.navigator.languages instanceof child.Array};
      frame.remove();
      const url=URL.createObjectURL(new Blob(["postMessage({language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})"],{type:'text/javascript'}));
      const worker=new Worker(url); URL.revokeObjectURL(url);
      const result=await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=()=>reject(new Error('Blob Worker failed'));setTimeout(()=>reject(new Error('Blob Worker timed out')),3000)});
      worker.terminate(); return {iframe,worker:result};
    }})`);
    assert.equal(contexts[0].result.iframe.language,language);
    assert.equal(contexts[0].result.iframe.timezone,timezone);
    assert.equal(contexts[0].result.iframe.array,true);
    assert.equal(contexts[0].result.worker.language,language);
    assert.equal(contexts[0].result.worker.timezone,timezone);
    report.push(`PASS: ${profileId} synchronous about:blank iframe + captured classic Blob Worker agree; child language array belongs to child realm`);
  }
  const workers = await evaluate(`chrome.scripting.executeScript({target:{tabId:${testTab.id}},world:'MAIN',func:()=>new Promise((resolve,reject)=>{const w=new Worker('/worker.js');w.onmessage=e=>{w.terminate();resolve(e.data)};w.onerror=reject;setTimeout(()=>reject(new Error('worker timeout')),3000)})})`);
  report.push('Known limit - HTTP Worker keeps native readings: '+JSON.stringify(workers[0].result));
  let stopped = await send({ type: "regionStop", tabId: testTab.id });
  assert.ok(stopped.ok, JSON.stringify(stopped)); assert.equal(stopped.data.lifecycle.requested, false);
  assert.ok(stopped.data.lifecycle.needsRefresh > 0);
  assert.equal((await readLive())[0].result.language,"en-US");
  const stoppedHeaders=await evaluate(`chrome.scripting.executeScript({target:{tabId:${testTab.id}},world:'MAIN',func:()=>fetch('/echo').then(r=>r.json())})`);
  assert.ok(stoppedHeaders[0].result['accept-language'].startsWith(initial.language));
  report.push("PASS: stop removes future header/script rules and exposes old-page refresh debt");
  await send({type:"regionRefreshCurrent",tabId:testTab.id});
  await delay(400);
  const restored = (await readLive())[0].result;
  assert.equal(restored.timezone, initial.timezone);
  assert.equal(restored.language, initial.language);
  report.push("PASS: stopping region mode restores page timezone/language after reload");
  const saveProfile=async profile=>{
    const saved=await send({type:'regionSave',profile}); assert.ok(saved.ok,JSON.stringify(saved));
    return saved.data.profiles.find(p=>p.name===profile.name).id;
  };
  const timezoneOnly=await saveProfile({name:'Smoke timezone only',languageMode:'native',timezone:'Asia/Tokyo'});
  await send({type:'regionApply',profileId:timezoneOnly,tabId:testTab.id});
  await waitFor(async()=> (await readLive())[0]?.result?.timezone==='Asia/Tokyo','timezone-only bootstrap');
  assert.equal((await readLive())[0].result.language,initial.language);
  const timezoneFunctions=await functionState();
  assert.equal(timezoneFunctions.navigatorLanguage,originalFunctions.navigatorLanguage);
  assert.equal(timezoneFunctions.navigatorLanguages,originalFunctions.navigatorLanguages);
  assert.equal(timezoneFunctions.numberFormat,originalFunctions.numberFormat);
  assert.equal(await evaluate("chrome.declarativeNetRequest.getDynamicRules().then(r=>r.some(x=>x.id===7001))"),false);
  const languageOnly=await saveProfile({name:'Smoke language only',timezoneMode:'native',locale:'ja-JP',languages:['ja-JP','ja']});
  await send({type:'regionApply',profileId:languageOnly,tabId:testTab.id});
  await waitFor(async()=> (await readLive())[0]?.result?.language==='ja-JP','language-only bootstrap');
  assert.equal((await readLive())[0].result.timezone,initial.timezone);
  const languageFunctions=await functionState();
  assert.equal(languageFunctions.dateParse,originalFunctions.dateParse);
  assert.equal(languageFunctions.dateOffset,originalFunctions.dateOffset);
  assert.equal(languageFunctions.dateString,originalFunctions.dateString);
  const matching=await saveProfile({name:'Smoke same native',timezone:initial.timezone,locale:initial.locale,languages:initial.languages});
  await send({type:'regionApply',profileId:matching,tabId:testTab.id});
  await waitFor(async()=> (await readLive())[0]?.result?.language===initial.language,'matching-native bootstrap');
  await delay(200);
  assert.deepEqual(await functionState(),originalFunctions);
  const nativeResult=await send({type:'regionApply',profileId:'native',tabId:testTab.id});
  assert.ok(nativeResult.ok);
  assert.equal(nativeResult.data.lifecycle.active,false);
  assert.equal(nativeResult.data.lifecycle.requested,false);
  assert.equal(await evaluate("chrome.scripting.getRegisteredContentScripts().then(r=>r.length)"),0);
  assert.equal(await evaluate("chrome.declarativeNetRequest.getDynamicRules().then(r=>r.length)"),0);
  await delay(300);
  assert.deepEqual(await functionState(),originalFunctions);
  report.push('PASS: native/matching presets keep original APIs; timezone-only preserves language APIs and headers; language-only preserves Date core APIs');
  // A real optional permission removal must revoke intent before attempting cleanup.
  await send({type:"regionApply",profileId:"jp",tabId:testTab.id}); await delay(400);
  await changeHostAccess("ON_CLICK");
  assert.equal(await evaluate("chrome.permissions.contains({origins:['http://*/*','https://*/*']})"),false);
  const revoked=await send({type:"regionStatus",tabId:testTab.id});
  assert.equal(revoked.data.lifecycle.requested,false,JSON.stringify(revoked));
  assert.equal(revoked.data.lifecycle.active,false);
  const badgeRevoked=await evaluate("chrome.action.getBadgeText({})");
  assert.equal(badgeRevoked,"↻");
  assert.deepEqual(revoked.data.lifecycle.cleanupPending,{scripts:false,headers:false});
  assert.equal(await evaluate("chrome.scripting.getRegisteredContentScripts().then(r=>r.length)"),0);
  await grantRegionAPI(); await delay(300);
  const regranted=await send({type:"regionStatus",tabId:testTab.id});
  assert.equal(regranted.data.lifecycle.active,false);
  await evaluate(`chrome.tabs.reload(${testTab.id})`);await delay(500);
  assert.equal((await readLive())[0].result.language,initial.language);
  report.push("PASS: real Chrome Site Access revoke/restore cleans both scripts and headers without silently reactivating regions");
  await send({type:"regionApply",profileId:"sg-en",tabId:testTab.id});await delay(350);
  await send({type:"enabled",value:false});
  const paused=await send({type:"regionStatus",tabId:testTab.id});
  assert.equal(paused.data.lifecycle.active,false);
  assert.equal(paused.data.lifecycle.requested,true);
  assert.ok(paused.data.lifecycle.needsRefresh>0);
  assert.equal(await evaluate("chrome.action.getBadgeText({})"),"OFF");
  assert.match(await evaluate("chrome.action.getTitle({})"),/已暂停.*需刷新/);
  const afterPause=await evaluate(`chrome.scripting.executeScript({target:{tabId:${testTab.id}},world:'MAIN',func:async()=>{
    const frame=document.createElement('iframe');document.body.appendChild(frame);
    const iframe={language:frame.contentWindow.navigator.language,timezone:frame.contentWindow.Intl.DateTimeFormat().resolvedOptions().timeZone};frame.remove();
    const url=URL.createObjectURL(new Blob(["postMessage({language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})"],{type:'text/javascript'}));
    const worker=new Worker(url);URL.revokeObjectURL(url);
    const result=await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=()=>reject(new Error('paused Worker failed'));setTimeout(()=>reject(new Error('paused Worker timeout')),3000)});
    worker.terminate();return {iframe,worker:result};
  }})`);
  assert.equal(afterPause[0].result.iframe.language,initial.language);
  assert.equal(afterPause[0].result.iframe.timezone,initial.timezone);
  assert.equal(afterPause[0].result.worker.language,initial.language);
  assert.equal(afterPause[0].result.worker.timezone,initial.timezone);
  report.push('PASS: pause stops new iframe and Blob Worker propagation on already modified pages');
  await send({type:"defaults"});
  const afterDefaults=await send({type:"regionStatus",tabId:testTab.id});
  assert.equal(afterDefaults.data.enabled,false);
  assert.equal(afterDefaults.data.lifecycle.active,false);
  assert.equal(afterDefaults.data.lifecycle.status,"paused");
  report.push("PASS: restoring base recommendations preserves pause and does not resume region mode");
  await send({type:"regionRefreshCurrent",tabId:testTab.id});await delay(350);
  assert.equal((await readLive())[0].result.language,initial.language);
  const resumed=await send({type:"enabled",value:true});
  await evaluate(`chrome.tabs.reload(${testTab.id})`);
  await waitFor(async()=> (await readLive())[0]?.result?.language==="en-SG","resume region bootstrap");
  assert.equal((await readLive())[0].result.language,"en-SG",JSON.stringify({resumed,region:await send({type:"regionStatus",tabId:testTab.id})}));
  report.push("PASS: ordinary pause/resume preserves explicitly selected intent while pausing future overrides");
  await send({type:"regionStop",tabId:testTab.id});
  await send({type:"regionRefreshAll",tabId:testTab.id});await delay(350);
  const settled=await send({type:"regionStatus",tabId:testTab.id});
  assert.equal(settled.data.lifecycle.needsRefresh,0);
  report.push("PASS: explicit affected-page refresh clears refresh debt");
  await cdp("Page.reload", {}, sessionId); await delay(600);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 430, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId);
  const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
  await mkdir(path.join(root, "verification"), { recursive: true });
  await writeFile(path.join(root, "verification", "popup.png"), Buffer.from(shot.data, "base64"));
  await cdp("Page.navigate", {url:`chrome-extension://${extensionId}/popup.html?view=manage&tab=${testTab.id}`},sessionId);await delay(600);
  await cdp("Emulation.setDeviceMetricsOverride",{width:1060,height:900,deviceScaleFactor:1,mobile:false},sessionId);
  assert.equal(await evaluate("document.querySelector('.region-readings').open"),false);
  assert.equal(await evaluate("Array.from(document.querySelectorAll('#region-panel button')).some(button=>button.textContent==='刷新当前页'&&!button.hidden)"),false);
  const manageShot=await cdp("Page.captureScreenshot",{format:"png",captureBeyondViewport:true},sessionId);
  await writeFile(path.join(root,"verification","management.png"),Buffer.from(manageShot.data,"base64"));
  await evaluate("document.querySelector('.region-editor').open=true;const input=document.querySelector('#region-name');input.value='未保存的自定义组合';input.dispatchEvent(new Event('input',{bubbles:true}));window.dispatchEvent(new Event('privacy-settings-changed'))");
  await delay(500);
  assert.equal(await evaluate("document.querySelector('#region-name').value"),"未保存的自定义组合");
  report.push("PASS: status refresh preserves unsaved localization editor input");
  await evaluate("document.querySelector('#enabled').click()");
  await waitFor(()=>evaluate("document.querySelector('#release').disabled && document.querySelector('#release').textContent==='已暂停'"),"paused management action");
  await evaluate("document.querySelector('#enabled').click()");
  await waitFor(()=>evaluate("!document.querySelector('#release').disabled && document.querySelector('#release').textContent==='暂停全部功能'"),"resumed management action");
  report.push("PASS: collapsed region readings and unambiguous pause/resume actions");
  report.push("Cleanup API failures remain covered by unit tests; this real-browser run does not fabricate revocation of required APIs or a cleanup-warning screenshot.");
  report.push("Network DNS/WebRTC/Shadowrocket leak verification: not performed; no external pages opened.");
  await writeFile(path.join(root, "verification", "chrome-smoke.txt"), report.join("\n") + "\n");
  console.log(report.join("\n"));
  await cdp("Target.closeTarget", { targetId: settingsTarget.targetId });
  await cdp("Browser.close");
} catch (error) {
  if (debugTrace && dumpTrace) {
    try { console.log("BACKGROUND TRACE", JSON.stringify(await dumpTrace(), null, 2)); } catch (traceError) { console.log("TRACE ERROR", traceError.message); }
  }
  throw error;
} finally {
  socket?.close();
  if (chrome.exitCode === null) chrome.kill("SIGTERM");
  await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), delay(1500)]);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(testExtension, { recursive: true, force: true }).catch(() => {});
  await new Promise(resolve => localServer.close(resolve));
}
