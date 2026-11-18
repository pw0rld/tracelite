import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { applyPageLocale } from "../extension/page-locale.js";

function realm(profile, prepare = "") {
  const context = vm.createContext({});
  vm.runInContext(`{
    const navigators = new WeakSet();
    globalThis.navigator = Object.create({
      get language(){if (!navigators.has(this)) throw new TypeError('Illegal invocation'); return 'zh-CN'},
      get languages(){if (!navigators.has(this)) throw new TypeError('Illegal invocation'); return ['zh-CN','zh']}
    });
    navigators.add(navigator);
  }`, context);
  const run = expression => vm.runInContext(expression, context);
  if (prepare) run(prepare);
  run(`globalThis.before = {
    Date, parse: Date.parse, utc: Date.UTC, now: Date.now,
    functionToString: Function.prototype.toString,
    parseDescriptor: Object.getOwnPropertyDescriptor(Date, 'parse'),
    dateDescriptors: Object.getOwnPropertyDescriptors(Date.prototype),
    intl: Object.fromEntries(Object.getOwnPropertyNames(Intl).filter(key => typeof Intl[key] === 'function').map(key => [key, Intl[key]])),
    navigatorOwner: Object.getPrototypeOf(navigator),
    navigatorDescriptors: Object.getOwnPropertyDescriptors(Object.getPrototypeOf(navigator)),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    language: navigator.language, languages: Array.from(navigator.languages)
  }`);
  const input = typeof profile === "function" ? profile(run) : profile;
  const result = run(`(${applyPageLocale.toString()})(${JSON.stringify(input)})`);
  return { run, result };
}
const la = { timezone: "America/Los_Angeles", locale: "en-US", languages: ["en-US", "en"] };
const tokyo = { timezone: "Asia/Tokyo", locale: "ja-JP", languages: ["ja-JP", "ja"] };
test("self-contained function works in a fresh MAIN-like realm", () => {
  const { run, result } = realm(tokyo);
  assert.equal(result.applied, true);
  assert.equal(run("navigator.language"), "ja-JP");
  assert.equal(run("JSON.stringify(navigator.languages)"), '["ja-JP","ja"]');
  assert.equal(run("Intl.DateTimeFormat().resolvedOptions().timeZone"), "Asia/Tokyo");
  assert.equal(run("Intl.DateTimeFormat().resolvedOptions().locale"), "ja-JP");
  assert.equal(run("Intl.NumberFormat().resolvedOptions().locale"), "ja-JP");
});
test("LA DST offsets, local getters, UTC timestamps and native methods agree", () => {
  const { run } = realm(la);
  assert.equal(run("new Date('2026-01-15T12:00:00Z').getTimezoneOffset()"), 480);
  assert.equal(run("new Date('2026-07-15T12:00:00Z').getTimezoneOffset()"), 420);
  assert.equal(run("new Date('2026-07-15T12:00:00Z').getHours()"), 5);
  assert.equal(run("new Date(0).getTime()"), 0);
  assert.equal(run("new Date(0).getUTCFullYear()"), 1970);
  assert.equal(run("new Date(0).getFullYear()"), 1969);
  assert.equal(run("new Date(0).getDay()"), 3);
  assert.equal(run("new Date(0).toISOString()"), "1970-01-01T00:00:00.000Z");
  assert.equal(run("Date.UTC(1970,0,1)"), 0);
  assert.match(run("new Date(0).toString()"), /^Wed Dec 31 1969 16:00:00 GMT-0800/);
});
test("numeric constructors and ISO local parsing use the selected timezone", () => {
  const { run } = realm(tokyo);
  assert.equal(run("new Date(2026,0,1,12,30,40,500).toISOString()"), "2026-01-01T03:30:40.500Z");
  assert.equal(run("new Date('2026-01-01T12:30:40.500').toISOString()"), "2026-01-01T03:30:40.500Z");
  assert.equal(run("Date.parse('2026-01-01T12:30')"), Date.parse("2026-01-01T03:30Z"));
  assert.equal(run("new Date('2026-01-01').toISOString()"), "2026-01-01T00:00:00.000Z");
  assert.equal(run("new Date('2026-01-01T12:30+02:00').toISOString()"), "2026-01-01T10:30:00.000Z");
  assert.equal(run("new Date(99,0,1).getFullYear()"), 1999);
});
test("DST gap moves forward and repeated local hour selects earlier instant", () => {
  const { run } = realm(la);
  assert.equal(run("new Date(2026,2,8,2,30).toISOString()"), "2026-03-08T10:30:00.000Z");
  assert.equal(run("new Date(2026,2,8,2,30).getHours()"), 3);
  assert.equal(run("new Date(2026,10,1,1,30).toISOString()"), "2026-11-01T08:30:00.000Z");
  assert.equal(run("new Date('2026-11-01T01:30').toISOString()"), "2026-11-01T08:30:00.000Z");
});
test("local setters normalize across days and DST, and UTC setters stay native", () => {
  const { run } = realm(la);
  assert.equal(run("(()=>{const d=new Date(2026,2,8,1,30);d.setHours(2);return d.toISOString()})()"), "2026-03-08T10:30:00.000Z");
  assert.equal(run("(()=>{const d=new Date(2026,0,31,12);d.setMonth(1);return d.getMonth()+':'+d.getDate()})()"), "2:3");
  assert.equal(run("(()=>{const d=new Date(0);d.setUTCHours(12);return d.toISOString()})()"), "1970-01-01T12:00:00.000Z");
  assert.equal(run("(()=>{const d=new Date(2026,0,1);d.setHours();return Number.isNaN(d.getTime())})()"), true);
  assert.equal(run("(()=>{const d=new Date(NaN);d.setFullYear(2026,0,1);return d.getFullYear()})()"), 2026);
  assert.equal(run("(()=>{const d=new Date(NaN);d.setFullYear(2026);return d.toISOString()})()"), "2026-01-01T08:00:00.000Z");
  assert.equal(run("(()=>{const d=new Date(NaN);d.setYear(2026);return d.toISOString()})()"), "2026-01-01T08:00:00.000Z");
});
test("Intl defaults change but explicit locales and timezones are preserved", () => {
  const { run } = realm(tokyo);
  assert.equal(run("Intl.DateTimeFormat('en-GB',{timeZone:'UTC'}).resolvedOptions().timeZone"), "UTC");
  assert.equal(run("Intl.DateTimeFormat('en-GB',{timeZone:'UTC'}).resolvedOptions().locale"), "en-GB");
  assert.equal(run("Intl.NumberFormat('de-DE').resolvedOptions().locale"), "de-DE");
  assert.equal(run("new Date(0).toLocaleString('en-GB',{timeZone:'UTC'})"), "01/01/1970, 00:00:00");
  assert.match(run("new Date(0).toLocaleTimeString('en-GB')"), /^09:00:00$/);
});
test("invalid dates and Date subclasses remain usable", () => {
  const { run } = realm(tokyo);
  assert.equal(run("new Date('no date').toString()"), "Invalid Date");
  assert.equal(run("Number.isNaN(new Date(NaN).getTimezoneOffset())"), true);
  assert.equal(run("(()=>{class Child extends Date{};const d=new Child(2026,0,1);return d instanceof Child && d instanceof Date})()"), true);
  assert.equal(run("Date.parse(new Date(0).toString())"), 0);
  assert.equal(run("new Date(new Date(0)).getTime()"), 0);
});
test("page does not publish an extension-specific global marker", () => {
  const { run } = realm(tokyo);
  assert.equal(run("Object.hasOwn(globalThis,'__privacyGuardLocale')"), false);
  assert.equal(run("navigator.language"), "ja-JP");
});

