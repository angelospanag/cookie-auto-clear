// Safari's WebExtension implementation exposes the promise-based `browser`
// namespace, but fall back to `chrome` in case it isn't defined.
if (typeof browser === "undefined") {
  var browser = chrome;
}

const STORAGE_KEYS = {
  TAB_DOMAINS: "tabDomains",
  WHITELIST: "whitelist",
  LOG: "deletionLog",
  ENABLED: "enabled",
  GRACE_PERIOD_SECONDS: "gracePeriodSeconds",
  TOTAL_CLEARED: "totalCleared",
  CLEAN_ON_DOMAIN_CHANGE: "cleanOnDomainChange",
};

const DEFAULT_GRACE_PERIOD_SECONDS = 30;

// Suffixes where the registrable domain is the last THREE labels instead of
// the usual two (e.g. "example.co.uk", not "co.uk"). Not a full Public
// Suffix List - covers common ccTLDs. Extend as needed.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk", "nhs.uk",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "ad.jp", "ed.jp", "go.jp", "gr.jp", "lg.jp",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz", "school.nz",
  "co.za", "org.za", "gov.za", "net.za", "web.za",
  "com.br", "net.br", "org.br", "gov.br",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "co.in", "net.in", "org.in", "gov.in", "firm.in", "gen.in", "ind.in",
  "com.mx", "net.mx", "org.mx", "gob.mx",
  "com.ar", "net.ar", "org.ar", "gob.ar",
  "co.kr", "ne.kr", "or.kr", "go.kr",
  "com.tw", "net.tw", "org.tw", "gov.tw",
  "com.sg", "net.sg", "org.sg", "gov.sg", "edu.sg",
  "co.id", "net.id", "or.id", "go.id",
  "com.hk", "net.hk", "org.hk", "gov.hk", "edu.hk",
  "com.tr", "net.tr", "org.tr", "gov.tr",
  "co.il", "org.il", "net.il", "gov.il", "ac.il",
  "com.ua", "net.ua", "org.ua", "gov.ua",
  "co.th", "or.th", "go.th", "ac.th",
  "com.vn", "net.vn", "org.vn", "gov.vn",
  "com.ph", "net.ph", "org.ph", "gov.ph",
  "com.pk", "net.pk", "org.pk", "gov.pk",
  "co.ke", "or.ke", "go.ke",
  "com.ng", "org.ng", "gov.ng", "net.ng",
  "com.co", "net.co", "org.co", "gov.co",
  "com.pe", "net.pe", "org.pe", "gob.pe",
  "com.ve", "net.ve", "org.ve", "gob.ve",
]);

// Kept in sync with the identical copy in popup.js so tab domains and
// whitelist entries always normalize the same way.
function getRegistrableDomain(hostname) {
  if (!hostname) return null;
  hostname = hostname.toLowerCase().replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
    hostname.includes(":")
  ) {
    return hostname;
  }
  const labels = hostname.split(".");
  if (labels.length <= 2) return hostname;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

function domainFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return getRegistrableDomain(parsed.hostname);
  } catch {
    return null;
  }
}

async function getTabDomains() {
  const result = await browser.storage.local.get(STORAGE_KEYS.TAB_DOMAINS);
  return result[STORAGE_KEYS.TAB_DOMAINS] || {};
}

async function setTabDomains(map) {
  await browser.storage.local.set({ [STORAGE_KEYS.TAB_DOMAINS]: map });
}

// All reads/writes of the tabDomains map go through this queue so a
// read-mutate-write cycle always completes atomically. Without it, two tab
// events firing close together (e.g. closing two same-domain tabs at once)
// can each read the same stale snapshot and the later write silently
// clobbers the earlier one - losing track of a closed tab and leaving a
// domain permanently (until next browser restart) looking "still open".
let tabDomainsQueue = Promise.resolve();

function withTabDomains(mutator) {
  const run = tabDomainsQueue.then(async () => {
    const map = await getTabDomains();
    try {
      await mutator(map);
    } catch (err) {
      // Whatever partial edits `mutator` made to `map` before failing still
      // get persisted below - a failure here (e.g. the cookies API) must
      // never abort the write, or this tabId's entry gets stuck in storage,
      // permanently misreporting its domain as still open.
      console.error("cookie-auto-clear: tabDomains mutator failed", err);
    }
    await setTabDomains(map);
  });
  tabDomainsQueue = run.catch((err) => {
    console.error("cookie-auto-clear: tabDomains mutation failed", err);
  });
  return run;
}

