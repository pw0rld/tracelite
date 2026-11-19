import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { BUILTIN_PROFILES, validateProfile, normalizeRegions, profilesFor } from "../extension/region-config.js";
import { languageRule, readEarlyDocument } from "../extension/regions.js";
import { applyPageLocale } from "../extension/page-locale.js";

test("Japanese, Singapore and US presets have consistent language settings", () => {
  assert.equal(BUILTIN_PROFILES.find(p => p.id === "jp").timezone, "Asia/Tokyo");
  assert.equal(BUILTIN_PROFILES.find(p => p.id === "sg-en").locale, "en-SG");
  assert.equal(BUILTIN_PROFILES.find(p => p.id === "us-en").timezone, "America/Los_Angeles");
  for (const profile of BUILTIN_PROFILES.filter(profile => profile.languageMode !== "native")) assert.equal(validateProfile(profile, profile.id).languages[0], profile.locale);
  for (const profile of BUILTIN_PROFILES.filter(profile => profile.id.startsWith("us-"))) {
    assert.equal(profile.locale, "en-US");
    assert.deepEqual(profile.languages, ["en-US", "en"]);
  }
});

test("US presets cover standard zones and preserve winter/summer exceptions", async t => {
  // Minutes west of UTC, as Date.getTimezoneOffset reports. Phoenix and
  // Honolulu stay fixed, while Denver and Adak observe daylight saving time.
  const expected = [
    ["us-en", "America/Los_Angeles", 480, 420],
    ["us-ny", "America/New_York", 300, 240],
    ["us-chicago", "America/Chicago", 360, 300],
    ["us-denver", "America/Denver", 420, 360],
    ["us-phoenix", "America/Phoenix", 420, 420],
    ["us-anchorage", "America/Anchorage", 540, 480],
    ["us-honolulu", "Pacific/Honolulu", 600, 600],
    ["us-adak", "America/Adak", 600, 540],
    ["us-puerto-rico", "America/Puerto_Rico", 240, 240],
    ["us-samoa", "Pacific/Pago_Pago", 660, 660],
    ["us-guam", "Pacific/Guam", -600, -600]
  ];
  assert.deepEqual(new Set(BUILTIN_PROFILES.filter(profile => profile.id.startsWith("us-")).map(profile => profile.id)),
    new Set(expected.map(([id]) => id)));
  for (const [id, timezone, winterOffset, summerOffset] of expected) await t.test(id, () => {
    const profile = BUILTIN_PROFILES.find(profile => profile.id === id);
    assert.equal(profile.timezone, timezone);
    const context = vm.createContext({});
    const run = expression => vm.runInContext(expression, context);
    run("globalThis.navigator=Object.create({get language(){return 'zh-CN'},get languages(){return ['zh-CN','zh']}})");
    run(`(${applyPageLocale.toString()})(${JSON.stringify(profile)})`);
    assert.equal(run("Intl.DateTimeFormat().resolvedOptions().timeZone"), timezone);
    assert.equal(run("new Date('2026-01-15T12:00:00Z').getTimezoneOffset()"), winterOffset);
    assert.equal(run("new Date('2026-07-15T12:00:00Z').getTimezoneOffset()"), summerOffset);
    assert.equal(run("navigator.languages.join()"), "en-US,en");
    assert.equal(languageRule(profile).action.requestHeaders[0].value, "en-US,en;q=0.9");
  });
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