test("modified Date callables retain native metadata, flags and non-constructability", () => {
  const { run } = realm(tokyo);
  assert.equal(run(`Object.entries(before.dateDescriptors).every(([key, descriptor]) => {
    const current = Object.getOwnPropertyDescriptor(Date.prototype, key);
    if (key === 'constructor' || current.value === descriptor.value) return true;
    return current.configurable === descriptor.configurable && current.enumerable === descriptor.enumerable
      && current.writable === descriptor.writable && current.value.name === descriptor.value.name
      && current.value.length === descriptor.value.length && !Object.hasOwn(current.value, 'prototype')
      && /\\{\\s*\\[native code\\]\\s*\\}\\s*$/.test(Function.prototype.toString.call(current.value));
  })`), true);
  assert.equal(run(`Date.parse.name === before.parse.name && Date.parse.length === before.parse.length
    && !Object.hasOwn(Date.parse, 'prototype')
    && ['configurable','enumerable','writable'].every(key => Object.getOwnPropertyDescriptor(Date,'parse')[key] === before.parseDescriptor[key])`), true);
  assert.equal(run(`['getTimezoneOffset','getHours','setHours','toString','toLocaleString'].every(key => {
    try { Reflect.construct(Date.prototype[key], []); return false; }
    catch (error) { return error instanceof TypeError; }
  })`), true);
  assert.equal(run("Function.prototype.toString === before.functionToString"), true);
  // Borrow a fresh realm's intrinsic, as a page can do with an iframe.
  const foreignToString = vm.runInNewContext("Function.prototype.toString");
  assert.match(foreignToString.call(run("Date.prototype.getTimezoneOffset")), /\{\s*\[native code\]\s*\}\s*$/);
});