async function getWhitelist() {
  const result = await browser.storage.local.get(STORAGE_KEYS.WHITELIST);
  return result[STORAGE_KEYS.WHITELIST] || [];
}

async function isEnabled() {
  const result = await browser.storage.local.get(STORAGE_KEYS.ENABLED);
  return result[STORAGE_KEYS.ENABLED] !== false;
}

async function isCleanOnDomainChangeEnabled() {
  const result = await browser.storage.local.get(STORAGE_KEYS.CLEAN_ON_DOMAIN_CHANGE);
  return result[STORAGE_KEYS.CLEAN_ON_DOMAIN_CHANGE] === true;
}

// Serializes log/tally writes. Several alarms can fire at once (e.g. after
// closing a window holding tabs on different sites), and an unserialized
// read-modify-write would let one sweep's entries overwrite another's.
//
// The log itself is capped at 50 entries for display, so the lifetime tally
// is tracked as its own running counter rather than derived by summing the
// (possibly-rolled-off) log - otherwise the total would silently shrink back
// down once older entries got evicted.
let logQueue = Promise.resolve();

function appendLogEntries(entries) {
  const nonEmpty = entries.filter((e) => e.count > 0);
  if (nonEmpty.length === 0) return Promise.resolve();
  const run = logQueue.then(async () => {
    const result = await browser.storage.local.get([STORAGE_KEYS.LOG, STORAGE_KEYS.TOTAL_CLEARED]);
    const log = result[STORAGE_KEYS.LOG] || [];
    const now = Date.now();
    let total = result[STORAGE_KEYS.TOTAL_CLEARED] || 0;
    for (const { domain, count } of nonEmpty) {
      log.unshift({ domain, count, timestamp: now });
      total += count;
    }
    await browser.storage.local.set({
      [STORAGE_KEYS.LOG]: log.slice(0, 50),
      [STORAGE_KEYS.TOTAL_CLEARED]: total,
    });
  });
  logQueue = run.catch((err) => {
    console.error("cookie-auto-clear: log write failed", err);
  });
  return run;
}

// Grace period before a closed site's cookies become eligible for clearing,
// so accidentally closing (and quickly reopening) a tab doesn't wipe a
// session. User-configurable via the popup (in seconds); 0 means "clear
// immediately", skipping the alarm entirely.
//
// Implemented via the alarms API rather than setTimeout: this is a
// non-persistent MV3 service worker, which the browser can suspend between
// events - a pending setTimeout would simply never fire if that happens,
// whereas an alarm is tracked by the browser itself and wakes the worker
// when due. Browsers may enforce a minimum alarm delay (Chrome's is 30s), so
// a short setting can take longer than requested.
const ALARM_PREFIX = "cookie-auto-clear:";

async function getGracePeriodSeconds() {
  const result = await browser.storage.local.get(STORAGE_KEYS.GRACE_PERIOD_SECONDS);
  const value = result[STORAGE_KEYS.GRACE_PERIOD_SECONDS];
  return typeof value === "number" && value >= 0 ? value : DEFAULT_GRACE_PERIOD_SECONDS;
}

function alarmNameForDomain(domain) {
  return ALARM_PREFIX + domain;
}

function domainFromAlarmName(name) {
  return name.startsWith(ALARM_PREFIX) ? name.slice(ALARM_PREFIX.length) : null;
}

async function getPendingDomains() {
  const alarms = await browser.alarms.getAll();
  return new Set(alarms.map((a) => domainFromAlarmName(a.name)).filter(Boolean));
}

async function cancelPendingClear(domain) {
  const cancelled = await browser.alarms.clear(alarmNameForDomain(domain));
  if (cancelled) {
    console.log(`cookie-auto-clear: ${domain} reopened, cancelled its pending clear`);
  }
}

async function updateBadge() {
  const enabled = await isEnabled();
  await browser.action.setBadgeText({ text: enabled ? "" : "OFF" });
  await browser.action.setBadgeBackgroundColor({
    color: enabled ? "#2e7d32" : "#b71c1c",
  });
}

