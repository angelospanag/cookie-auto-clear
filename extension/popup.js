if (typeof browser === "undefined") {
  var browser = chrome;
}

const STORAGE_KEYS = {
  WHITELIST: "whitelist",
  LOG: "deletionLog",
  ENABLED: "enabled",
  GRACE_PERIOD_SECONDS: "gracePeriodSeconds",
  THEME: "theme",
  TOTAL_CLEARED: "totalCleared",
  CLEAN_ON_DOMAIN_CHANGE: "cleanOnDomainChange",
};

// Must match ALARM_PREFIX in background.js.
const ALARM_PREFIX = "cookie-auto-clear:";

const DEFAULT_GRACE_PERIOD_SECONDS = 30;
const DEFAULT_THEME = "light";

// Identical to the copy in background.js - keep both in sync.
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

// Accepts a bare domain ("example.com") or a full URL/host with a scheme,
// path, port, etc, and normalizes either to a registrable domain.
function normalizeDomainInput(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  try {
    const hostname = new URL(candidate).hostname;
    return getRegistrableDomain(hostname);
  } catch {
    return null;
  }
}

// Same http(s)-only restriction as background.js's domainFromUrl - a tab on
// a chrome://, about:, or extension page has no cookie-bearing domain to add.
function domainFromTabUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return getRegistrableDomain(parsed.hostname);
  } catch {
    return null;
  }
}

const whitelistEl = document.getElementById("whitelist");
const emptyWhitelistEl = document.getElementById("empty-whitelist");
const logEl = document.getElementById("log");
const emptyLogEl = document.getElementById("empty-log");
const addForm = document.getElementById("add-form");
const domainInput = document.getElementById("domain-input");
const enabledToggle = document.getElementById("enabled-toggle");
const currentSiteDomainEl = document.getElementById("current-site-domain");
const addCurrentSiteBtn = document.getElementById("add-current-site");
const gracePeriodSelect = document.getElementById("grace-period-select");
const themeSelect = document.getElementById("theme-select");
const clearLogBtn = document.getElementById("clear-log");
const clearAllBtn = document.getElementById("clear-all-btn");
const clearAllResultEl = document.getElementById("clear-all-result");
const totalClearedEl = document.getElementById("total-cleared");
const currentSiteCookiesEl = document.getElementById("current-site-cookies");
const clearCurrentSiteBtn = document.getElementById("clear-current-site");
const currentSiteWhitelistedEl = document.getElementById("current-site-whitelisted");
const removeCurrentSiteBtn = document.getElementById("remove-current-site");
const whitelistFilter = document.getElementById("whitelist-filter");
const domainChangeToggle = document.getElementById("domain-change-toggle");
const pendingEl = document.getElementById("pending");
const emptyPendingEl = document.getElementById("empty-pending");
const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

let currentTabDomain = null;
let currentWhitelist = [];
let currentLog = [];
const CLEAR_ALL_DEFAULT_LABEL = "Clear all except whitelisted";

function activateTab(name) {
  for (const btn of tabButtons) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === name));
  }
  for (const panel of tabPanels) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
}

async function getWhitelist() {
  const result = await browser.storage.local.get(STORAGE_KEYS.WHITELIST);
  return result[STORAGE_KEYS.WHITELIST] || [];
}

async function saveWhitelist(list) {
  await browser.storage.local.set({ [STORAGE_KEYS.WHITELIST]: list });
}

// Serializes whitelist read-modify-write cycles triggered from this popup
// (add form submit, remove-button clicks) so that firing two of them close
// together - e.g. clicking Remove on two entries in quick succession - can't
// race and silently undo one of them. Does not protect against a whitelist
// edit made concurrently from the background script's context-menu handler,
// since that runs in a separate JS context with its own call stack; that
// cross-context collision is accepted as a rare, low-stakes gap.
let whitelistQueue = Promise.resolve();
function withWhitelist(mutator) {
  const run = whitelistQueue.then(async () => {
    const list = await getWhitelist();
    try {
      await mutator(list);
    } catch (err) {
      console.error("cookie-auto-clear popup: whitelist mutation failed", err);
    }
    await saveWhitelist(list);
    renderWhitelist(list);
  });
  whitelistQueue = run.catch((err) => {
    console.error("cookie-auto-clear popup: whitelist queue failed", err);
  });
  return run;
}

