// Bundled isolated-world content script. It never reads instructions from the
// page and cannot alter its Date/Intl globals. Each document asks the background
// twice so a pause/profile change invalidates any in-flight authorization.
// Built-in MAIN presets already ran at document_start; the reply records and
// verifies that result without replacing the page's APIs a second time.
// The only inbound action is a stop-only DOM event from our own extension.
// It works without another MAIN-world injection when scripting was revoked.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender?.id !== chrome.runtime.id || message?.type !== "regionStopPropagation"
    || typeof message.controlEvent !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(message.controlEvent)) return;
  window.dispatchEvent(new Event(message.controlEvent));
});
function stopRefusedEarlyEntries(reply) {
  if (!Array.isArray(reply?.stopEarlyTokens)) return;
  for (const token of reply.stopEarlyTokens.slice(0, 4)) if (typeof token === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token)) {
    window.dispatchEvent(new Event(token));
  }
}
window.addEventListener("pageshow", event => {
  if (!event.persisted || !event.isTrusted) return;
  void (async () => {
    try { stopRefusedEarlyEntries(await chrome.runtime.sendMessage({ type: "regionRecheckDocument", protocol: 2, timeOrigin: performance.timeOrigin })); }
    catch { /* An invalidated extension context cannot authorize a BFCache page. */ }
  })();
});
void (async () => {
  try {
    const grant = await chrome.runtime.sendMessage({ type: "regionBootstrap", protocol: 2, timeOrigin: performance.timeOrigin });
    stopRefusedEarlyEntries(grant);
    if (!Number.isSafeInteger(grant?.generation)) return;
    stopRefusedEarlyEntries(await chrome.runtime.sendMessage({ type: "regionDocument", protocol: 2, generation: grant.generation, timeOrigin: performance.timeOrigin }));
  } catch { /* A closed document or reloaded extension has nothing to apply. */ }
})();
