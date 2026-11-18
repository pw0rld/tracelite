export const DEFINITIONS = [
  { id: "webrtc", section: "network", key: "webRTCIPHandlingPolicy", value: "disable_non_proxied_udp", title: "限制 WebRTC 非代理 UDP", description: "减少 UDP 绕过代理的风险。仍允许 WebRTC；会议可能改走 TCP 或无法连接，不保证隐藏所有地址。" },
  { id: "prediction", section: "network", key: "networkPredictionEnabled", value: false, title: "关闭预测与预加载", description: "减少 Chrome 自身提前解析和连接。网页主动发起的 DNS 预取仍可能发生。" },
  { id: "cookies", section: "websites", key: "thirdPartyCookiesAllowed", value: false, title: "限制第三方 Cookie", description: "保留第一方登录。站点授权、分区 Cookie 等仍可能存在，部分跨站登录会受影响。" },
  { id: "ping", section: "websites", key: "hyperlinkAuditingEnabled", value: false, title: "关闭链接审计 ping", description: "关闭 <a ping> 点击上报，不能阻止网站自行用脚本发送统计。" },
  { id: "topics", section: "websites", key: "topicsEnabled", value: false, title: "关闭广告主题 Topics", description: "停用 Chrome 提供的兴趣主题接口；不可用时显示为浏览器不提供。" },
  { id: "audience", section: "websites", key: "fledgeEnabled", value: false, title: "关闭 Protected Audience", description: "停用浏览器内广告受众接口；不影响网页中普通广告脚本。" },
  { id: "measurement", section: "websites", key: "adMeasurementEnabled", value: false, title: "关闭广告衡量接口", description: "停用 Attribution Reporting / Private Aggregation；不阻止所有广告追踪。" }
];

export function normalOrigin(input) {
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    // Chrome content-setting patterns require wildcard paths. Keep the scheme and port.
    return url.origin;
  } catch { return null; }
}

export function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const selected = Object.fromEntries(DEFINITIONS.map(d => [d.id, source.selected?.[d.id] !== false]));
  const blockedOrigins = Array.isArray(source.blockedOrigins)
    ? [...new Set(source.blockedOrigins.map(normalOrigin).filter(Boolean))].slice(0, 100) : [];
  return { version: 1, enabled: source.enabled !== false, selected, blockedOrigins };
}

export function originPattern(origin) {
  const clean = normalOrigin(origin);
  if (!clean) throw new Error("仅支持 HTTP / HTTPS 站点");
  const url = new URL(clean);
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}/*`;
}

function invoke(api, target, method, args) {
  return new Promise((resolve, reject) => {
    try {
      target[method](args, result => {
        const error = api.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      });
    } catch (error) { reject(error); }
  });
}

export async function readSetting(api, definition, config, failure = null, incognito = false) {
  const target = api.privacy?.[definition.section]?.[definition.key];
  const wanted = config.enabled && config.selected[definition.id];
  if (!target) return { ...definition, wanted, status: "unsupported", effective: null };
  try {
    const details = await invoke(api, target, "get", { incognito });
    const matches = details.value === definition.value;
    const own = details.levelOfControl === "controlled_by_this_extension";
    const status = failure ? "error" : !wanted ? (own ? "error" : "released")
      : matches ? (own ? "active" : "external")
      : ["not_controllable", "controlled_by_other_extensions"].includes(details.levelOfControl) ? "blocked" : "inactive";
    return { ...definition, wanted, status, effective: details.value, level: details.levelOfControl,
      error: failure || (!wanted && own ? "尚未成功释放设置" : null) };
  } catch (error) {
    return { ...definition, wanted, status: "error", effective: null, error: failure || error.message };
  }
}

export async function applySettings(api, config) {
  const rows = [];
  for (const definition of DEFINITIONS) {
    const target = api.privacy?.[definition.section]?.[definition.key];
    let failure = null;
    if (target) {
      try {
        const wanted = config.enabled && config.selected[definition.id];
        if (!wanted) {
          // clear() releases OUR override; never force true over the user's earlier settings.
          await invoke(api, target, "clear", { scope: "regular" });
        } else {
          const current = await invoke(api, target, "get", {});
          if (["controllable_by_this_extension", "controlled_by_this_extension"].includes(current.levelOfControl)) {
            await invoke(api, target, "set", { value: definition.value, scope: "regular" });
          }
        }
      } catch (error) { failure = error.message; }
    }
    rows.push(await readSetting(api, definition, config, failure));
  }
  return rows;
}

export async function applySiteRules(api, config, previous = null) {
  // contentSettings.clear removes only this extension's rules, never the user's site settings.
  const errors = [];
  const desired = config.enabled ? config.blockedOrigins : [];
  const before = previous ? (previous.enabled ? previous.blockedOrigins : []) : null;
  if (before && before.length === desired.length && before.every(origin => desired.includes(origin))) return errors;
  const incremental = before && before.every(origin => desired.includes(origin));
  if (!incremental) {
    try {
      await invoke(api, api.contentSettings.javascript, "clear", { scope: "regular" });
    } catch (error) { return [{ origin: "*", error: error.message }]; }
  }
  if (config.enabled) {
    for (const origin of desired.filter(origin => !incremental || !before.includes(origin))) {
      try {
        await invoke(api, api.contentSettings.javascript, "set", { primaryPattern: originPattern(origin), setting: "block", scope: "regular" });
      } catch (error) { errors.push({ origin, error: error.message }); }
    }
  }
  return errors;
}

export async function readSiteSetting(api, origin, incognito = false) {
  if (!origin) return null;
  try {
    const details = await invoke(api, api.contentSettings.javascript, "get", { primaryUrl: origin + "/", incognito });
    return { setting: details.setting };
  } catch (error) { return { setting: null, error: error.message }; }
}