function renderWhitelist(list) {
  currentWhitelist = list;
  whitelistEl.innerHTML = "";
  emptyWhitelistEl.style.display = list.length ? "none" : "block";
  whitelistFilter.hidden = list.length < 5;
  const query = whitelistFilter.hidden ? "" : whitelistFilter.value.trim().toLowerCase();
  const shown = query ? list.filter((d) => d.includes(query)) : list;
  for (const domain of shown) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = domain;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.className = "remove-btn";
    removeBtn.addEventListener("click", () => {
      withWhitelist((current) => {
        const idx = current.indexOf(domain);
        if (idx !== -1) current.splice(idx, 1);
      });
    });
    li.appendChild(span);
    li.appendChild(removeBtn);
    whitelistEl.appendChild(li);
  }
}

function formatTimestamp(ts) {
  const date = new Date(ts);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Log entries for the manual clear-all used to be stored under a sentence
// rather than a domain; those can't be whitelisted.
function isDomainLike(value) {
  return typeof value === "string" && /^[a-z0-9.:\[\]-]+$/i.test(value);
}

function renderLog(entries) {
  currentLog = entries;
  logEl.innerHTML = "";
  emptyLogEl.style.display = entries.length ? "none" : "block";
  clearLogBtn.disabled = entries.length === 0;
  for (const entry of entries.slice(0, 10)) {
    const li = document.createElement("li");
    li.className = "log-entry";
    const domainEl = document.createElement("span");
    domainEl.className = "log-domain";
    domainEl.textContent = entry.domain;
    const metaEl = document.createElement("span");
    metaEl.className = "log-meta";
    const count = entry.count === 1 ? "1 cookie" : `${entry.count} cookies`;
    metaEl.textContent = `${count} cleared · ${formatTimestamp(entry.timestamp)}`;
    const textEl = document.createElement("div");
    textEl.className = "log-text";
    textEl.appendChild(domainEl);
    textEl.appendChild(metaEl);
    li.appendChild(textEl);
    if (isDomainLike(entry.domain) && !currentWhitelist.includes(entry.domain)) {
      const keepBtn = document.createElement("button");
      keepBtn.type = "button";
      keepBtn.className = "link-btn";
      keepBtn.textContent = "Keep";
      keepBtn.title = `Add ${entry.domain} to the whitelist`;
      keepBtn.addEventListener("click", () => {
        withWhitelist((list) => {
          if (!list.includes(entry.domain)) list.push(entry.domain);
        });
      });
      li.appendChild(keepBtn);
    }
    logEl.appendChild(li);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

function renderTotalCleared(total) {
  totalClearedEl.textContent = (total || 0).toLocaleString();
}

async function loadAll() {
  const [whitelist, storedLog, storedEnabled, storedGracePeriod, storedTheme, storedTotal, storedDomainChange] =
    await Promise.all([
      getWhitelist(),
      browser.storage.local.get(STORAGE_KEYS.LOG),
      browser.storage.local.get(STORAGE_KEYS.ENABLED),
      browser.storage.local.get(STORAGE_KEYS.GRACE_PERIOD_SECONDS),
      browser.storage.local.get(STORAGE_KEYS.THEME),
      browser.storage.local.get(STORAGE_KEYS.TOTAL_CLEARED),
      browser.storage.local.get(STORAGE_KEYS.CLEAN_ON_DOMAIN_CHANGE),
    ]);
  renderWhitelist(whitelist);
  renderLog(storedLog[STORAGE_KEYS.LOG] || []);
  enabledToggle.checked = storedEnabled[STORAGE_KEYS.ENABLED] !== false;
  const graceValue = storedGracePeriod[STORAGE_KEYS.GRACE_PERIOD_SECONDS];
  gracePeriodSelect.value = String(
    typeof graceValue === "number" ? graceValue : DEFAULT_GRACE_PERIOD_SECONDS
  );
  const theme = storedTheme[STORAGE_KEYS.THEME] || DEFAULT_THEME;
  themeSelect.value = theme;
  applyTheme(theme);
  renderTotalCleared(storedTotal[STORAGE_KEYS.TOTAL_CLEARED]);
  domainChangeToggle.checked = storedDomainChange[STORAGE_KEYS.CLEAN_ON_DOMAIN_CHANGE] === true;
}

function cookieDomain(cookie) {
  return getRegistrableDomain(cookie.domain.replace(/^\./, ""));
}

async function countCookiesForDomain(domain) {
  const stores = await browser.cookies.getAllCookieStores();
  let count = 0;
  for (const store of stores) {
    const cookies = await browser.cookies.getAll({ domain, storeId: store.id });
    count += cookies.filter((c) => cookieDomain(c) === domain).length;
  }
  return count;
}

async function renderCurrentSiteCookies() {
  if (!currentTabDomain) {
    currentSiteCookiesEl.textContent = "";
    clearCurrentSiteBtn.disabled = true;
    return;
  }
  try {
    const count = await countCookiesForDomain(currentTabDomain);
    currentSiteCookiesEl.textContent = count === 1 ? "1 cookie" : `${count} cookies`;
    clearCurrentSiteBtn.disabled = count === 0;
  } catch (err) {
    console.error("cookie-auto-clear popup: cookie count failed", err);
    currentSiteCookiesEl.textContent = "";
    clearCurrentSiteBtn.disabled = false;
  }
}

function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

async function renderPending() {
  const alarms = (await browser.alarms.getAll())
    .filter((a) => a.name.startsWith(ALARM_PREFIX))
    .sort((a, b) => a.scheduledTime - b.scheduledTime);
  pendingEl.innerHTML = "";
  emptyPendingEl.style.display = alarms.length ? "none" : "block";
  for (const alarm of alarms) {
    const domain = alarm.name.slice(ALARM_PREFIX.length);
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = domain;
    const right = document.createElement("span");
    right.className = "pending-right";
    const time = document.createElement("span");
    time.className = "log-meta";
    time.textContent = `in ${formatRemaining(alarm.scheduledTime - Date.now())}`;
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "link-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.title = `Keep ${domain}'s cookies this time`;
    cancelBtn.addEventListener("click", async () => {
      await browser.alarms.clear(alarm.name);
      renderPending();
    });
    right.appendChild(time);
    right.appendChild(cancelBtn);
    li.appendChild(label);
    li.appendChild(right);
    pendingEl.appendChild(li);
  }
}

// A whitelisted site shows a plain status label (plus a Remove link) rather
// than a disabled button, which still looked clickable.
function updateCurrentSiteButton(whitelist) {
  if (!currentTabDomain) return;
  const already = whitelist.includes(currentTabDomain);
  addCurrentSiteBtn.hidden = already;
  currentSiteWhitelistedEl.hidden = !already;
}

async function loadCurrentTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabDomain = domainFromTabUrl(tab && tab.url);
  if (!currentTabDomain) {
    currentSiteDomainEl.textContent = "No site on this tab";
    addCurrentSiteBtn.disabled = true;
    addCurrentSiteBtn.textContent = "Add to whitelist";
    renderCurrentSiteCookies();
    return;
  }
  currentSiteDomainEl.textContent = currentTabDomain;
  updateCurrentSiteButton(await getWhitelist());
  renderCurrentSiteCookies();
}

addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const domain = normalizeDomainInput(domainInput.value);
  if (!domain) return;
  domainInput.value = "";
  withWhitelist((list) => {
    if (!list.includes(domain)) list.push(domain);
  });
});