// Rebuilds the tabId -> registrable-domain map from every currently open
// tab. Runs on browser startup and on install/update, since the in-memory
// state of a prior service worker instance does not survive either event.
function resyncAllTabs() {
  return withTabDomains(async (map) => {
    const tabs = await browser.tabs.query({});
    for (const key of Object.keys(map)) delete map[key];
    for (const tab of tabs) {
      const domain = domainFromUrl(tab.url);
      if (domain) map[tab.id] = domain;
    }
  });
}

// Per spec, cookies.remove() resolves with the removed cookie's details, or
// null/undefined if nothing matched - it does NOT throw in that case, so a
// naive "it didn't throw" check would silently count a no-op as a success.
async function removeCookie(cookie) {
  const url =
    (cookie.secure ? "https://" : "http://") +
    cookie.domain.replace(/^\./, "") +
    cookie.path;
  try {
    const result = await browser.cookies.remove({
      url,
      name: cookie.name,
      storeId: cookie.storeId,
    });
    if (result) return true;
    console.error(`cookie-auto-clear: remove() found no match for "${cookie.name}" at ${url}`);
    return false;
  } catch (err) {
    console.error("cookie-auto-clear: failed to remove cookie", cookie.name, err);
    return false;
  }
}

function cookieDomain(cookie) {
  return getRegistrableDomain(cookie.domain.replace(/^\./, ""));
}

// Core cleanup, modelled on Cookie AutoDelete: walks every cookie in every
// store and removes those whose registrable domain passes `shouldClear`.
// Returns per-domain counts and logs one entry per cleared domain.
async function clearCookiesWhere(shouldClear) {
  const stores = await browser.cookies.getAllCookieStores();
  const counts = new Map();
  let skipped = 0;
  for (const store of stores) {
    const cookies = await browser.cookies.getAll({ storeId: store.id });
    for (const cookie of cookies) {
      const domain = cookieDomain(cookie);
      if (!domain || !shouldClear(domain)) {
        skipped++;
        continue;
      }
      if (await removeCookie(cookie)) {
        counts.set(domain, (counts.get(domain) || 0) + 1);
      }
    }
  }
  await appendLogEntries([...counts].map(([domain, count]) => ({ domain, count })));
  let removed = 0;
  for (const count of counts.values()) removed += count;
  return { removed, domains: counts.size, skipped };
}

// Automatic sweep: clears cookies for every domain that has no open tab, is
// not whitelisted, and is not still inside its own grace period. This also
// catches cookies set by embedded third parties (trackers, CDNs) and sites a
// tab merely navigated away from - neither of which ever "closes" a tab of
// its own. `map` must be a current tabDomains snapshot; callers already
// inside withTabDomains pass theirs, others go through sweepOrphans().
async function sweepOrphansWithMap(map) {
  if (!(await isEnabled())) {
    console.log("cookie-auto-clear: extension is disabled, skipping sweep");
    return null;
  }
  const open = new Set(Object.values(map));
  const whitelist = new Set(await getWhitelist());
  const pending = await getPendingDomains();
  const result = await clearCookiesWhere(
    (domain) => !open.has(domain) && !whitelist.has(domain) && !pending.has(domain)
  );
  console.log(
    `cookie-auto-clear: sweep removed ${result.removed} cookie(s) across ${result.domains} domain(s)`
  );
  return result;
}

function sweepOrphans() {
  let result = null;
  return withTabDomains(async (map) => {
    result = await sweepOrphansWithMap(map);
  }).then(() => result);
}

// Called when `domain` may have just lost its last tab (tab closed, or - with
// cleanOnDomainChange on - navigated away). Starts its grace period; the
// sweep that runs when the alarm fires re-checks everything fresh, since the
// whitelist, enabled state, or tab set can change during the wait.
async function onDomainMaybeOrphaned(domain, map) {
  if (Object.values(map).includes(domain)) return;
  if (!(await isEnabled())) return;
  if ((await getWhitelist()).includes(domain)) return;
  const graceSeconds = await getGracePeriodSeconds();
  if (graceSeconds <= 0) {
    console.log(`cookie-auto-clear: ${domain} has no open tabs, sweeping now (grace period is off)`);
    await sweepOrphansWithMap(map);
    return;
  }
  browser.alarms.create(alarmNameForDomain(domain), {
    delayInMinutes: graceSeconds / 60,
  });
  console.log(`cookie-auto-clear: ${domain} has no open tabs, sweeping in ${graceSeconds}s unless reopened`);
}

