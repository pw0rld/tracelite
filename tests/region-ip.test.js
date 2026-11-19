import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_PROFILES } from "../extension/region-config.js";
import {
  IP_LOOKUP_ORIGIN, IP_LOOKUP_URL, IP_LOOKUP_PROVIDER,
  recommendProfile, createRegionIpLookup
} from "../extension/region-ip.js";

const permission = granted => ({ permissions: { contains: async () => granted } });
const location = (country = "US", zone = "America/Los_Angeles", extra = {}) => ({
  success: true, country_code: country, timezone: { id: zone }, ...extra
});
const response = (payload = location(), options) => new Response(JSON.stringify(payload), options);
const noMatch = { profileId: null, match: null };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test("all supported built-in preset timezones match their country exactly", () => {
  for (const profile of BUILTIN_PROFILES.filter(profile => profile.id !== "native")) {
    const countryCode = profile.id === "jp" ? "JP" : profile.id === "sg-en" ? "SG" : "US";
    assert.deepEqual(recommendProfile({ countryCode, timezone: profile.timezone }), { profileId: profile.id, match: "exact" }, profile.id);
  }
});

test("territories are accepted only for their own full timezone", () => {
  for (const [countryCode, timezone, profileId] of [
    ["AS", "Pacific/Pago_Pago", "us-samoa"],
    ["GU", "Pacific/Guam", "us-guam"],
    ["MP", "Pacific/Guam", "us-guam"],
    ["PR", "America/Puerto_Rico", "us-puerto-rico"],
    ["VI", "America/Puerto_Rico", "us-puerto-rico"]
  ]) {
    assert.deepEqual(recommendProfile({ countryCode, timezone }), { profileId, match: "exact" });
    assert.deepEqual(recommendProfile({ countryCode, timezone: "America/New_York" }), noMatch);
  }
});

test("explicit same-civil-time aliases recommend the right preset", () => {
  for (const [countryCode, timezone, profileId] of [
    ["US", "America/Detroit", "us-ny"],
    ["US", "America/Indiana/Indianapolis", "us-ny"],
    ["US", "America/Indiana/Marengo", "us-ny"],
    ["US", "America/Indiana/Petersburg", "us-ny"],
    ["US", "America/Indiana/Vevay", "us-ny"],
    ["US", "America/Indiana/Vincennes", "us-ny"],
    ["US", "America/Indiana/Winamac", "us-ny"],
    ["US", "America/Kentucky/Louisville", "us-ny"],
    ["US", "America/Kentucky/Monticello", "us-ny"],
    ["US", "America/Indiana/Knox", "us-chicago"],
    ["US", "America/Indiana/Tell_City", "us-chicago"],
    ["US", "America/Menominee", "us-chicago"],
    ["US", "America/North_Dakota/Beulah", "us-chicago"],
    ["US", "America/North_Dakota/Center", "us-chicago"],
    ["US", "America/North_Dakota/New_Salem", "us-chicago"],
    ["US", "America/Boise", "us-denver"],
    ["US", "America/Juneau", "us-anchorage"],
    ["US", "America/Nome", "us-anchorage"],
    ["US", "America/Sitka", "us-anchorage"],
    ["US", "America/Metlakatla", "us-anchorage"],
    ["US", "America/Yakutat", "us-anchorage"],
    ["MP", "Pacific/Saipan", "us-guam"],
    ["VI", "America/St_Thomas", "us-puerto-rico"]
  ]) assert.deepEqual(recommendProfile({ countryCode, timezone }), { profileId, match: "equivalent" }, timezone);
});

