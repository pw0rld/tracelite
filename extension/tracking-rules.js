// An original, deliberately small baseline, not a copy of a remote filter list.
// Only third-party subresource requests are blocked; websites can be excepted.
// Vendor references for the categories represented here:
// https://developers.google.com/analytics/devguides/collection/ga4/tag-options
// https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup
// https://help.hotjar.com/hc/en-us/articles/115009336727
// https://docs.mixpanel.com/docs/tracking-methods/sdks/javascript
export const TRACKING_LIST_VERSION = "2026-11-17";
export const TRACKING_DOMAINS = Object.freeze([
  "google-analytics.com", "analytics.google.com", "doubleclick.net",
  "googlesyndication.com", "googleadservices.com", "bat.bing.com",
  "clarity.ms", "hotjar.com", "hotjar.io", "mixpanel.com",
  "api.amplitude.com", "api.segment.io", "cdn.segment.com",
  "analytics.tiktok.com", "analytics.twitter.com", "static.ads-twitter.com",
  "scorecardresearch.com", "quantserve.com", "pixel.wp.com", "stats.wp.com"
]);

export const TRACKING_PARAMS = Object.freeze([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "fbclid", "gclid", "dclid", "msclkid", "ttclid"
]);

// Unknown query keys make the whole navigation ineligible. In particular,
// OAuth state/code/nonce, signatures and tokens never join this allowlist.
// This conservative grammar intentionally leaves many business URLs alone.
export const SAFE_QUERY_PARAMS = Object.freeze([
  "q", "page", "id", "v", "t"
]);

const safe = "utm_(?:source|medium|campaign|term|content|id)|(?:fb|[gd]|tt)clid|msclkid|" + SAFE_QUERY_PARAMS.join("|");
// Keep the query grammar in one repeated group to fit Chrome's 2 KB compiled
// regex limit. A no-op queryTransform is skipped by Chrome itself:
// RulesetMatcherBase::CreateRedirectAction returns nullopt for an unchanged URL.
// https://chromium.googlesource.com/chromium/src.git/+/8e21953ab08e31a8cc63de007888b9a8097334b9/extensions/browser/api/declarative_net_request/ruleset_matcher_base.cc
// Exact lowercase keys matter: queryTransform removal is case-sensitive.
export const CLEAN_LINK_REGEX = `^https?://[^?#]*\\?(?:(?:${safe})(?:=[^&#]*)?(?:&|#.*$|$))+$`;

export const REQUEST_RULE_IDS = Object.freeze({ trackers: 8000, links: 8100 });
export const ownsRequestRule = id => Number.isInteger(id) && id >= 8000 && id < 9000;

export function requestProtectionRules(config) {
  const excluded = config.excludedDomains || [];
  const rules = [];
  if (config.trackers) rules.push({
    id: REQUEST_RULE_IDS.trackers, priority: 1, action: { type: "block" },
    condition: {
      requestDomains: [...TRACKING_DOMAINS], domainType: "thirdParty",
      resourceTypes: ["sub_frame", "script", "stylesheet", "image", "font", "object", "xmlhttprequest", "ping", "media", "websocket", "other"],
      ...(excluded.length ? { excludedInitiatorDomains: [...excluded] } : {})
    }
  });
  if (config.links) rules.push({
    id: REQUEST_RULE_IDS.links, priority: 1,
    action: { type: "redirect", redirect: { transform: { queryTransform: { removeParams: [...TRACKING_PARAMS] } } } },
    condition: {
      regexFilter: CLEAN_LINK_REGEX, isUrlFilterCaseSensitive: true,
      resourceTypes: ["main_frame"], requestMethods: ["get"],
      ...(excluded.length ? { excludedRequestDomains: [...excluded] } : {})
    }
  });
  return rules;
}
