// Self-contained: passed to MAIN-world scripting.executeScript. This is a compatibility
// shim, not an undetectable browser/OS timezone change. Workers are not patched.
export function applyPageLocale(profile, targetRoot) {
  "use strict";
  const root = targetRoot || globalThis;
  const NativeDate = root.Date;
  const NativeIntl = root.Intl;
  const proto = NativeDate.prototype;
  const native = {};
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (typeof proto[name] === "function") native[name] = proto[name];
  }
  const nativeParse = NativeDate.parse;
  const nativeUTC = NativeDate.UTC;
  const NativeDateTimeFormat = NativeIntl.DateTimeFormat;
  const canonical = value => NativeIntl.getCanonicalLocales(value)[0];
  const original = new NativeDateTimeFormat().resolvedOptions();
  const nativeTimezone = profile.timezoneMode === "native", nativeLanguage = profile.languageMode === "native";
  const requestedTimezone = nativeTimezone ? original.timeZone : String(profile.timezone || profile.timeZone || profile.timezoneId || "");
  if (!requestedTimezone) throw new RangeError("A timezone is required");
  const timezone = new NativeDateTimeFormat("en", { timeZone: requestedTimezone }).resolvedOptions().timeZone;
  const locale = nativeLanguage ? original.locale : canonical(profile.locale || "en-US");
  const languages = root.Object.freeze(root.Array.from(nativeLanguage ? root.navigator?.languages || []
    : NativeIntl.getCanonicalLocales(profile.languages || [locale])));
  if (!nativeLanguage && !languages.length) throw new RangeError("A language is required");
  const changeTimezone = !nativeTimezone && timezone !== original.timeZone;
  const changeLocale = !nativeLanguage && locale !== canonical(original.locale);
  const changeLanguage = !nativeLanguage && !!root.navigator && root.navigator.language !== languages[0];
  const changeLanguages = !nativeLanguage && !!root.navigator && Array.from(root.navigator.languages || []).join(",") !== languages.join(",");
  const changes = [changeTimezone && "timezone", changeLocale && "locale", (changeLanguage || changeLanguages) && "languages"].filter(Boolean);
  const description = { version: 3, timezone, locale, languages: [...languages], scope: "page-script", changes, changed: changes.length > 0 };
  // Matching a native value is not a reason to replace its API. This path keeps
  // function identities, property descriptors and every other realm untouched.
  if (!changes.length) return { applied: true, alreadyApplied: false, ...description };
  const formatter = new NativeDateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", era: "short"
  });
  const zoneName = new NativeDateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "long" });

  // Date.UTC treats years 0..99 specially. This helper deliberately does not.
  function wallEpoch(year, month, day, hour, minute, second, ms) {
    const value = new NativeDate(0);
    native.setUTCFullYear.call(value, year, month, day);
    native.setUTCHours.call(value, hour, minute, second, ms);
    return native.getTime.call(value);
  }
  function partsAt(time) {
    if (!Number.isFinite(time)) return null;
    const values = {};
    try {
      for (const part of formatter.formatToParts(new NativeDate(time))) values[part.type] = part.value;
    } catch { return null; }
    const year = values.era === "BC" ? 1 - +values.year : +values.year;
    return [year, +values.month - 1, +values.day, +values.hour % 24, +values.minute, +values.second,
      native.getUTCMilliseconds.call(new NativeDate(time))];
  }
  function localEpoch(time) { const values = partsAt(time); return values ? wallEpoch(...values) : NaN; }
  function offsetAt(time) { return localEpoch(time) - time; }
  function fromWall(wall) {
    if (!Number.isFinite(wall)) return NaN;
    // Compatible disambiguation: the earlier instant in a repeated hour, and
    // move forward by the gap when local clock time does not exist.
    const offsets = [...new Set([-172800000, 0, 172800000].map(delta => offsetAt(wall + delta)).filter(Number.isFinite))];
    const candidates = offsets.map(offset => wall - offset).filter(Number.isFinite);
    const exact = candidates.filter(time => localEpoch(time) === wall);
    if (exact.length) return Math.min(...exact);
    const after = candidates.map(time => ({ time, delta: localEpoch(time) - wall })).filter(x => x.delta >= 0).sort((a, b) => a.delta - b.delta || a.time - b.time);
    return after[0]?.time ?? candidates[0] ?? NaN;
  }
  function parse(text) {
    // Template coercion follows the built-in's ToString operation, including
    // rejecting Symbols and using the string hint for objects.
    const value = `${text}`;
    // ISO date-only strings remain UTC, as the language requires. Explicit Z
    // and numeric offsets also remain native. Other legacy parsing is native.
    if (/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(value)) {
      return fromWall(nativeParse(value.replace(" ", "T") + "Z"));
    }
    return nativeParse(value);
  }
  function primitive(value) {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
    const convert = value[Symbol.toPrimitive];
    if (convert !== undefined && convert !== null) {
      if (typeof convert !== "function") throw new TypeError("Invalid primitive conversion");
      const answer = convert.call(value, "default");
      if (answer === null || (typeof answer !== "object" && typeof answer !== "function")) return answer;
      throw new TypeError("Cannot convert object to primitive value");
    }
    for (const key of ["valueOf", "toString"]) {
      const method = value[key];
      if (typeof method === "function") {
        const answer = Reflect.apply(method, value, []);
        if (answer === null || (typeof answer !== "object" && typeof answer !== "function")) return answer;
      }
    }
    throw new TypeError("Cannot convert object to primitive value");
  }
  function constructArgs(args) {
    if (!args.length) return [];
    if (args.length > 1) return [fromWall(nativeUTC(...args))];
    try { return [native.getTime.call(args[0])]; } catch { /* not a Date */ }
    const value = primitive(args[0]);
    return [typeof value === "string" ? parse(value) : value];
  }
  const dateNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  function dateString(time) {
    const p = partsAt(time);
    if (!p) return "Invalid Date";
    const weekday = native.getUTCDay.call(new NativeDate(wallEpoch(p[0], p[1], p[2], 0, 0, 0, 0)));
    const year = p[0] < 0 ? "-" + pad(-p[0], 4) : pad(p[0], 4);
    return `${dateNames[weekday]} ${monthNames[p[1]]} ${pad(p[2])} ${year}`;
  }
  function timeString(time) {
    const p = partsAt(time);
    if (!p) return "Invalid Date";
    const offset = Math.trunc(offsetAt(time) / 60000), absolute = Math.abs(offset);
    const name = zoneName.formatToParts(new NativeDate(time)).find(part => part.type === "timeZoneName")?.value || timezone;
    return `${pad(p[3])}:${pad(p[4])}:${pad(p[5])} GMT${offset >= 0 ? "+" : "-"}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)} (${name})`;
  }
  // Keep the original callable's name, arity and constructability. This does
  // not make the shim native: function identity and cross-realm readings can
  // still reveal it, and Function.prototype.toString is deliberately untouched.
  const callable = (target, implementation) => new Proxy(target, {
    apply(_target, receiver, args) { return Reflect.apply(implementation, receiver, args); }
  });
  const replace = (name, implementation) => {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    const target = native[name];
    const value = callable(target, function (...args) {
      // Ask the original method to report an invalid receiver. Running a
      // setter on a valid Date here would mutate it or coerce arguments twice.
      try { Reflect.apply(native.getTime, this, []); }
      catch { return Reflect.apply(target, this, args); }
      return Reflect.apply(implementation, this, args);
    });
    Object.defineProperty(proto, name, { ...descriptor, value });
  };
  if (changeTimezone) {
  const WrappedDate = new Proxy(NativeDate, {
    apply() { const time = NativeDate.now(); return `${dateString(time)} ${timeString(time)}`; },
    construct(target, args, newTarget) {
      return Reflect.construct(target, constructArgs(args), newTarget);
    }
  });
  // The original parse remains captured above; preserve its property flags.
  Object.defineProperty(WrappedDate, "parse", { ...Object.getOwnPropertyDescriptor(NativeDate, "parse"), value: callable(nativeParse, parse) });
  Object.defineProperty(proto, "constructor", { ...Object.getOwnPropertyDescriptor(proto, "constructor"), value: WrappedDate });
  Object.defineProperty(root, "Date", { ...Object.getOwnPropertyDescriptor(root, "Date"), value: WrappedDate });
  const getters = { getFullYear: 0, getMonth: 1, getDate: 2, getHours: 3, getMinutes: 4, getSeconds: 5, getMilliseconds: 6 };
  for (const [name, index] of Object.entries(getters)) replace(name, function () {
    const p = partsAt(native.getTime.call(this)); return p ? p[index] : NaN;
  });
  replace("getYear", function () { const p = partsAt(native.getTime.call(this)); return p ? p[0] - 1900 : NaN; });
  replace("getDay", function () {
    const p = partsAt(native.getTime.call(this));
    return p ? native.getUTCDay.call(new NativeDate(wallEpoch(p[0], p[1], p[2], 0, 0, 0, 0))) : NaN;
  });
  replace("getTimezoneOffset", function () { const minutes = Math.trunc(-offsetAt(native.getTime.call(this)) / 60000); return minutes === 0 ? 0 : minutes; });
  replace("toDateString", function () { return dateString(native.getTime.call(this)); });
  replace("toTimeString", function () { return timeString(native.getTime.call(this)); });
  replace("toString", function () { const t = native.getTime.call(this); return Number.isFinite(t) ? `${dateString(t)} ${timeString(t)}` : "Invalid Date"; });
  for (const [name, start, count, revive] of [
    ["setMilliseconds", 6, 1], ["setSeconds", 5, 2], ["setMinutes", 4, 3], ["setHours", 3, 4],
    ["setDate", 2, 1], ["setMonth", 1, 2], ["setFullYear", 0, 3, true]
  ]) replace(name, function (...args) {
    const t = native.getTime.call(this);
    const p = Number.isNaN(t) && revive ? [1970, 0, 1, 0, 0, 0, 0] : partsAt(t);
    const converted = args.slice(0, count).map(value => +value);
    if (!p) return native.setTime.call(this, NaN);
    p[start] = converted[0];
    for (let i = 1; i < converted.length; i++) p[start + i] = converted[i];
    return native.setTime.call(this, fromWall(wallEpoch(...p)));
  });
  replace("setYear", function (year) {
    const t = native.getTime.call(this), y = +year;
    const p = Number.isNaN(t) ? [1970, 0, 1, 0, 0, 0, 0] : partsAt(t);
    p[0] = y >= 0 && y <= 99 ? Math.trunc(y) + 1900 : y;
    return native.setTime.call(this, fromWall(wallEpoch(...p)));
  });
  }
  function localeArg(locales) { return changeLocale && (locales === undefined || (Array.isArray(locales) && !locales.length)) ? locale : locales; }
  function dateOptions(options) {
    if (!changeTimezone) return options;
    if (options === null) return null;
    const copy = options === undefined ? {} : Object.create(Object(options));
    if (copy.timeZone === undefined) Object.defineProperty(copy, "timeZone", { value: timezone, enumerable: true, configurable: true });
    return copy;
  }
  if (changeTimezone || changeLocale) for (const name of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) replace(name, function (locales, options) {
    return native[name].call(this, localeArg(locales), dateOptions(options));
  });
  for (const name of ["DateTimeFormat", "NumberFormat", "Collator", "PluralRules", "RelativeTimeFormat", "ListFormat", "DisplayNames", "Segmenter", "DurationFormat"]) {
    if (name === "DateTimeFormat" ? !changeTimezone && !changeLocale : !changeLocale) continue;
    const Constructor = NativeIntl[name];
    if (typeof Constructor !== "function") continue;
    const argsFor = args => [localeArg(args[0]), name === "DateTimeFormat" ? dateOptions(args[1]) : args[1]];
    const wrapped = new Proxy(Constructor, {
      apply(target, receiver, args) { return Reflect.apply(target, receiver, argsFor(args)); },
      construct(target, args, newTarget) { return Reflect.construct(target, argsFor(args), newTarget); }
    });
    Object.defineProperty(NativeIntl, name, { ...Object.getOwnPropertyDescriptor(NativeIntl, name), value: wrapped });
    const descriptor = Object.getOwnPropertyDescriptor(Constructor.prototype, "constructor");
    if (descriptor?.value === Constructor && descriptor.configurable) {
      Object.defineProperty(Constructor.prototype, "constructor", { ...descriptor, value: wrapped });
    }
  }
  // Only navigator.language(s) is changed. UA, hardware and Client Hints stay native.
  if (changeLanguage || changeLanguages) {
    for (const [key, value] of [["language", languages[0]], ["languages", languages]]) {
      if (key === "language" ? !changeLanguage : !changeLanguages) continue;
      let owner = root.navigator;
      while (owner && !Object.hasOwn(owner, key)) owner = Object.getPrototypeOf(owner);
      const desc = owner && Object.getOwnPropertyDescriptor(owner, key);
      // A missing or non-accessor property is not a safe native getter to wrap.
      // Avoid introducing a new own property or discarding its existing shape.
      if (!desc?.configurable || typeof desc.get !== "function") continue;
      const get = callable(desc.get, function (...args) {
        Reflect.apply(desc.get, this, args);
        return value;
      });
      Object.defineProperty(owner, key, { ...desc, get });
    }
  }
  // Document-level duplicate injection is guarded by the extension backend.
  // Do not publish an extension-specific marker into the page's global object.
  return { applied: true, alreadyApplied: false, ...description };
}