test("US IANA links are canonicalized without guessing other foreign cities", () => {
  for (const [timezone, profileId] of [
    ["US/Pacific", "us-en"], ["US/Eastern", "us-ny"], ["US/Central", "us-chicago"],
    ["US/Mountain", "us-denver"], ["US/Arizona", "us-phoenix"],
    ["US/Alaska", "us-anchorage"], ["US/Hawaii", "us-honolulu"],
    ["US/Aleutian", "us-adak"], ["US/East-Indiana", "us-ny"]
  ]) assert.deepEqual(recommendProfile({ countryCode: "US", timezone }), { profileId, match: "equivalent" }, timezone);
  // Creston shares Phoenix's rules but is a Canadian location, not a US alias.
  assert.deepEqual(recommendProfile({ countryCode: "US", timezone: "America/Creston" }), noMatch);
});

test("timezones sharing a seasonal offset remain distinct", () => {
  assert.equal(recommendProfile({ countryCode: "US", timezone: "America/Phoenix" }).profileId, "us-phoenix");
  assert.equal(recommendProfile({ countryCode: "US", timezone: "America/Denver" }).profileId, "us-denver");
  assert.equal(recommendProfile({ countryCode: "US", timezone: "Pacific/Honolulu" }).profileId, "us-honolulu");
  assert.equal(recommendProfile({ countryCode: "US", timezone: "America/Adak" }).profileId, "us-adak");
  assert.deepEqual(recommendProfile({ countryCode: "US", timezone: "Etc/GMT+7" }), noMatch);
  assert.deepEqual(recommendProfile({ countryCode: "US", timezone: "-07:00" }), noMatch);
});

test("unknown or country-mismatched locations return no guess", () => {
  for (const input of [
    { countryCode: "CN", timezone: "Asia/Shanghai" },
    { countryCode: "CA", timezone: "America/New_York" },
    { countryCode: "JP", timezone: "America/New_York" },
    { countryCode: "SG", timezone: "Asia/Tokyo" },
    { countryCode: "US", timezone: "Asia/Singapore" },
    { countryCode: "UM", timezone: "Pacific/Honolulu" },
    { countryCode: "US", timezone: "Mars/Olympus" },
    { countryCode: "US", timezone: "UTC" }, {},
    { countryCode: "United States", timezone: "America/New_York" }
  ]) assert.deepEqual(recommendProfile(input), noMatch);
});

test("recommendations are restricted to supplied profiles and prefer exact matches", () => {
  assert.deepEqual(recommendProfile({ countryCode: "US", timezone: "America/New_York" }, []), noMatch);
  const profiles = [{ id: "custom-detroit", timezone: "America/Detroit" }, ...BUILTIN_PROFILES];
  assert.deepEqual(recommendProfile({ countryCode: "US", timezone: "America/New_York" }, profiles), { profileId: "us-ny", match: "exact" });
  assert.deepEqual(recommendProfile({ countryCode: "US", timezone: "America/Detroit" }, profiles), { profileId: "custom-detroit", match: "exact" });
});

