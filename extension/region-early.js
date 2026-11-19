import { BUILTIN_PROFILES } from "./region-config.js";

// Early entry files contain only fixed, bundled profiles. Arbitrary saved
// profiles still need the separately authorized asynchronous injection path.
export const EARLY_PROFILES = Object.freeze(BUILTIN_PROFILES.filter(profile => profile.id !== "native").map(profile => Object.freeze({
  key: profile.id,
  file: `early/${profile.id}.js`,
  profile: Object.freeze({ ...profile, timezoneMode: "override", languageMode: "override", languages: Object.freeze([...profile.languages]) })
})));

export function earlyProfileFor(profile) {
  if (!profile || (profile.timezoneMode !== undefined && profile.timezoneMode !== "override")
    || (profile.languageMode !== undefined && profile.languageMode !== "override") || !Array.isArray(profile.languages)) return null;
  const entry = EARLY_PROFILES.find(({ profile: fixed }) => profile.timezone === fixed.timezone && profile.locale === fixed.locale
    && profile.languages.length === fixed.languages.length && profile.languages.every((tag, index) => tag === fixed.languages[index]));
  return entry ? { key: entry.key, file: entry.file } : null;
}

// Self-contained: embedded in each bundled MAIN entry and used independently by
// the extension's isolated bootstrap/backend. A token only stops this document's
// propagation hooks; it cannot enable a profile or change extension settings.
// There is no secret in this deterministic token and it is not authentication.
export function earlyControlEvent(key, timeOrigin) {
  "use strict";
  if (typeof key !== "string" || !/^(jp|sg-en|us-(en|ny|chicago|denver|phoenix|anchorage|honolulu|adak|puerto-rico|samoa|guam))$/.test(key)
    || typeof timeOrigin !== "number" || !Number.isFinite(timeOrigin) || timeOrigin < 0) throw new TypeError("Invalid early document identity");
  const value = `${key}\n${timeOrigin}`;
  let a = 0x811c9dc5, b = 0x9e3779b9, c = 0x85ebca6b, d = 0xc2b2ae35;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x27d4eb2d);
    c = Math.imul(c ^ code, 0x165667b1);
    d = Math.imul(d ^ code, 0x85ebca77);
  }
  const hash = [a, b, c, d].map(part => (part >>> 0).toString(16).padStart(8, "0")).join("");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}

export function earlyStopTokens(timeOrigin) {
  if (typeof timeOrigin !== "number" || !Number.isFinite(timeOrigin) || timeOrigin <= 0) return [];
  return EARLY_PROFILES.map(({ key }) => earlyControlEvent(key, timeOrigin));
}