test("Date methods and navigator getters keep rejecting invalid receivers", () => {
  const { run } = realm(tokyo);
  assert.equal(run(`(() => {
    const failure = (fn, receiver) => {
      try { Reflect.apply(fn, receiver, []); return null; }
      catch (error) { return error.name + ':' + error.message; }
    };
    return ['getTimezoneOffset','getHours','setHours','toString','toLocaleString'].every(key =>
      [null, undefined, {}, 4, 'text'].every(receiver =>
        failure(Date.prototype[key], receiver) === failure(before.dateDescriptors[key].value, receiver)));
  })()`), true);
  assert.equal(run(`['language','languages'].every(key => {
    const original = before.navigatorDescriptors[key], current = Object.getOwnPropertyDescriptor(before.navigatorOwner,key);
    return !Object.hasOwn(navigator,key) && current.get.name === original.get.name && current.get.length === original.get.length
      && !Object.hasOwn(current.get,'prototype') && current.configurable === original.configurable
      && current.enumerable === original.enumerable && current.set === original.set
      && [null,undefined,{},3,'text'].every(receiver => {
        try { Reflect.apply(current.get,receiver,[]); return false; }
        catch (error) { return error instanceof TypeError && error.message === 'Illegal invocation'; }
      });
  })`), true);
});

test("Date.parse keeps native string conversion failures and coerces once", () => {
  const { run } = realm(tokyo);
  assert.equal(run(`(() => {
    try { Date.parse(Symbol('date')); return false; } catch (error) { return error instanceof TypeError; }
  })()`), true);
  assert.equal(run(`(() => {
    const hints = []; const value = { [Symbol.toPrimitive](hint) { hints.push(hint); return '2026-01-01T12:00'; } };
    return Date.parse(value) === Date.UTC(2026,0,1,3) && hints.join() === 'string';
  })()`), true);
});

test("Date construction treats a null primitive hook as absent and reads fallback methods once", () => {
  const { run } = realm(tokyo);
  assert.equal(run(`new Date({[Symbol.toPrimitive]:null,valueOf(){return 123}}).getTime()`), 123);
  assert.equal(run(`(() => {
    const reads = [], calls = [];
    const value = {
      [Symbol.toPrimitive]:null,
      get valueOf() { reads.push('valueOf'); return function() { calls.push(this === value ? 'valueOf' : 'wrong'); return {}; }; },
      get toString() { reads.push('toString'); return function() { calls.push(this === value ? 'toString' : 'wrong'); return '2026-01-01T12:00'; }; }
    };
    return new Date(value).getTime() === Date.UTC(2026,0,1,3)
      && reads.join() === 'valueOf,toString' && calls.join() === 'valueOf,toString';
  })()`), true);
});

test("exposed Date and Intl constructors agree with instance constructor properties", () => {
  const { run } = realm(tokyo);
  assert.equal(run("new Date().constructor === Date && Date.prototype.constructor === Date"), true);
  assert.equal(run(`['DateTimeFormat','NumberFormat','Collator','PluralRules','RelativeTimeFormat','ListFormat','Segmenter','DurationFormat']
    .filter(key => typeof Intl[key] === 'function').every(key => new Intl[key]().constructor === Intl[key])`), true);
  assert.equal(run("new Intl.DisplayNames(undefined,{type:'language'}).constructor === Intl.DisplayNames"), true);
  assert.equal(run(`(() => { class Format extends Intl.DateTimeFormat {};
    const value = new Format(); return value instanceof Format && value instanceof Intl.DateTimeFormat && value.constructor === Format;
  })()`), true);
});