test("creating the service performs no query; lookup uses a fixed private request", async () => {
  const permissionCalls = [], fetchCalls = [];
  const service = createRegionIpLookup({ permissions: { contains: async options => { permissionCalls.push(options); return true; } } }, {
    fetchImpl: async (...args) => { fetchCalls.push(args); return response(); }
  });
  assert.equal(fetchCalls.length, 0);
  assert.equal(permissionCalls.length, 0);
  const result = await service.lookup();
  assert.deepEqual(result, { countryCode: "US", timezone: "America/Los_Angeles", profileId: "us-en", match: "exact", provider: IP_LOOKUP_PROVIDER });
  assert.deepEqual(permissionCalls, [{ origins: [IP_LOOKUP_ORIGIN] }, { origins: [IP_LOOKUP_ORIGIN] }]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0][0], IP_LOOKUP_URL);
  const { signal, ...options } = fetchCalls[0][1];
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(options, { credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
});

test("only country/timezone and derived recommendation escape the provider response", async () => {
  const service = createRegionIpLookup(permission(true), {
    fetchImpl: async () => response(location("US", "America/Detroit", {
      ip: "203.0.113.8", latitude: 34.56, longitude: 87.65,
      city: "private city", message: "sensitive provider detail"
    }))
  });
  assert.deepEqual(await service.lookup(), {
    countryCode: "US", timezone: "America/Detroit", profileId: "us-ny", match: "equivalent", provider: "ipwho.is"
  });
});

test("valid unsupported country or timezone remains unmatched rather than failing or guessing", async () => {
  const service = createRegionIpLookup(permission(true), { fetchImpl: async () => response(location("CA", "America/Toronto")) });
  assert.deepEqual(await service.lookup(), {
    countryCode: "CA", timezone: "America/Toronto", profileId: null, match: null, provider: "ipwho.is"
  });
});

test("denied permission does not fetch or consume cooldown", async () => {
  let granted = false, fetches = 0;
  const service = createRegionIpLookup({ permissions: { contains: async () => granted } }, {
    fetchImpl: async () => { fetches++; return response(); }, now: () => 100
  });
  await assert.rejects(service.lookup(), /尚未授权|权限已撤销/);
  assert.equal(fetches, 0);
  granted = true;
  await service.lookup();
  assert.equal(fetches, 1);
});

test("permission API errors are sanitized and do not fetch", async () => {
  let fetches = 0;
  const service = createRegionIpLookup({ permissions: { contains: async () => { throw new Error("private-ip:203.0.113.8"); } } }, {
    fetchImpl: async () => { fetches++; return response(); }
  });
  await assert.rejects(service.lookup(), error => {
    assert.match(error.message, /无法确认查询服务权限/);
    assert.doesNotMatch(error.message, /private|203\.0\.113/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(fetches, 0);
});

test("provider HTTP errors never surface its response body", async () => {
  for (const status of [302, 403, 429, 500]) {
    const service = createRegionIpLookup(permission(true), {
      fetchImpl: async () => response({ message: "secret 203.0.113.8" }, { status })
    });
    await assert.rejects(service.lookup(), error => {
      assert.match(error.message, status === 429 ? /次数已达上限/ : /暂不可用/);
      assert.doesNotMatch(error.message, /secret|203\.0\.113/);
      return true;
    });
  }
});

test("provider failures and malformed location fields return safe Chinese errors", async () => {
  for (const payload of [
    { success: false, message: "secret 203.0.113.8" },
    { success: true, country_code: "US", timezone: { id: "secret 203.0.113.8" } },
    { success: true, country_code: "203.0.113.8", timezone: { id: "America/New_York" } },
    { success: true, country_code: "US", timezone: { id: "+08:00" } },
    { success: true, country_code: "US", timezone: { id: "Mars/Olympus" } },
    null, [], { success: true }
  ]) {
    const service = createRegionIpLookup(permission(true), { fetchImpl: async () => response(payload) });
    await assert.rejects(service.lookup(), error => {
      assert.match(error.message, /查询服务/);
      assert.doesNotMatch(error.message, /secret|203\.0\.113|Mars/);
      return true;
    });
  }
});

test("invalid JSON and invalid UTF-8 are rejected without forwarding body text", async () => {
  for (const body of ["secret 203.0.113.8", new Uint8Array([0xff, 0xfe])]) {
    const service = createRegionIpLookup(permission(true), { fetchImpl: async () => new Response(body) });
    await assert.rejects(service.lookup(), /查询服务返回的数据无效/);
  }
});

test("oversized declared and streamed bodies are rejected", async () => {
  let cancelled = false;
  const largeStream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; }
  });
  const service = createRegionIpLookup(permission(true), { fetchImpl: async () => new Response(largeStream) });
  await assert.rejects(service.lookup(), /返回的数据过大/);
  assert.equal(cancelled, true);
  const declared = createRegionIpLookup(permission(true), {
    fetchImpl: async () => response(location(), { headers: { "content-length": "999999" } })
  });
  await assert.rejects(declared.lookup(), /返回的数据过大/);
});

test("network errors are sanitized without retries", async () => {
  let fetches = 0;
  const service = createRegionIpLookup(permission(true), { fetchImpl: async () => { fetches++; throw new Error("secret 203.0.113.8"); } });
  await assert.rejects(service.lookup(), error => {
    assert.match(error.message, /查询失败/);
    assert.doesNotMatch(error.message, /secret|203\.0\.113/);
    return true;
  });
  assert.equal(fetches, 1);
});

test("fetch timeout resolves even when fetch ignores AbortSignal", async () => {
  let signal;
  const service = createRegionIpLookup(permission(true), {
    fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); }, timeoutMs: 15
  });
  await assert.rejects(service.lookup(), /查询超时/);
  assert.equal(signal.aborted, true);
});