// Manual, immediate, browser-wide clear: removes every cookie except those
// belonging to a whitelisted domain, regardless of open tabs. Intentionally
// ignores tab state and the enabled toggle - it's a deliberate one-shot
// action the user triggered.
async function clearAllExceptWhitelist() {
  const whitelist = new Set(await getWhitelist());
  return clearCookiesWhere((domain) => !whitelist.has(domain));
}

// Manual "clear this site now" from the popup: ignores the whitelist, open
// tabs and the toggle, since the user is explicitly asking for it.
async function clearSiteNow(domain) {
  await browser.alarms.clear(alarmNameForDomain(domain));
  return clearCookiesWhere((d) => d === domain);
}

browser.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === "clear-all-except-whitelist") {
    return clearAllExceptWhitelist();
  }
  if (message.type === "clear-site" && typeof message.domain === "string") {
    return clearSiteNow(message.domain);
  }
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  const domain = domainFromAlarmName(alarm.name);
  if (!domain) return;
  console.log(`cookie-auto-clear: grace period over for ${domain}, sweeping`);
  await sweepOrphans();
});

// On startup, sites whose tabs were still open when Safari quit never got a
// close event, so sweep once the tab map has been rebuilt. Tabs restored
// from the previous session are protected as usual.
browser.runtime.onStartup.addListener(async () => {
  await resyncAllTabs();
  await updateBadge();
  await sweepOrphans();
});

browser.runtime.onInstalled.addListener(async () => {
  await resyncAllTabs();
  await updateBadge();
  // Menu items persist across extension updates, so recreating one with the
  // same id would fail with a duplicate-id error without this.
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: "add-to-whitelist",
    title: "Add this domain to Cookie Auto-Clear whitelist",
    contexts: ["page", "link"],
  });
});

browser.tabs.onCreated.addListener((tab) => {
  const domain = domainFromUrl(tab.url);
  if (!domain) return;
  withTabDomains((map) => {
    map[tab.id] = domain;
  });
  cancelPendingClear(domain);
});

// Keeps the map in sync with each tab's current domain. By default a
// navigation does not start a grace period for the domain left behind - an
// OAuth/SSO/payment redirect hops a tab through another domain and back, and
// clearing mid-flow could wipe the session it just issued. That domain is
// still cleaned by the next sweep once nothing has it open. The opt-in
// cleanOnDomainChange setting (Cookie AutoDelete's equivalent is off by
// default too) starts the grace period right away instead.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const newDomain = domainFromUrl(changeInfo.url);
  withTabDomains(async (map) => {
    const oldDomain = map[tabId];
    if (newDomain) {
      map[tabId] = newDomain;
    } else {
      delete map[tabId];
    }
    if (oldDomain && oldDomain !== newDomain && (await isCleanOnDomainChangeEnabled())) {
      console.log(`cookie-auto-clear: tab ${tabId} left ${oldDomain} for ${newDomain || "a non-web page"}`);
      await onDomainMaybeOrphaned(oldDomain, map);
    }
  });
  if (newDomain) cancelPendingClear(newDomain);
});

browser.tabs.onRemoved.addListener((tabId) => {
  withTabDomains(async (map) => {
    const domain = map[tabId];
    if (!domain) return;
    console.log(`cookie-auto-clear: tab closed for ${domain} (tabId ${tabId})`);
    delete map[tabId];
    await onDomainMaybeOrphaned(domain, map);
  });
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "add-to-whitelist") return;
  const domain = domainFromUrl(info.linkUrl || info.pageUrl || tab?.url);
  if (!domain) return;
  const whitelist = await getWhitelist();
  if (!whitelist.includes(domain)) {
    whitelist.push(domain);
    await browser.storage.local.set({ [STORAGE_KEYS.WHITELIST]: whitelist });
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const enabledChange = changes[STORAGE_KEYS.ENABLED];
  if (!enabledChange) return;
  updateBadge();
  // Turning the extension back on catches up on sites closed while it was
  // off - otherwise they'd keep their cookies until some later sweep.
  if (enabledChange.newValue === true && enabledChange.oldValue === false) {
    sweepOrphans();
  }
});

updateBadge();