test("an existing data-valued navigator property is left intact", () => {
  const { run } = realm(tokyo, "Object.defineProperty(Object.getPrototypeOf(navigator),'language',{value:'zh-CN',writable:true,configurable:true})");
  assert.equal(run("navigator.language"), "zh-CN");
  assert.equal(run("Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator),'language').get"), undefined);
  assert.equal(run("navigator.languages[0]"), "ja-JP");
});

const unchangedDate = `Date === before.Date && Date.parse === before.parse && Date.UTC === before.utc && Date.now === before.now
  && Object.entries(before.dateDescriptors).every(([key, descriptor]) => {
    const current = Object.getOwnPropertyDescriptor(Date.prototype, key);
    return current && current.value === descriptor.value && current.get === descriptor.get && current.set === descriptor.set
      && current.configurable === descriptor.configurable && current.enumerable === descriptor.enumerable && current.writable === descriptor.writable;
  })`;
const unchangedNavigator = `Object.getPrototypeOf(navigator) === before.navigatorOwner && !Object.hasOwn(navigator, 'language') && !Object.hasOwn(navigator, 'languages')
  && ['language', 'languages'].every(key => {
    const current = Object.getOwnPropertyDescriptor(before.navigatorOwner, key), original = before.navigatorDescriptors[key];
    return current.get === original.get && current.set === original.set && current.value === original.value
      && current.configurable === original.configurable && current.enumerable === original.enumerable;
  })`;

test("native modes retain all Date methods, Intl constructors and navigator descriptors", () => {
  const { run, result } = realm({ timezoneMode: "native", languageMode: "native" });
  assert.equal(result.changed, false);
  assert.deepEqual(Array.from(result.changes), []);
  assert.equal(run(unchangedDate), true);
  assert.equal(run("Object.entries(before.intl).every(([key, value]) => Intl[key] === value)"), true);
  assert.equal(run(unchangedNavigator), true);
});

test("an exact match to the realm's native settings does not replace any API", () => {
  const { run, result } = realm(run => JSON.parse(run(`JSON.stringify({ timezone: before.timezone, locale: before.locale, languages: before.languages })`)));
  assert.equal(result.changed, false);
  assert.deepEqual(Array.from(result.changes), []);
  assert.equal(run(unchangedDate), true);
  assert.equal(run("Object.entries(before.intl).every(([key, value]) => Intl[key] === value)"), true);
  assert.equal(run(unchangedNavigator), true);
});

test("changing only language priority retains the already matching primary getter", () => {
  const { run, result } = realm(run => ({ timezoneMode: "native", locale: run("before.locale"), languages: ["zh-CN", "en"] }));
  assert.equal(result.changed, true);
  assert.equal(run("Object.getOwnPropertyDescriptor(before.navigatorOwner, 'language').get === before.navigatorDescriptors.language.get"), true);
  assert.equal(run("Object.getOwnPropertyDescriptor(before.navigatorOwner, 'languages').get === before.navigatorDescriptors.languages.get"), false);
  assert.equal(run(unchangedDate), true);
  assert.equal(run("Object.entries(before.intl).every(([key, value]) => Intl[key] === value)"), true);
});

test("language-only changes leave Date construction, parsing, local getters and strings native", () => {
  let locale;
  const { run, result } = realm(run => {
    locale = run("before.locale.startsWith('ja') ? 'en-US' : 'ja-JP'");
    return { timezoneMode: "native", languageMode: "override", locale, languages: [locale] };
  });
  assert.equal(result.changed, true);
  assert.equal(run("Date === before.Date && Date.parse === before.parse && Date.UTC === before.utc && Date.now === before.now"), true);
  assert.equal(run(`Object.entries(before.dateDescriptors).filter(([key]) => !['toLocaleString','toLocaleDateString','toLocaleTimeString'].includes(key))
    .every(([key, descriptor]) => Object.getOwnPropertyDescriptor(Date.prototype,key).value === descriptor.value)`), true);
  assert.equal(run(`['toLocaleString','toLocaleDateString','toLocaleTimeString'].every(key => Date.prototype[key] !== before.dateDescriptors[key].value)`), true);
  assert.equal(run("Intl.DateTimeFormat !== before.intl.DateTimeFormat && Intl.NumberFormat !== before.intl.NumberFormat"), true);
  assert.equal(run("Intl.DateTimeFormat().resolvedOptions().locale"), locale);
  assert.equal(run("Intl.NumberFormat().resolvedOptions().locale"), locale);
  assert.equal(run("Intl.DateTimeFormat().resolvedOptions().timeZone === before.timezone"), true);
  assert.equal(run("navigator.language"), locale);
  assert.equal(run(`new Date(0).toLocaleString() === before.dateDescriptors.toLocaleString.value.call(new before.Date(0), ${JSON.stringify(locale)})`), true);
  assert.equal(run("new Date(0).toLocaleString('de-DE') === before.dateDescriptors.toLocaleString.value.call(new before.Date(0), 'de-DE')"), true);
});