enabledToggle.addEventListener("change", async () => {
  await browser.storage.local.set({
    [STORAGE_KEYS.ENABLED]: enabledToggle.checked,
  });
});

gracePeriodSelect.addEventListener("change", async () => {
  await browser.storage.local.set({
    [STORAGE_KEYS.GRACE_PERIOD_SECONDS]: Number(gracePeriodSelect.value),
  });
});

domainChangeToggle.addEventListener("change", async () => {
  await browser.storage.local.set({
    [STORAGE_KEYS.CLEAN_ON_DOMAIN_CHANGE]: domainChangeToggle.checked,
  });
});

whitelistFilter.addEventListener("input", () => renderWhitelist(currentWhitelist));

// Same two-click confirm as the clear-all button: clearing the site you're
// on usually logs you out of it.
let clearSiteArmed = false;
let clearSiteArmTimeout = null;

clearCurrentSiteBtn.addEventListener("click", async () => {
  if (!currentTabDomain) return;
  if (!clearSiteArmed) {
    clearSiteArmed = true;
    clearCurrentSiteBtn.textContent = "Confirm";
    clearSiteArmTimeout = setTimeout(() => {
      clearSiteArmed = false;
      clearCurrentSiteBtn.textContent = "Clear now";
    }, 4000);
    return;
  }
  clearTimeout(clearSiteArmTimeout);
  clearSiteArmed = false;
  clearCurrentSiteBtn.disabled = true;
  clearCurrentSiteBtn.textContent = "Clearing…";
  try {
    await browser.runtime.sendMessage({ type: "clear-site", domain: currentTabDomain });
  } catch (err) {
    console.error("cookie-auto-clear popup: clear-site failed", err);
  }
  clearCurrentSiteBtn.textContent = "Clear now";
  renderCurrentSiteCookies();
});

