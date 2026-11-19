export const BUILTIN_PROFILES = [
  { id: "native", name: "浏览器原生（不改写）", timezoneMode: "native", languageMode: "native", timezone: "", locale: "", languages: [] },
  { id: "jp", name: "日本 · 日语", timezone: "Asia/Tokyo", locale: "ja-JP", languages: ["ja-JP", "ja"] },
  { id: "sg-en", name: "新加坡 · 英语", timezone: "Asia/Singapore", locale: "en-SG", languages: ["en-SG", "en"] },
  { id: "us-en", name: "美国 · 洛杉矶（太平洋）· 英语", timezone: "America/Los_Angeles", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-ny", name: "美国 · 纽约（东部）· 英语", timezone: "America/New_York", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-chicago", name: "美国 · 芝加哥（中部）· 英语", timezone: "America/Chicago", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-denver", name: "美国 · 丹佛（山地）· 英语", timezone: "America/Denver", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-phoenix", name: "美国 · 凤凰城（亚利桑那，无夏令时）· 英语", timezone: "America/Phoenix", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-anchorage", name: "美国 · 安克雷奇（阿拉斯加）· 英语", timezone: "America/Anchorage", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-honolulu", name: "美国 · 檀香山（夏威夷，无夏令时）· 英语", timezone: "Pacific/Honolulu", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-adak", name: "美国 · 阿达克（阿留申群岛）· 英语", timezone: "America/Adak", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-puerto-rico", name: "美国属地 · 波多黎各／美属维京（大西洋）· 英语", timezone: "America/Puerto_Rico", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-samoa", name: "美国属地 · 美属萨摩亚 · 英语", timezone: "Pacific/Pago_Pago", locale: "en-US", languages: ["en-US", "en"] },
  { id: "us-guam", name: "美国属地 · 关岛／北马里亚纳 · 英语", timezone: "Pacific/Guam", locale: "en-US", languages: ["en-US", "en"] }
];

export function validateProfile(input, id) {
  if (!input || typeof input !== "object") throw new Error("地区配置格式无效");
  const name = String(input.name || "").trim();
  const mode = (value, label) => {
    if (value === undefined) return "override";
    if (value !== "native" && value !== "override") throw new Error(`${label}模式需为 native 或 override`);
    return value;
  };
  const timezoneMode = mode(input.timezoneMode, "时区"), languageMode = mode(input.languageMode, "语言");
  const timezone = String(input.timezone || "").trim();
  const locale = String(input.locale || "").trim();
  const languages = Array.isArray(input.languages) ? input.languages : String(input.languages || "").split(",");
  if (!name || name.length > 60) throw new Error("名称需为 1–60 个字符");
  let canonicalTimezone = "";
  if (timezoneMode === "override") {
    if (!timezone || timezone.length > 100) throw new Error("请输入 IANA 时区，如 Asia/Tokyo");
    try { canonicalTimezone = new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone; }
    catch { throw new Error("无效时区，请使用 IANA 名称，如 America/Los_Angeles"); }
  }
  function tag(value) {
    if (typeof value !== "string" || value.length > 50 || !/^[A-Za-z0-9-]+$/.test(value.trim())) throw new Error("语言需使用 BCP 47 标签，如 en-SG");
    try { return Intl.getCanonicalLocales(value.trim())[0]; } catch { throw new Error("无效语言标签：" + value); }
  }
  let canonicalLocale = "", canonicalLanguages = [];
  if (languageMode === "override") {
    canonicalLocale = tag(locale);
    canonicalLanguages = [...new Set(languages.filter(value => String(value).trim()).map(tag))];
    if (!canonicalLanguages.length || canonicalLanguages.length > 6) throw new Error("请选择 1–6 种网页语言");
    if (canonicalLanguages[0] !== canonicalLocale) throw new Error("第一网页语言需与区域格式相同，避免不一致");
  }
  return { id, name, timezoneMode, languageMode, timezone: canonicalTimezone, locale: canonicalLocale, languages: canonicalLanguages };
}

export function normalizeRegions(raw) {
  const custom = [];
  for (const item of Array.isArray(raw?.custom) ? raw.custom.slice(0, 20) : []) {
    if (!/^custom-[a-z0-9-]{1,60}$/.test(item?.id || "") || custom.some(p => p.id === item.id)) continue;
    try { custom.push(validateProfile(item, item.id)); } catch { /* Skip corrupt local records. */ }
  }
  const profiles = [...BUILTIN_PROFILES, ...custom];
  return { custom, defaultProfileId: profiles.some(p => p.id === raw?.defaultProfileId) ? raw.defaultProfileId : null };
}

export function profilesFor(regions) { return [...BUILTIN_PROFILES, ...regions.custom]; }

export const READING_EXPRESSION = `({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale:Intl.DateTimeFormat().resolvedOptions().locale, language:navigator.language,
  languages:Array.from(navigator.languages), offset:new Date().getTimezoneOffset(),
  userAgent:navigator.userAgent, hasClientHints:!!navigator.userAgentData})`;