test("timezone-only changes preserve navigator and unrelated Intl constructors", () => {
  let timezone;
  const { run, result } = realm(run => {
    timezone = run("before.timezone === 'Asia/Tokyo' ? 'America/Los_Angeles' : 'Asia/Tokyo'");
    return { timezoneMode: "override", languageMode: "native", timezone };
  });
  assert.equal(result.changed, true);
  assert.deepEqual(Array.from(result.changes), ["timezone"]);
  assert.equal(run(unchangedNavigator), true);
  assert.equal(run("Object.entries(before.intl).filter(([key]) => key !== 'DateTimeFormat').every(([key, value]) => Intl[key] === value)"), true);
  assert.equal(run("Intl.DateTimeFormat !== before.intl.DateTimeFormat && Date !== before.Date"), true);
  assert.equal(run("Intl.DateTimeFormat().resolvedOptions().locale === before.locale"), true);
  assert.equal(run("Intl.DateTimeFormat().resolvedOptions().timeZone"), timezone);
  const stamp = Date.UTC(2026, 0, 15, 12, 0, 0);
  assert.equal(run(`new Date(${stamp}).getHours() === Number(new before.intl.DateTimeFormat('en-US', {timeZone:${JSON.stringify(timezone)},hour:'numeric',hourCycle:'h23'}).format(new before.Date(${stamp})))`), true);
  assert.equal(run(`(() => {
    const parts = Object.fromEntries(new before.intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone:${JSON.stringify(timezone)},year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',hourCycle:'h23'
    }).formatToParts(new before.Date(${stamp})).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const wall = before.utc(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
    return new Date(${stamp}).getTimezoneOffset() === (${stamp} - wall) / 60000;
  })()`), true);
  assert.equal(run("Intl.DateTimeFormat('de-DE',{timeZone:'UTC'}).resolvedOptions().timeZone"), "UTC");
  assert.equal(run("Intl.DateTimeFormat('de-DE',{timeZone:'UTC'}).resolvedOptions().locale"), "de-DE");
  assert.equal(run("new Date(0).toLocaleString('de-DE',{timeZone:'UTC'}) === before.dateDescriptors.toLocaleString.value.call(new before.Date(0),'de-DE',{timeZone:'UTC'})"), true);
});

test("equal timezone offsets do not suppress a change to a different IANA timezone", () => {
  // Give this isolated realm a Tokyo native default without changing the host TZ.
  // Seoul has the same modern UTC offset, but its timezone identity must remain distinct.
  const { run, result } = realm({ timezoneMode: "override", languageMode: "native", timezone: "Asia/Seoul" }, `
    const RealDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = new Proxy(RealDateTimeFormat, {
      apply(target, receiver, args) {
        return Reflect.apply(target, receiver, [args[0], {timeZone:'Asia/Tokyo', ...args[1]}]);
      },
      construct(target, args, newTarget) {
        return Reflect.construct(target, [args[0], {timeZone:'Asia/Tokyo', ...args[1]}], newTarget);
      }
    });
  `);
  assert.equal(run("before.timezone"), "Asia/Tokyo");
  assert.equal(run("new before.intl.DateTimeFormat('en-US',{timeZone:'Asia/Tokyo',hour:'numeric'}).format(new before.Date('2026-01-15T12:00Z')) === new before.intl.DateTimeFormat('en-US',{timeZone:'Asia/Seoul',hour:'numeric'}).format(new before.Date('2026-01-15T12:00Z'))"), true);
  assert.equal(result.changed, true);
  assert.deepEqual(Array.from(result.changes), ["timezone"]);
  assert.equal(run("Intl.DateTimeFormat().resolvedOptions().timeZone"), "Asia/Seoul");
  assert.equal(run("new Date('2026-01-15T12:00Z').getTimezoneOffset()"), -540);
  assert.equal(run(unchangedNavigator), true);
});