test("timeout covers the entire body read", async () => {
  let signal;
  const service = createRegionIpLookup(permission(true), {
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"success":')); } }));
    }, timeoutMs: 15
  });
  await assert.rejects(service.lookup(), /查询超时/);
  assert.equal(signal.aborted, true);
});

test("a timed-out permission check cannot trigger a late outbound request", async () => {
  const wait = deferred();
  let fetches = 0;
  const service = createRegionIpLookup({ permissions: { contains: () => wait.promise } }, {
    fetchImpl: async () => { fetches++; return response(); }, timeoutMs: 15
  });
  await assert.rejects(service.lookup(), /查询超时/);
  wait.resolve(true);
  await tick();
  assert.equal(fetches, 0);
});

test("concurrent callers share one outbound request and result", async () => {
  const wait = deferred();
  let fetches = 0;
  const service = createRegionIpLookup(permission(true), {
    fetchImpl: () => { fetches++; return wait.promise; }
  });
  const first = service.lookup(), second = service.lookup();
  assert.equal(first, second);
  await tick();
  assert.equal(fetches, 1);
  wait.resolve(response());
  assert.deepEqual(await first, await second);
});

test("cooldown starts on completion and blocked repeats do not extend it", async () => {
  const wait = deferred();
  let current = 1000, fetches = 0;
  const service = createRegionIpLookup(permission(true), {
    now: () => current,
    fetchImpl: () => { fetches++; return fetches === 1 ? wait.promise : Promise.resolve(response()); }
  });
  const first = service.lookup();
  await tick();
  current = 8000;
  wait.resolve(response());
  await first;
  current = 17000;
  await assert.rejects(service.lookup(), /1 秒后再试/);
  assert.equal(fetches, 1);
  current = 18000;
  await service.lookup();
  assert.equal(fetches, 2);
});

test("failed queries consume cooldown and never retry automatically", async () => {
  let current = 0, fetches = 0;
  const service = createRegionIpLookup(permission(true), {
    now: () => current, fetchImpl: async () => { fetches++; return response({}, { status: 429 }); }
  });
  await assert.rejects(service.lookup(), /次数已达上限/);
  current = 9999;
  await assert.rejects(service.lookup(), /1 秒后再试/);
  assert.equal(fetches, 1);
  current = 10000;
  await assert.rejects(service.lookup(), /次数已达上限/);
  assert.equal(fetches, 2);
});

test("permission revoked during the request discards a late successful result", async () => {
  let granted = true, containsCalls = 0;
  const wait = deferred();
  const service = createRegionIpLookup({ permissions: { contains: async () => { containsCalls++; return granted; } } }, {
    fetchImpl: () => wait.promise
  });
  const request = service.lookup();
  await tick();
  granted = false;
  wait.resolve(response());
  await assert.rejects(request, /权限已撤销.*结果已丢弃/);
  assert.equal(containsCalls, 2);
});

test("permission revoked during final verification cannot return success", async () => {
  const verification = deferred();
  let containsCalls = 0;
  const service = createRegionIpLookup({ permissions: { contains: async () => ++containsCalls === 1 ? true : verification.promise } }, {
    fetchImpl: async () => response()
  });
  const request = service.lookup();
  await tick();
  assert.equal(containsCalls, 2);
  verification.resolve(false);
  await assert.rejects(request, /权限已撤销.*结果已丢弃/);
});
