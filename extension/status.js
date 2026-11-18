export function summarizeState(state) {
  const settingFailure = state.settings.some(row => row.status === "error" || (row.wanted && ["blocked", "inactive"].includes(row.status)));
  const region = state.region || {};
  const cleanup = Boolean(region.cleanupPending?.scripts || region.cleanupPending?.headers);
  const regionFailure = cleanup || ["error", "cleanup"].includes(region.status) || (region.status === "setup" && region.requested) || Boolean(region.errors?.length);
  const protection = state.protection || {};
  const protectionFailure = protection.cleanupPending || ["error", "cleanup", "needs-permission"].includes(protection.phase)
    || Boolean(protection.errors?.length);
  const failed = settingFailure || Boolean(state.siteErrors?.length) || regionFailure || protectionFailure;
  const refresh = (region.needsRefresh || 0) > 0 || region.refreshUnknown === true;
  const text = failed ? "!" : !state.config.enabled ? "OFF" : refresh ? "↻" : "ON";
  const title = failed ? "TraceLite：设置或清理未完成，请检查"
    : !state.config.enabled && refresh ? "TraceLite：已暂停；已有页面需刷新"
    : refresh ? "TraceLite：已有页面需刷新"
    : state.config.enabled ? "TraceLite：基础设置已应用" : "TraceLite：已暂停";
  return { failed, refresh, text, title, color: failed || refresh ? "#b45309" : state.config.enabled ? "#0f766e" : "#64748b" };
}
