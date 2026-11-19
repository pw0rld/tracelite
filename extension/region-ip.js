import { BUILTIN_PROFILES } from "./region-config.js";

export const IP_LOOKUP_ORIGIN = "https://ipwho.is/*";
export const IP_LOOKUP_URL = "https://ipwho.is/?fields=success,country_code,timezone.id";
export const IP_LOOKUP_PROVIDER = "ipwho.is";

const MAX_RESPONSE_BYTES = 16 * 1024;
const ZONE_COUNTRIES = new Map([
  ["Asia/Tokyo", ["JP"]],
  ["Asia/Singapore", ["SG"]],
  ["America/Los_Angeles", ["US"]],
  ["America/New_York", ["US"]],
  ["America/Chicago", ["US"]],
  ["America/Denver", ["US"]],
  ["America/Phoenix", ["US"]],
  ["America/Anchorage", ["US"]],
  ["Pacific/Honolulu", ["US"]],
  ["America/Adak", ["US"]],
  ["America/Puerto_Rico", ["US", "PR", "VI"]],
  ["Pacific/Pago_Pago", ["US", "AS"]],
  ["Pacific/Guam", ["US", "GU", "MP"]]
]);
const ZONES = new Map([...ZONE_COUNTRIES.keys()].map(zone => [zone.toLowerCase(), zone]));

// These cities follow the same present-day civil-time rules as the preset.
// No matching uses the current UTC offset: Phoenix and Denver, for example,
// sometimes share an offset but follow different daylight-saving rules.
const ALIASES = new Map();
for (const [zone, aliases] of [
  ["America/New_York", ["America/Detroit", "America/Indiana/Indianapolis", "America/Indianapolis", "America/Indiana/Marengo", "America/Indiana/Petersburg", "America/Indiana/Vevay", "America/Indiana/Vincennes", "America/Indiana/Winamac", "America/Kentucky/Louisville", "America/Louisville", "America/Kentucky/Monticello"]],
  ["America/Chicago", ["America/Menominee", "America/Indiana/Knox", "America/Knox_IN", "America/Indiana/Tell_City", "America/North_Dakota/Beulah", "America/North_Dakota/Center", "America/North_Dakota/New_Salem"]],
  ["America/Denver", ["America/Boise"]],
  ["America/Anchorage", ["America/Juneau", "America/Nome", "America/Sitka", "America/Metlakatla", "America/Yakutat"]],
  ["America/Adak", ["America/Atka"]],
  ["Pacific/Guam", ["Pacific/Saipan"]],
  ["America/Puerto_Rico", ["America/St_Thomas", "America/Virgin"]],
  ["Pacific/Pago_Pago", ["Pacific/Samoa"]]
]) {
  for (const alias of aliases) ALIASES.set(alias.toLowerCase(), zone);
}

function knownZone(timezone) {
  if (typeof timezone !== "string" || timezone.length > 100) return null;
  const key = timezone.toLowerCase();
  const direct = ZONES.get(key) || ALIASES.get(key);
  if (direct) return direct;
  // Limit automatic canonicalization to US/* aliases. Canonicalizing arbitrary
  // foreign cities could otherwise accept a country/timezone mismatch.
  if (!key.startsWith("us/")) return null;
  try {
    const canonical = new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone.toLowerCase();
    return ZONES.get(canonical) || ALIASES.get(canonical) || null;
  } catch { return null; }
}

export function recommendProfile({ countryCode, timezone } = {}, profiles = BUILTIN_PROFILES) {
  const noMatch = { profileId: null, match: null };
  if (typeof countryCode !== "string" || !/^[A-Za-z]{2}$/.test(countryCode)) return noMatch;
  const zone = knownZone(timezone);
  if (!zone || !ZONE_COUNTRIES.get(zone).includes(countryCode.toUpperCase()) || !Array.isArray(profiles)) return noMatch;
  const candidates = profiles.filter(profile => typeof profile?.id === "string" && profile.timezoneMode !== "native" && knownZone(profile.timezone) === zone);
  const exact = candidates.find(profile => profile.timezone === timezone);
  if (exact) return { profileId: exact.id, match: "exact" };
  return candidates.length ? { profileId: candidates[0].id, match: "equivalent" } : noMatch;
}

