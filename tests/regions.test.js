import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { BUILTIN_PROFILES, validateProfile, normalizeRegions, profilesFor } from "../extension/region-config.js";
import { languageRule, readEarlyDocument } from "../extension/regions.js";
import { applyPageLocale } from "../extension/page-locale.js";

test("three requested regions and US timezones have consistent language presets", () => {
  assert.equal(BUILTIN_PROFILES.find(p => p.id === "jp").timezone, "Asia/Tokyo");
  assert.equal(BUILTIN_PROFILES.find(p => p.id === "sg-en").locale, "en-SG");
  assert.equal(BUILTIN_PROFILES.find(p => p.id === "us-en").timezone, "America/Los_Angeles");
  for (const profile of BUILTIN_PROFILES.filter(profile => profile.languageMode !== "native")) assert.equal(validateProfile(profile, profile.id).languages[0], profile.locale);
});

test("first built-in native preset does not require or retain override fields", () => {
  assert.equal(BUILTIN_PROFILES[0].id, "native");
  assert.deepEqual(validateProfile({ name: "原生", timezoneMode: "native", languageMode: "native" }, "custom-native"), {
    id: "custom-native", name: "原生", timezoneMode: "native", languageMode: "native", timezone: "", locale: "", languages: []
  });
  const profile = validateProfile({ ...BUILTIN_PROFILES[0], timezone: "BAD/Z0NE", locale: "bad!", languages: ["bad\r\nheader"] }, "custom-native");
  assert.equal(profile.timezone, ""); assert.equal(profile.locale, ""); assert.deepEqual(profile.languages, []);
});

test("time zone and language can independently retain their native values", () => {
  const nativeTime = validateProfile({ name: "仅语言", timezoneMode: "native", locale: "en-gb", languages: ["en-gb", "en"] }, "custom-language");
  assert.equal(nativeTime.timezone, ""); assert.equal(nativeTime.languageMode, "override");
  assert.equal(nativeTime.locale, "en-GB"); assert.deepEqual(nativeTime.languages, ["en-GB", "en"]);
  const nativeLanguage = validateProfile({ name: "仅时区", languageMode: "native", timezone: "Asia/Tokyo" }, "custom-timezone");
  assert.equal(nativeLanguage.timezone, "Asia/Tokyo"); assert.equal(nativeLanguage.timezoneMode, "override");
  assert.equal(nativeLanguage.locale, ""); assert.deepEqual(nativeLanguage.languages, []);
  assert.throws(() => validateProfile({ ...nativeTime, locale: "bad!" }, nativeTime.id), /语言/);
  assert.throws(() => validateProfile({ ...nativeLanguage, timezone: "BAD/Z0NE" }, nativeLanguage.id), /时区/);
});

test("legacy profiles default both dimensions to override and reject invalid modes", () => {
  const legacy = BUILTIN_PROFILES.find(profile => profile.id === "jp");
  const result = validateProfile(legacy, "custom-legacy");
  assert.equal(result.timezoneMode, "override"); assert.equal(result.languageMode, "override");
  assert.equal(result.timezone, legacy.timezone); assert.deepEqual(result.languages, legacy.languages);
  for (const field of ["timezoneMode", "languageMode"]) {
    for (const value of [null, "", "system", false]) assert.throws(() => validateProfile({ ...legacy, [field]: value }, "custom-invalid"), /模式/);
  }
  const normalized = normalizeRegions({ defaultProfileId: "custom-legacy", custom: [{ ...legacy, id: "custom-legacy" }, { ...legacy, id: "custom-bad", timezoneMode: "system" }] });
  assert.equal(normalized.custom.length, 1); assert.equal(normalized.defaultProfileId, "custom-legacy");
  assert.equal(normalized.custom[0].timezoneMode, "override");
});

test("custom profile validates IANA zones and BCP47 labels without header injection", () => {
  const result = validateProfile({ name: "英区", timezone: "Europe/London", locale: "en-gb", languages: ["en-gb", "en", "en"] }, "custom-one");
  assert.equal(result.locale, "en-GB");
  assert.deepEqual(result.languages, ["en-GB", "en"]);
  assert.throws(() => validateProfile({ ...result, timezone: "BAD/Z0NE" }, result.id), /时区/);
  assert.throws(() => validateProfile({ ...result, languages: ["en-GB\r\nX-Foo: bad"] }, result.id), /语言/);
  assert.throws(() => validateProfile({ ...result, languages: ["en-GB", "en;q=0.9"] }, result.id), /语言/);
  assert.throws(() => validateProfile({ ...result, languages: ["zh-CN"] }, result.id), /第一网页语言/);
});

test("profile restore discards corrupt entries and missing default IDs", () => {
  const region = normalizeRegions({ defaultProfileId: "absent", custom: [{ ...BUILTIN_PROFILES.find(profile => profile.id === "jp"), id: "jp" }, { ...BUILTIN_PROFILES.find(profile => profile.id === "sg-en"), id: "custom-ok" }] });
  assert.equal(region.custom.length, 1);
  assert.equal(region.defaultProfileId, null);
  assert.equal(profilesFor(region).length, BUILTIN_PROFILES.length + 1);
});

test("DNR changes only language header; weights are confined to HTTP header", () => {
  const result = languageRule(BUILTIN_PROFILES.find(profile => profile.id === "jp"));
  assert.deepEqual(result.action.requestHeaders, [{header:"accept-language",operation:"set",value:"ja-JP,ja;q=0.9"}]);
  assert.equal(result.action.responseHeaders, undefined);
  assert.ok(result.condition.resourceTypes.includes("main_frame"));
});

test("early readback validates actual APIs without changing the document", () => {
  const profile = BUILTIN_PROFILES.find(profile => profile.id === "jp");
  const context = vm.createContext({ performance: { timeOrigin: 12345 } });
  const run = expression => vm.runInContext(expression, context);
  run("globalThis.navigator=Object.create({get language(){return 'zh-CN'},get languages(){return ['zh-CN','zh']}})");
  run("globalThis.originalDate=Date;globalThis.originalFormat=Intl.DateTimeFormat");
  const before = run(`(${readEarlyDocument.toString()})(${JSON.stringify(profile)})`);
  assert.equal(before.applied, false);
  assert.equal(run("Date===originalDate && Intl.DateTimeFormat===originalFormat"), true);
  run(`(${applyPageLocale.toString()})(${JSON.stringify(profile)})`);
  const after = run(`(${readEarlyDocument.toString()})(${JSON.stringify(profile)})`);
  assert.equal(after.applied, true); assert.equal(after.timeOrigin, 12345);
  assert.equal(after.readings.timezone, "Asia/Tokyo");
  run("Date.prototype.getTimezoneOffset=()=>0");
  const conflict = run(`(${readEarlyDocument.toString()})(${JSON.stringify(profile)})`);
  assert.equal(conflict.applied, false); assert.match(conflict.error, /Date.*Intl/);
  assert.equal(run("new Date().getTimezoneOffset()"), 0, "readback does not repair or hide the conflict");
});
