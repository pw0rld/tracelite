// Real extension popup/drawer regression. Only authored loopback fixtures and a
// disposable browser profile are used; no daily browser or external site data.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserName = process.argv.find(value => value.startsWith("--browser="))?.split("=")[1] || "chrome";
assert.ok(["chrome", "brave"].includes(browserName));
const binary = browserName === "brave" ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const outputPrefix = browserName === "brave" ? "brave-cute" : "cute";
const scratch = await mkdtemp(path.join(tmpdir(), "tracelite-cute-popup-"));
const profile = path.join(scratch, "profile"), extension = path.join(scratch, "extension");
const hosts = ["tracelite-popup.test", "tracelite-popup-other.test"];
const report = { scope: "Real unpacked extension popup and settings drawer on authored loopback pages only",
  browserName, setup: "Optional permissions and host access pregranted only in disposable copy; initial native permission dialogs not tested",
  isolation: "Both .test hosts map to 127.0.0.1; only those hosts bypass a dead outbound proxy; no daily browser configuration",
  stages: [], dialogs: [], screenshots: [], passed: false };
let browser, server, cdp, ui, stderr = "";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const stage = (name, details = {}) => { report.stages.push({ name, ...details }); console.log("PASS " + name); };

try {
  await mkdir(profile); await cp(path.join(root, "extension"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...new Set([...manifest.permissions, ...(manifest.optional_permissions || [])])];
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_permissions; delete manifest.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(extension, "cute-probe.html"), "<!doctype html><title>Temporary TraceLite test controller</title>");
  report.version = manifest.version;
  server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url.startsWith("/echo")) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ language: request.headers["accept-language"] || null })); return;
    }
    if (request.url === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Authored TraceLite popup fixture</title><script>globalThis.fixtureReady=true;globalThis.fixtureLocale=()=>({language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});</script><body>Local popup fixture</body>");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://${hosts[0]}:${server.address().port}`, other = `http://${hosts[1]}:${server.address().port}`;
  report.origins = { base, other };
  browser = spawn(binary, ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-pipe", "--enable-unsafe-extension-debugging",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication", "--force-device-scale-factor=1",
    "--host-resolver-rules=" + hosts.map(host => `MAP ${host} 127.0.0.1`).join(", "),
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=" + hosts.join(";"), "about:blank"],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  let id = 0, buffer = ""; const pending = new Map();
  browser.stderr.on("data", value => { stderr = (stderr + value).slice(-4000); });
  browser.stdio[4].on("data", value => {
    buffer += value.toString(); let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.method === "Page.javascriptDialogOpening") {
        report.dialogs.push({ type: message.params.type, message: message.params.message });
        // This test only cancels destructive confirmations. Real deletion scope
        // is covered separately by the existing cleanup smoke test.
        cdp("Page.handleJavaScriptDialog", { accept: false }, message.sessionId).catch(() => {}); continue;
      }
      const entry = pending.get(message.id); if (!entry) continue;
      pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
    }
  });
  cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(method + " timed out: " + stderr)); }, 10000);
    pending.set(next, { resolve, reject, timer }); browser.stdio[3].write(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const evaluate = async (expression, sessionId, userGesture = false) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  const open = async url => {
    const { targetId } = await cdp("Target.createTarget", { url });
    return { targetId, ...(await cdp("Target.attachToTarget", { targetId, flatten: true })) };
  };
  const waitFor = async (check, label) => {
    const until = Date.now() + 9000;
    while (Date.now() < until) {
      try { if (await check()) return; }
      catch (error) { if (!/context.*destroyed|Cannot find context|No execution context|Frame.*removed|No frame/i.test(error.message)) throw error; }
      await delay(35);
    }
    throw new Error("Timed out: " + label);
  };
  const visible = (selector, sessionId) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';})()`, sessionId);
  const click = async (selector, sessionId) => {
    await waitFor(() => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&e.getBoundingClientRect().width>0;})()`, sessionId), "enabled " + selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`, sessionId, true);
  };
  const pressEscape = sessionId => cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  const screenshot = async (name, sessionId) => {
    const value = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, sessionId);
    await writeFile(path.join(root, "verification", name), Buffer.from(value.data, "base64")); report.screenshots.push(name);
  };
  const setTheme = async (theme, sessionId) => {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, sessionId);
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))", sessionId);
    // Button backgrounds transition for 150 ms; sample the settled theme rather
    // than a frame combining the new text color and previous background.
    await evaluate("Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))", sessionId);
  };
  // Read computed foreground/background pixels, compositing transparent ancestor
  // backgrounds and group opacity. These fixtures contain no background images
  // behind the sampled text; fail rather than treating such an image as a color.
  const contrastSnapshot = selectors => {
    const rgba = value => {
      const match = value.match(/^rgba?\(([^)]+)\)$/);
      if (!match) throw new Error("Unsupported computed color: " + value);
      const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [...parts.slice(0, 3).map(value => value / 255), parts[3] ?? 1];
    };
    const over = (front, back) => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      return alpha ? [0, 1, 2].map(index => (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / alpha).concat(alpha) : [0, 0, 0, 0];
    };
    const luminance = color => color.slice(0, 3).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const result = [];
    for (const selector of selectors) {
      const elements = [...document.querySelectorAll(selector)];
      if (!elements.length) throw new Error("Missing contrast target: " + selector);
      elements.forEach((element, index) => {
        const style = getComputedStyle(element);
        if (!element.getClientRects().length || style.visibility !== "visible" || element.closest("[hidden],:disabled,[aria-disabled=true]") || !element.textContent.trim()) return;
        let foreground = over(rgba(style.color), rgba(style.backgroundColor)), background = rgba(style.backgroundColor);
        for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
          const computed = getComputedStyle(ancestor);
          if (computed.backgroundImage !== "none") throw new Error("Image behind contrast target: " + selector);
          const opacity = Number(computed.opacity);
          foreground = [...foreground.slice(0, 3), foreground[3] * opacity];
          background = [...background.slice(0, 3), background[3] * opacity];
          if (ancestor.parentElement) {
            const parentBackground = rgba(getComputedStyle(ancestor.parentElement).backgroundColor);
            foreground = over(foreground, parentBackground); background = over(background, parentBackground);
          }
        }
        foreground = over(foreground, [1, 1, 1, 1]); background = over(background, [1, 1, 1, 1]);
        const first = luminance(foreground), second = luminance(background);
        result.push({ selector, index, text: element.textContent.trim().slice(0, 100), color: style.color,
          foreground, background, ratio: (Math.max(first, second) + .05) / (Math.min(first, second) + .05) });
      });
    }
    return result;
  };
  const checkContrast = async (selectors, theme, context, sessionId) => {
    await setTheme(theme, sessionId);
    const samples = await evaluate(`(${contrastSnapshot.toString()})(${JSON.stringify(selectors)})`, sessionId);
    report.contrast ??= []; report.contrast.push({ theme, context, samples });
    assert.ok(samples.length, "rendered contrast samples: " + context);
    for (const sample of samples) assert.ok(sample.ratio >= 4.5,
      `${theme} ${context}: ${sample.selector}[${sample.index}] contrast ${sample.ratio.toFixed(2)} < 4.5 (${sample.text})`);
  };

  report.browser = (await cdp("Browser.getVersion")).product;
  const extensionId = (await cdp("Extensions.loadUnpacked", { path: extension })).id;
  const controller = await open(`chrome-extension://${extensionId}/cute-probe.html`);
  await waitFor(() => evaluate("!!globalThis.chrome?.runtime", controller.sessionId), "extension controller");
  const send = async message => {
    const response = await evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`, controller.sessionId);
    assert.ok(response?.ok, JSON.stringify(response)); return response.data;
  };
  await send({ type: "status" });
  const tab = await evaluate(`chrome.tabs.create({url:${JSON.stringify(base + "/fixture")},active:false})`, controller.sessionId);
  await evaluate(`chrome.tabs.create({url:${JSON.stringify(other + "/fixture")},active:false})`, controller.sessionId);
  ui = await open(`chrome-extension://${extensionId}/popup.html?view=manage&tab=${tab.id}`);
  report.ui = { compatibilityURL: "popup.html?view=manage&tab=<fixture-tab>", note: "Saved tab binding is used because CDP opens the extension document as a target, not the browser action bubble" };
  await cdp("Page.enable", {}, ui.sessionId);
  await cdp("Emulation.setDeviceMetricsOverride", { width: 400, height: 600, deviceScaleFactor: 1, mobile: false }, ui.sessionId);
  await setTheme("light", ui.sessionId);
  await waitFor(() => evaluate("!!document.querySelector('#settings-drawer')&&!document.querySelector('#enabled').disabled", ui.sessionId), "new popup frontend ready");
  await waitFor(() => visible("#settings-drawer", ui.sessionId), "legacy manage URL opens drawer");
  await click("#settings-close", ui.sessionId);
  await waitFor(async () => !await visible("#settings-drawer", ui.sessionId), "drawer closed to main popup");
  await waitFor(() => evaluate(`document.querySelector('#origin').textContent.includes(${JSON.stringify(hosts[0])})&&!document.querySelector('#clear-site-cache').disabled`, ui.sessionId), "site context and cleanup controls ready");
  const layout = await evaluate(`(()=>{const box=document.body.getBoundingClientRect();const ids=['#enabled','#manage','#protect-trackers','#protect-links','#clear-site-cache','#clear-site-data','#region-shortcut'];return{body:{width:box.width,height:box.height},horizontalOverflow:document.documentElement.scrollWidth>innerWidth,controls:ids.map(selector=>{const e=document.querySelector(selector),r=e?.getBoundingClientRect();return{selector,exists:!!e,visible:!!r&&r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight};})};})()`, ui.sessionId);
  assert.equal(layout.horizontalOverflow, false); assert.ok(layout.body.width <= 420);
  for (const control of layout.controls) assert.ok(control.visible, "normal main action visible: " + JSON.stringify(control));
  stage("normal popup has visible primary controls and no horizontal overflow", layout);
  await screenshot(`${outputPrefix}-popup.png`, ui.sessionId);
  const mainText = [".brand p", "#origin", ".mint .feature-copy .hint", ".peach .feature-copy .hint", "#cleanup-scope",
    ".cleanup-consequence", "#region-short-status", "#app-footer span", "#manage"];
  await checkContrast(mainText, "light", "main popup", ui.sessionId);
  await checkContrast(mainText, "dark", "main popup", ui.sessionId);
  await screenshot(`${outputPrefix}-popup-dark.png`, ui.sessionId);
  await setTheme("light", ui.sessionId);

  const tabCount = () => evaluate("chrome.tabs.query({}).then(tabs=>tabs.length)", controller.sessionId);
  const beforeTabs = await tabCount();
  await click("#manage", ui.sessionId);
  await waitFor(() => visible("#settings-drawer", ui.sessionId), "settings drawer opened");
  const accessibility = await evaluate("(()=>{const e=document.querySelector('#settings-drawer');return{tag:e.tagName,role:e.getAttribute('role'),modal:e.getAttribute('aria-modal'),nativeModal:e.matches(':modal'),focusInside:e.contains(document.activeElement)}})()", ui.sessionId);
  assert.ok(accessibility.role === "dialog" || accessibility.tag === "DIALOG");
  assert.ok(accessibility.modal === "true" || accessibility.nativeModal); assert.equal(accessibility.focusInside, true);
  assert.equal(await tabCount(), beforeTabs, "settings stays inside the popup without opening another tab");
  for (const panel of ["basic", "region", "about"]) {
    await click(`[data-settings-tab="${panel}"]`, ui.sessionId);
    assert.equal(await visible(`[data-settings-panel="${panel}"]`, ui.sessionId), true, "settings panel visible: " + panel);
    if (panel === "basic") assert.equal(await evaluate("document.querySelectorAll('#settings .setting').length", ui.sessionId), 7);
    if (panel === "region") assert.ok(await evaluate("document.querySelectorAll('#region-panel details').length>=2 && !!document.querySelector('#region-profile')", ui.sessionId));
  }
  await click('[data-settings-tab="basic"]', ui.sessionId);
  await checkContrast(["#settings .setting .status"], "light", "native setting status", ui.sessionId);
  await checkContrast(["#settings .setting .status"], "dark", "native setting status", ui.sessionId);
  await setTheme("light", ui.sessionId);
  await screenshot(`${outputPrefix}-settings.png`, ui.sessionId);
  await pressEscape(ui.sessionId);
  await waitFor(async () => !await visible("#settings-drawer", ui.sessionId), "Escape closes settings");
  assert.equal(await evaluate("document.activeElement.id", ui.sessionId), "manage", "Escape returns focus to trigger");
  stage("three settings panels are accessible in a focused modal drawer, Escape closes and no tabs are created", accessibility);

  const protection = () => send({ type: "protectionStatus", tabId: tab.id });
  assert.equal((await protection()).config.trackers, false); assert.equal((await protection()).config.links, false);
  await click("#protect-trackers", ui.sessionId);
  await waitFor(async () => (await protection()).trackersActive === true, "trackers enabled via real popup");
  await click("#protect-links", ui.sessionId);
  await waitFor(async () => (await protection()).linksActive === true, "links enabled via real popup");
  const enabled = await protection();
  assert.equal(enabled.phase, "active");
  await click("#enabled", ui.sessionId);
  await waitFor(async () => (await send({ type: "status" })).config.enabled === false, "global pause");
  const paused = await protection();
  assert.equal(paused.config.trackers, true); assert.equal(paused.config.links, true); assert.equal(paused.active, false);
  assert.equal(await evaluate("chrome.declarativeNetRequest.getDynamicRules().then(rules=>rules.filter(rule=>rule.id>=8000&&rule.id<9000).length)", controller.sessionId), 0);
  await waitFor(() => evaluate("!document.querySelector('#enabled').disabled", ui.sessionId), "global toggle released");
  await click("#enabled", ui.sessionId);
  await waitFor(async () => (await protection()).trackersActive && (await protection()).linksActive, "global resume restores choices");
  stage("main popup request switches and global pause/resume manage real DNR rules and preserve choices", { enabled, paused, resumed: await protection() });

  await evaluate("window.cuteCleanupStarts=0;const originalSend=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(...args)=>{if(args[0]?.type==='cleanupStart')cuteCleanupStarts++;return originalSend(...args);};", ui.sessionId);
  for (const selector of ["#clear-site-cache", "#clear-site-data"]) {
    const before = report.dialogs.length;
    await click(selector, ui.sessionId);
    await waitFor(() => report.dialogs.length > before, "separate confirmation for " + selector);
    await waitFor(() => evaluate("!document.querySelector('#clear-site-cache').disabled&&!document.querySelector('#clear-site-data').disabled", ui.sessionId), "cleanup cancellation returns idle");
  }
  assert.equal(await evaluate("cuteCleanupStarts", ui.sessionId), 0);
  assert.equal(await send({ type: "cleanupStatus" }), null);
  assert.equal(report.dialogs.length, 2); assert.ok(report.dialogs.every(dialog => dialog.type === "confirm" && dialog.message.includes(base)));
  assert.ok(report.dialogs.some(dialog => dialog.message.includes("Cookie")));
  stage("cache and site data keep separate exact-origin confirmations; cancelling never starts deletion");

  const prepared = await send({ type: "cleanupPrepare", tabId: tab.id, kind: "cache" });
  const started = await send({ type: "cleanupStart", token: prepared.token });
  await waitFor(async () => (await send({ type: "cleanupStatus" }))?.state !== "running", "disposable cache job finishes");
  const jobBefore = await send({ type: "cleanupStatus" });
  await click("#manage", ui.sessionId); await click('[data-settings-tab="about"]', ui.sessionId); await click("#settings-close", ui.sessionId);
  const jobAfter = await send({ type: "cleanupStatus" });
  assert.equal(jobAfter.id, started.id); assert.equal(jobAfter.id, jobBefore.id); assert.equal(jobAfter.state, "done");
  assert.equal(await evaluate("cuteCleanupStarts", ui.sessionId), 0, "opening settings does not replay a cleanup action");
  stage("opening and closing settings preserves the existing independent cleanup job", { before: jobBefore, after: jobAfter });

  await send({ type: "regionApply", profileId: "us-en", tabId: tab.id });
  await evaluate("window.dispatchEvent(new Event('region-settings-changed'));window.dispatchEvent(new Event('focus'))", ui.sessionId);
  await waitFor(() => evaluate("document.body.innerText.includes('待刷新')", ui.sessionId), "real region refresh debt visible in main popup");
  assert.equal(await visible("#settings-drawer", ui.sessionId), false);
  await click("#region-shortcut", ui.sessionId);
  assert.equal(await visible('[data-settings-panel="region"]', ui.sessionId), true);
  await pressEscape(ui.sessionId);
  stage("real region refresh debt is visible on the main popup and the shortcut reaches region settings");
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
  if (cdp && ui?.sessionId) {
    try {
      const diagnostic = await cdp("Runtime.evaluate", { returnByValue: true, expression: "({title:document.title,text:document.body?.innerText?.slice(0,2400),drawer:document.querySelector('#settings-drawer')?.outerHTML?.slice(0,1500),focus:document.activeElement?.id})" }, ui.sessionId);
      report.failureUI = diagnostic.result.value;
    } catch { /* Preserve the original test failure if its target has closed. */ }
  }
  console.error(report.error);
} finally {
  try { if (cdp) await cdp("Browser.close"); } catch {}
  if (browser?.exitCode === null) await Promise.race([new Promise(resolve => browser.once("exit", resolve)), delay(1500)]);
  if (browser?.exitCode === null) browser.kill("SIGKILL");
  if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  await rm(scratch, { recursive: true, force: true });
  await mkdir(path.join(root, "verification"), { recursive: true });
  await writeFile(path.join(root, "verification", `${outputPrefix}-popup-smoke.json`), JSON.stringify(report, null, 2) + "\n");
}