class LookupError extends Error {}
const failure = message => new LookupError(message);

async function permissionGranted(api) {
  try {
    return await api.permissions.contains({ origins: [IP_LOOKUP_ORIGIN] });
  } catch {
    throw failure("无法确认查询服务权限，请重新授权后再试。");
  }
}

async function readBoundedJson(response, checkActive) {
  const declaredLength = response.headers?.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw failure("查询服务返回的数据过大，请稍后再试。");
  }
  if (!response.body?.getReader) throw failure("查询服务返回的数据无效，请稍后再试。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0, content = "";
  try {
    for (;;) {
      checkActive();
      const { done, value } = await reader.read();
      checkActive();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure("查询服务返回的数据无效，请稍后再试。");
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw failure("查询服务返回的数据过大，请稍后再试。");
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
    return JSON.parse(content);
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof LookupError) throw error;
    throw failure("查询服务返回的数据无效，请稍后再试。");
  } finally {
    reader.releaseLock();
  }
}

function locationFields(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.success !== true) {
    throw failure("查询服务未能识别出口位置，请稍后再试。");
  }
  const countryCode = payload.country_code;
  const timezone = payload.timezone?.id;
  if (typeof countryCode !== "string" || !/^[A-Za-z]{2}$/.test(countryCode) || typeof timezone !== "string" || timezone.length > 100 || !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(timezone)) {
    throw failure("查询服务返回的国家或时区无效，请稍后再试。");
  }
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw failure("查询服务返回的国家或时区无效，请稍后再试。"); }
  return { countryCode: countryCode.toUpperCase(), timezone };
}

export function createRegionIpLookup(api, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 5000,
  cooldownMs = 10000
} = {}) {
  let inflight = null, lastCompletedAt = null;

  function lookup() {
    if (inflight) return inflight;
    const controller = new AbortController();
    let expired = false, queried = false, timer;
    const checkActive = () => {
      if (expired) throw failure("出口位置查询超时，请稍后再试。");
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(failure("出口位置查询超时，请稍后再试。"));
      }, timeoutMs);
    });
    const operation = (async () => {
      if (!await permissionGranted(api)) throw failure("尚未授权查询服务，或权限已撤销；请重新授权后再试。");
      checkActive();
      if (lastCompletedAt !== null && now() - lastCompletedAt < cooldownMs) {
        const seconds = Math.max(1, Math.ceil((cooldownMs - Math.max(0, now() - lastCompletedAt)) / 1000));
        throw failure(`刚刚已查询，请 ${seconds} 秒后再试。`);
      }
      queried = true;
      const response = await fetchImpl(IP_LOOKUP_URL, {
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      checkActive();
      if (!response?.ok) {
        if (response?.status === 429) throw failure("查询服务次数已达上限，请稍后再试。");
        throw failure("查询服务暂不可用，请稍后再试。");
      }
      const payload = await readBoundedJson(response, checkActive);
      checkActive();
      const location = locationFields(payload);
      if (!await permissionGranted(api)) throw failure("查询服务权限已撤销，本次结果已丢弃。");
      checkActive();
      return { ...location, ...recommendProfile(location), provider: IP_LOOKUP_PROVIDER };
    })();
    inflight = Promise.race([operation, deadline]).catch(error => {
      if (error instanceof LookupError) throw error;
      throw failure("出口位置查询失败，请检查网络后重试。");
    }).finally(() => {
      clearTimeout(timer);
      controller.abort();
      if (queried) lastCompletedAt = now();
      inflight = null;
    });
    return inflight;
  }

  return { lookup };
}