themeSelect.addEventListener("change", async () => {
  applyTheme(themeSelect.value);
  await browser.storage.local.set({ [STORAGE_KEYS.THEME]: themeSelect.value });
});

removeCurrentSiteBtn.addEventListener("click", () => {
  if (!currentTabDomain) return;
  withWhitelist((list) => {
    const idx = list.indexOf(currentTabDomain);
    if (idx !== -1) list.splice(idx, 1);
  });
});

addCurrentSiteBtn.addEventListener("click", () => {
  if (!currentTabDomain) return;
  withWhitelist((list) => {
    if (!list.includes(currentTabDomain)) list.push(currentTabDomain);
  });
});

clearLogBtn.addEventListener("click", async () => {
  await browser.storage.local.set({ [STORAGE_KEYS.LOG]: [] });
  renderLog([]);
});

// Two-click confirm rather than a native confirm() dialog, which looks
// awkward in a small extension popup: first click arms it and flips the
// label for a few seconds, second click (while armed) actually runs it.
let clearAllArmed = false;
let clearAllArmTimeout = null;

function disarmClearAll() {
  clearAllArmed = false;
  clearAllBtn.textContent = CLEAR_ALL_DEFAULT_LABEL;
}

clearAllBtn.addEventListener("click", async () => {
  if (!clearAllArmed) {
    clearAllArmed = true;
    clearAllBtn.textContent = "Click again to confirm";
    clearAllResultEl.textContent = "";
    clearAllArmTimeout = setTimeout(disarmClearAll, 4000);
    return;
  }
  clearTimeout(clearAllArmTimeout);
  clearAllArmed = false;
  clearAllBtn.disabled = true;
  clearAllBtn.textContent = "Clearing…";
  try {
    const result = await browser.runtime.sendMessage({ type: "clear-all-except-whitelist" });
    clearAllResultEl.textContent = `Cleared ${result.removed} cookie(s) across ${result.domains} domain(s). Skipped ${result.skipped} whitelisted cookie(s).`;
  } catch (err) {
    console.error("cookie-auto-clear popup: clear-all failed", err);
    clearAllResultEl.textContent = "Something went wrong - check the background console.";
  }
  clearAllBtn.disabled = false;
  clearAllBtn.textContent = CLEAR_ALL_DEFAULT_LABEL;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEYS.WHITELIST]) {
    const newList = changes[STORAGE_KEYS.WHITELIST].newValue || [];
    renderWhitelist(newList);
    updateCurrentSiteButton(newList);
    renderLog(currentLog);
  }
  if (changes[STORAGE_KEYS.LOG]) {
    renderLog(changes[STORAGE_KEYS.LOG].newValue || []);
  }
  if (changes[STORAGE_KEYS.TOTAL_CLEARED]) {
    renderTotalCleared(changes[STORAGE_KEYS.TOTAL_CLEARED].newValue);
  }
});

activateTab("whitelist");
loadAll();
loadCurrentTab();
renderPending();
// The popup is only alive while open, so a 1s poll is cheap and keeps the
// countdowns ticking (alarms has no change event to listen to).
setInterval(renderPending, 1000);
