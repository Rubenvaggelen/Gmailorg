/* ============================================================
   Gmail Org — multi-account Gmail + Calendar control tower
   Alles draait client-side: geen eigen server, geen wachtwoorden
   opgeslagen. Tokens leven alleen in het geheugen van de sessie.
   ============================================================ */

// Ruim bij het sluiten van de pagina alle cache en de service worker op,
// zodat de volgende keer altijd de nieuwste versie wordt opgehaald —
// nooit meer handmatig "sitegegevens wissen" nodig.
function clearAppCacheAndServiceWorker() {
  if ("caches" in window) {
    caches.keys().then(keys => keys.forEach(key => caches.delete(key)));
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(reg => reg.unregister()));
  }
}
window.addEventListener("pagehide", clearAppCacheAndServiceWorker);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") clearAppCacheAndServiceWorker();
});


const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/userinfo.email"
].join(" ");

const DEFAULT_SETTINGS = {
  pollIntervalMinutes: 2,
  fetchCount: 20,
  categorize: true,
  swipeRight: "archive",
  swipeLeft: "trash",
  notifications: false,
  autoWebshop: true
};

const COLORS = ["#E0A458", "#6FA287", "#7B93D6", "#C97B7B", "#9C7BC9", "#6FB8B0"];
const CATEGORY_LABELS = { personal: "Persoonlijk", newsletter: "Nieuwsbrieven", notification: "Meldingen", webshop: "Webshops" };
const FOLDERS = { INBOX: "Postvak IN", SENT: "Verzonden", DRAFT: "Concepten", TRASH: "Prullenbak" };
const MS_FOLDER_MAP = { INBOX: "inbox", ARCHIVE: "archive", SENT: "sentitems", DRAFT: "drafts", TRASH: "deleteditems" };
const MS_SCOPES = ["Mail.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite", "User.Read"];
const RANGE_LABELS = { today: "Vandaag", week: "Deze week", month: "Deze maand" };
const ACTION_LABELS = { archive: "Archiveren", trash: "Verwijderen", snooze1h: "Snoozen" };
const WEBSHOP_LABEL_NAME = "Webshops";

// Brede, maar per definitie onvolledige lijst van bekende webshop-domeinen
// (vooral NL/BE + grote internationale spelers). Wordt aangevuld met
// patroonherkenning hieronder voor shops die er niet bij staan.
const WEBSHOP_DOMAINS = [
  "bol.com", "coolblue.nl", "coolblue.be", "wehkamp.nl", "zalando.nl", "zalando.be", "zalando.com",
  "amazon.nl", "amazon.de", "amazon.com", "amazon.co.uk", "aliexpress.com", "ikea.com",
  "mediamarkt.nl", "mediamarkt.be", "hema.nl", "hema.be", "decathlon.nl", "decathlon.be",
  "action.com", "etsy.com", "ebay.com", "ebay.nl", "asos.com", "zara.com", "hm.com",
  "nike.com", "adidas.com", "adidas.nl", "vinted.com", "vinted.nl", "marktplaats.nl",
  "temu.com", "shein.com", "wish.com", "kruidvat.nl", "gamma.nl", "gamma.be", "praxis.nl",
  "blokker.nl", "jumbo.com", "ah.nl", "bcc.nl", "expert.nl", "otto.de", "conrad.nl",
  "bever.nl", "intersport.nl", "jdsports.nl", "footlocker.nl", "vanharen.nl", "bristol.eu",
  "only.com", "veepee.nl", "showroomprive.nl", "cdiscount.com", "fnac.com", "booking.com",
  "shopify.com", "xenos.nl", "trendhim.nl", "douglas.nl", "rituals.com", "sportdirect.com",
  "bijenkorf.nl", "debijenkorf.nl", "perrysport.nl", "scapino.nl", "wibra.nl", "zeeman.com",
  "c-a.com", "primark.com", "uniqlo.com", "boohoo.com", "prenatal.nl", "babypark.nl",
  "kiabi.nl", "costway.nl", "vidaxl.nl", "beslist.nl", "coolshop.nl", "alternate.nl",
  "azerty.nl", "centralpoint.nl"
];

function webshopDomainFromEmail(from) {
  const match = from.match(/@([\w.-]+)/);
  return match ? match[1].toLowerCase() : "";
}

function isKnownWebshopDomain(from) {
  const domain = webshopDomainFromEmail(from);
  return WEBSHOP_DOMAINS.some(d => domain === d || domain.endsWith("." + d));
}

function looksLikeWebshopMail(message) {
  if (isKnownWebshopDomain(message.from)) return true;
  // Voor shops die niet in de lijst staan: bestel-/verzendtaal in het
  // onderwerp, gecombineerd met een uitschrijflink (commerciële afzender).
  const text = message.subject.toLowerCase();
  const pattern = /\b(bestelling|bestelbevestiging|orderbevestiging|verzonden|track.?trace|pakket|factuur|levering|retourneren|winkelwagen|aanbieding|korting(?:scode)?)\b/;
  return message.hasListUnsubscribe && pattern.test(text);
}


const state = {
  clientId: "1057161054676-mg300mfsuca24ju7l84muia382nc84t6.apps.googleusercontent.com",
  msClientId: localStorage.getItem("postbus:msClientId") || "",
  nsApiKey: localStorage.getItem("postbus:nsApiKey") || "",
  fixedOrigin: localStorage.getItem("postbus:fixedOrigin") || "",
  addressAliases: JSON.parse(localStorage.getItem("postbus:addressAliases") || "null") || {
    "c.a snackcident": "Vianenstraat 31",
    "huis": "Olle Kapoenstraat 2",
    "werk": "Amsterdam Station Zuid"
  },
  accounts: JSON.parse(localStorage.getItem("postbus:accounts") || "[]"),
  rules: JSON.parse(localStorage.getItem("postbus:rules") || "[]"),
  settings: { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("postbus:settings") || "{}") },
  snoozed: JSON.parse(localStorage.getItem("postbus:snoozed") || "{}"),
  seenIds: new Set(JSON.parse(localStorage.getItem("postbus:seenIds") || "[]")),
  messages: [],
  events: [],
  activeAccountFilter: null,
  activeCategoryFilter: null,
  activeCalendarAccountFilter: null,
  activeRange: "week",
  calendarSubView: "agenda",
  activeFolder: "INBOX",
  searchQuery: "",
  activeView: "inbox",
  selectionMode: false,
  selectedIds: new Set(),
  webshopLabelIds: {}, // { accountEmail: gmailLabelId } — cache zodat we niet elke keer opnieuw hoeven te zoeken/aan te maken
  pollHandle: null
};

function persistAccounts() {
  localStorage.setItem("postbus:accounts", JSON.stringify(
    state.accounts.map(a => ({
      email: a.email, color: a.color, token: a.token, tokenExpiry: a.tokenExpiry,
      provider: a.provider || "google"
    }))
  ));
}
function persistRules() { localStorage.setItem("postbus:rules", JSON.stringify(state.rules)); }
function persistSettings() { localStorage.setItem("postbus:settings", JSON.stringify(state.settings)); }
function persistSnoozed() { localStorage.setItem("postbus:snoozed", JSON.stringify(state.snoozed)); }
function persistSeenIds() { localStorage.setItem("postbus:seenIds", JSON.stringify([...state.seenIds])); }

/* ---------------- Setup screen ---------------- */

function initSetup() {
  const setupScreen = document.getElementById("setup-screen");
  const appScreen = document.getElementById("app");

  if (state.clientId) {
    setupScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    boot();
    return;
  }

  document.getElementById("save-client-id").addEventListener("click", () => {
    const val = document.getElementById("client-id-input").value.trim();
    if (!val) return;
    state.clientId = val;
    localStorage.setItem("postbus:clientId", val);
    setupScreen.classList.add("hidden");
    appScreen.classList.remove("hidden");
    boot();
  });
}

/* ---------------- Boot ---------------- */

function boot() {
  // Token blijft geldig totdat hij écht verloopt (Google-tokens duren
  // doorgaans ~1 uur) — alleen dán moet opnieuw ingelogd worden, niet bij
  // elke herstart van de app.
  const now = Date.now();
  state.accounts = state.accounts.map(a => {
    const stillValid = a.token && a.tokenExpiry && a.tokenExpiry > now + 60000;
    return stillValid ? a : { ...a, token: null };
  });

  // Voor elk account: plan een stille ververs-poging vlak vóór het token
  // verloopt, of probeer er meteen één als het token al verlopen is.
  // (Voor Microsoft-accounts gebeurt dit los, via de "Opnieuw verbinden"-knop —
  // MSAL's eigen stille verversing vereist een net iets ander patroon.)
  state.accounts.forEach(a => {
    if (a.provider === "microsoft") return;
    if (a.token) scheduleSilentRefresh(a);
    else silentRefreshAccount(a.email);
  });

  renderAccounts();
  renderChips();
  renderFolderChips();
  renderCategoryChips();
  renderCalendarAccountChips();
  renderRangeChips();
  renderCalendarSubtabs();
  renderRules();
  updateSubline();

  wireNav();
  wireSearch();
  wireSelectionMode();
  wireRuleModal();
  wireDetailModal();
  wireComposeModal();
  wireEventModal();
  wireSettings();
  wireRestaurants();
  wireRoutePage();

  document.getElementById("add-account-btn").addEventListener("click", startAddAccount);
  document.getElementById("add-account-btn-2").addEventListener("click", startAddAccount);
  document.getElementById("add-microsoft-btn").addEventListener("click", startAddMicrosoftAccount);
  document.getElementById("compose-btn").addEventListener("click", openCompose);
  document.getElementById("add-event-btn").addEventListener("click", () => openEventModal("create"));

  startPolling();
}

function updateSubline() {
  const n = state.accounts.length;
  document.getElementById("tower-subline").textContent =
    n === 0 ? "0 accounts verbonden" : `${n} account${n > 1 ? "s" : ""} verbonden`;
}

/* ---------------- Google OAuth ---------------- */

function startAddAccount() {
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    alert("Google-inlogscript is nog niet geladen. Probeer het over een paar seconden opnieuw.");
    return;
  }
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.clientId,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error) { alert("Inloggen mislukt: " + resp.error); return; }
      const profile = await fetchProfile(resp.access_token);
      addOrUpdateAccount(profile.email, resp.access_token, resp.expires_in);
    }
  });
  tokenClient.requestAccessToken({ prompt: "select_account" });
}

async function fetchProfile(token) {
  const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.json();
}

function addOrUpdateAccount(email, token, expiresIn, provider = "google") {
  const existing = state.accounts.find(a => a.email === email);
  const tokenExpiry = Date.now() + expiresIn * 1000;
  let account;
  if (existing) {
    existing.token = token;
    existing.tokenExpiry = tokenExpiry;
    existing.provider = provider;
    account = existing;
  } else {
    account = { email, color: COLORS[state.accounts.length % COLORS.length], token, tokenExpiry, provider };
    state.accounts.push(account);
  }
  persistAccounts();
  if (provider === "google") scheduleSilentRefresh(account);
  renderAccounts();
  renderChips();
  renderCalendarAccountChips();
  updateSubline();
  refreshInbox();
  refreshCalendar();
}

/* ---------------- Microsoft (Hotmail/Outlook) OAuth via MSAL ---------------- */

let msalInstance = null;

function getMsalInstance() {
  if (msalInstance) return msalInstance;
  if (!window.msal || !state.msClientId) return null;
  msalInstance = new msal.PublicClientApplication({
    auth: {
      clientId: state.msClientId,
      authority: "https://login.microsoftonline.com/common",
      redirectUri: window.location.origin + window.location.pathname
    }
  });
  return msalInstance;
}

async function startAddMicrosoftAccount() {
  if (!state.msClientId) {
    alert("Vul eerst je Microsoft Client ID in bij Instellingen voordat je een Hotmail-account kunt toevoegen.");
    return;
  }
  const app = getMsalInstance();
  if (!app) {
    alert("Microsoft-inlogscript is nog niet geladen. Probeer het over een paar seconden opnieuw.");
    return;
  }
  try {
    const result = await app.loginPopup({ scopes: MS_SCOPES });
    const expiresIn = Math.max(1, Math.round((result.expiresOn.getTime() - Date.now()) / 1000));
    addOrUpdateAccount(result.account.username, result.accessToken, expiresIn, "microsoft");
  } catch (e) {
    alert("Inloggen bij Microsoft mislukt: " + (e.errorMessage || e.message || e));
  }
}

async function reconnectMicrosoftAccount(email) {
  const app = getMsalInstance();
  if (!app) { alert("Microsoft-inlogscript is nog niet geladen."); return; }
  try {
    const accounts = app.getAllAccounts().filter(a => a.username === email);
    let result;
    if (accounts.length > 0) {
      result = await app.acquireTokenSilent({ scopes: MS_SCOPES, account: accounts[0] })
        .catch(() => app.acquireTokenPopup({ scopes: MS_SCOPES, account: accounts[0] }));
    } else {
      result = await app.loginPopup({ scopes: MS_SCOPES, loginHint: email });
    }
    const expiresIn = Math.max(1, Math.round((result.expiresOn.getTime() - Date.now()) / 1000));
    addOrUpdateAccount(email, result.accessToken, expiresIn, "microsoft");
  } catch (e) {
    alert("Opnieuw verbinden mislukt: " + (e.errorMessage || e.message || e));
  }
}

/* ---------------- Stil verversen op de achtergrond ---------------- */

function scheduleSilentRefresh(account) {
  if (account.refreshTimer) clearTimeout(account.refreshTimer);
  if (!account.tokenExpiry) return;
  // 5 minuten vóór het verlopen proberen te verversen, met een ondergrens
  // zodat we niet meteen in een loop terechtkomen.
  const delay = Math.max(account.tokenExpiry - Date.now() - 5 * 60 * 1000, 10000);
  account.refreshTimer = setTimeout(() => silentRefreshAccount(account.email), delay);
}

function silentRefreshAccount(email, retriesLeft = 3) {
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    // Het Google-inlogscript (async geladen) is er soms nog niet meteen bij
    // het opstarten — een paar keer opnieuw proberen met een korte pauze.
    if (retriesLeft > 0) setTimeout(() => silentRefreshAccount(email, retriesLeft - 1), 1500);
    return;
  }
  try {
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: state.clientId,
      scope: SCOPES,
      hint: email,
      callback: (resp) => {
        if (resp.error) {
          console.warn("Stil verversen mislukt voor", email, resp.error);
          return; // gebruiker moet dan handmatig opnieuw verbinden via + Account
        }
        addOrUpdateAccount(email, resp.access_token, resp.expires_in);
      }
    });
    tokenClient.requestAccessToken({ prompt: "" });
  } catch (e) {
    console.warn("Stil verversen kon niet starten voor", email, e);
  }
}

function removeAccount(email) {
  state.accounts = state.accounts.filter(a => a.email !== email);
  state.messages = state.messages.filter(m => m.accountEmail !== email);
  state.events = state.events.filter(e => e.accountEmail !== email);
  persistAccounts();
  renderAccounts();
  renderChips();
  renderMessages();
  renderCalendarAccountChips();
  renderEvents();
  updateSubline();
}

/* ---------------- Gmail: fetch + merge ---------------- */

async function refreshInbox() {
  const connected = state.accounts.filter(a => a.token);
  if (connected.length === 0) { state.messages = []; renderMessages(); return; }

  const results = await Promise.all(connected.map(fetchAccountMessages));
  const merged = results.flat();

  if (state.settings.notifications) notifyNewMessages(merged);

  state.messages = merged.sort((a, b) => b.timestamp - a.timestamp);
  await applyRulesToNewMessages(state.messages);
  cleanupExpiredSnoozes();

  if (state.settings.autoWebshop && state.activeFolder === "INBOX") {
    await autoMoveWebshopMail(connected, merged);
  }

  renderMessages();

  merged.forEach(m => state.seenIds.add(m.id));
  persistSeenIds();
}

async function fetchAccountMessages(account) {
  if (account.provider === "microsoft") return fetchMicrosoftMessages(account);
  try {
    const count = state.settings.fetchCount;
    // Gmail heeft geen los "Archief"-label — gearchiveerd betekent simpelweg
    // "geen INBOX-label meer", dus dat vraag je op via een zoekopdracht.
    const listUrl = state.activeFolder === "ARCHIVE"
      ? `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}&q=${encodeURIComponent("-in:inbox -in:trash -in:sent -in:drafts -in:spam")}`
      : `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}&labelIds=${state.activeFolder}`;
    const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${account.token}` } });
    if (!listResp.ok) return [];
    const listData = await listResp.json();
    const ids = (listData.messages || []).map(m => m.id);

    const headerParams = ["From", "Subject", "List-Unsubscribe", "Message-ID", "Date"]
      .map(h => `metadataHeaders=${encodeURIComponent(h)}`).join("&");

    const details = await Promise.all(ids.map(id =>
      fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&${headerParams}`,
        { headers: { Authorization: `Bearer ${account.token}` } }
      ).then(r => r.ok ? r.json() : null)
    ));

    return details.filter(Boolean).map(d => {
      const headers = d.payload?.headers || [];
      const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
      const message = {
        id: d.id,
        threadId: d.threadId,
        accountEmail: account.email,
        accountColor: account.color,
        from: get("From") || "Onbekend",
        subject: get("Subject") || "(geen onderwerp)",
        snippet: d.snippet || "",
        timestamp: parseInt(d.internalDate || "0", 10),
        messageIdHeader: get("Message-ID"),
        hasListUnsubscribe: Boolean(get("List-Unsubscribe")),
        labelIds: d.labelIds || []
      };
      message.category = classifyMessage(message);
      return message;
    });
  } catch (e) {
    console.error("Fetch mislukt voor", account.email, e);
    return [];
  }
}

function mapMicrosoftMessage(d, account) {
  const fromAddr = d.from?.emailAddress?.address || "";
  const fromName = d.from?.emailAddress?.name || fromAddr;
  const headers = d.internetMessageHeaders || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
  const message = {
    id: d.id,
    threadId: d.conversationId,
    accountEmail: account.email,
    accountColor: account.color,
    from: fromName && fromAddr ? `${fromName} <${fromAddr}>` : (fromAddr || "Onbekend"),
    subject: d.subject || "(geen onderwerp)",
    snippet: d.bodyPreview || "",
    timestamp: new Date(d.receivedDateTime).getTime() || 0,
    messageIdHeader: d.internetMessageId || "",
    hasListUnsubscribe: Boolean(getHeader("List-Unsubscribe")),
    labelIds: []
  };
  message.category = classifyMessage(message);
  return message;
}

async function fetchAllMicrosoftMessages(account, { select, top = 100, maxPages = 20, extraParams = "" } = {}) {
  const results = [];
  let url = `https://graph.microsoft.com/v1.0/me/messages?$top=${top}&$select=${select}${extraParams}`;
  let pages = 0;
  while (url && pages < maxPages) {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${account.token}` } });
      if (!r.ok) break;
      const data = await r.json();
      results.push(...(data.value || []));
      url = data["@odata.nextLink"] || null;
      pages += 1;
    } catch (e) {
      console.error("Microsoft-berichten ophalen mislukt voor", account.email, e);
      break;
    }
  }
  return results;
}

async function moveMicrosoftMessagesBulk(account, ids, destinationId) {
  const chunkSize = 10; // gelijktijdige aanvragen, om de Graph API niet te overbelasten
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    await Promise.all(chunk.map(id => moveMicrosoftMessage(account, id, destinationId)));
  }
}

async function fetchMicrosoftMessages(account) {
  try {
    const count = state.settings.fetchCount;
    const folder = MS_FOLDER_MAP[state.activeFolder] || "inbox";
    const select = "subject,from,receivedDateTime,bodyPreview,conversationId,internetMessageId";
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=${count}&$select=${select}&$orderby=receivedDateTime desc`,
      { headers: { Authorization: `Bearer ${account.token}` } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return (data.value || []).map(d => mapMicrosoftMessage(d, account));
  } catch (e) {
    console.error("Fetch (Microsoft) mislukt voor", account.email, e);
    return [];
  }
}

/* ---------------- Webshopmail automatisch naar map verplaatsen ---------------- */

async function getOrCreateWebshopLabelId(account) {
  if (account.provider === "microsoft") return getOrCreateMicrosoftWebshopFolderId(account);
  if (state.webshopLabelIds[account.email]) return state.webshopLabelIds[account.email];
  try {
    const listResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      headers: { Authorization: `Bearer ${account.token}` }
    });
    const listData = await listResp.json();
    let label = (listData.labels || []).find(l => l.name === WEBSHOP_LABEL_NAME);

    if (!label) {
      const createResp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", {
        method: "POST",
        headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: WEBSHOP_LABEL_NAME,
          labelListVisibility: "labelShow",
          messageListVisibility: "show"
        })
      });
      if (!createResp.ok) return null;
      label = await createResp.json();
    }

    state.webshopLabelIds[account.email] = label.id;
    return label.id;
  } catch (e) {
    console.error("Kon Webshops-label niet ophalen/aanmaken voor", account.email, e);
    return null;
  }
}

async function getOrCreateMicrosoftWebshopFolderId(account) {
  const cacheKey = account.email + ":ms";
  if (state.webshopLabelIds[cacheKey]) return state.webshopLabelIds[cacheKey];
  try {
    const listResp = await fetch(
      `https://graph.microsoft.com/v1.0/me/mailFolders?$filter=${encodeURIComponent(`displayName eq '${WEBSHOP_LABEL_NAME}'`)}`,
      { headers: { Authorization: `Bearer ${account.token}` } }
    );
    const listData = await listResp.json();
    let folder = (listData.value || [])[0];

    if (!folder) {
      const createResp = await fetch("https://graph.microsoft.com/v1.0/me/mailFolders", {
        method: "POST",
        headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: WEBSHOP_LABEL_NAME })
      });
      if (!createResp.ok) return null;
      folder = await createResp.json();
    }

    state.webshopLabelIds[cacheKey] = folder.id;
    return folder.id;
  } catch (e) {
    console.error("Kon Webshops-map niet ophalen/aanmaken voor", account.email, e);
    return null;
  }
}

async function autoMoveWebshopMail(connectedAccounts, messages) {
  for (const account of connectedAccounts) {
    const cacheKey = account.provider === "microsoft" ? account.email + ":ms" : account.email;
    const labelId = state.webshopLabelIds[cacheKey] || await getOrCreateWebshopLabelId(account);
    if (!labelId) continue;

    const toMove = messages.filter(m =>
      m.accountEmail === account.email &&
      m.category === "webshop" &&
      !(m.labelIds || []).includes(labelId)
    );
    if (toMove.length === 0) continue;

    const ids = toMove.map(m => m.id);
    if (account.provider === "microsoft") {
      await moveMicrosoftMessagesBulk(account, ids, labelId);
    } else {
      await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
        method: "POST",
        headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids, addLabelIds: [labelId], removeLabelIds: ["INBOX"] })
      });
    }

    // Lokaal ook meteen uit Postvak IN halen, zodat het gelijk klopt in beeld.
    const movedIds = new Set(ids);
    state.messages = state.messages.filter(m => !movedIds.has(m.id));
  }
}

/* ---------------- Oude webshopmail met terugwerkende kracht verplaatsen ---------------- */

async function findWebshopMessageIdsForAccount(account) {
  if (account.provider === "microsoft") {
    const msgs = await fetchAllMicrosoftMessages(account, {
      select: "id,subject,from,internetMessageHeaders"
    });
    return msgs
      .map(d => mapMicrosoftMessage(d, account))
      .filter(m => m.category === "webshop")
      .map(m => m.id);
  }

  // Gmail: zoekopdracht op basis van de bekende domeinenlijst, in kleine
  // stukken zodat de query niet te lang wordt.
  const chunkSize = 20;
  const idSet = new Set();
  for (let i = 0; i < WEBSHOP_DOMAINS.length; i += chunkSize) {
    const chunk = WEBSHOP_DOMAINS.slice(i, i + chunkSize);
    const q = "in:inbox (" + chunk.map(d => `from:${d}`).join(" OR ") + ")";
    let pageToken = null;
    let pages = 0;
    do {
      const params = new URLSearchParams({ q, maxResults: "500" });
      if (pageToken) params.set("pageToken", pageToken);
      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
        { headers: { Authorization: `Bearer ${account.token}` } }
      );
      if (!r.ok) break;
      const data = await r.json();
      (data.messages || []).forEach(m => idSet.add(m.id));
      pageToken = data.nextPageToken || null;
      pages += 1;
    } while (pageToken && pages < 5);
  }
  return [...idSet];
}

async function applyWebshopMove(account, ids) {
  const labelId = await getOrCreateWebshopLabelId(account);
  if (!labelId) return false;
  if (account.provider === "microsoft") {
    await moveMicrosoftMessagesBulk(account, ids, labelId);
  } else {
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
        method: "POST",
        headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: chunk, addLabelIds: [labelId], removeLabelIds: ["INBOX"] })
      });
    }
  }
  return true;
}


function classifyMessage(message) {
  if (looksLikeWebshopMail(message)) return "webshop";
  if (message.hasListUnsubscribe) return "newsletter";
  const from = message.from.toLowerCase();
  if (/no-?reply|notification|alert|do-?not-?reply/.test(from)) return "notification";
  return "personal";
}

/* ---------------- Rules engine ---------------- */

function ruleMatches(rule, message) {
  const fromMatch = rule.from && message.from.toLowerCase().includes(rule.from.toLowerCase());
  const subjectMatch = rule.subject && message.subject.toLowerCase().includes(rule.subject.toLowerCase());
  return Boolean(fromMatch || subjectMatch);
}

async function applyRulesToNewMessages(messages) {
  for (const message of messages) {
    for (const rule of state.rules) {
      if (!ruleMatches(rule, message)) continue;
      const account = state.accounts.find(a => a.email === message.accountEmail);
      if (!account || !account.token) continue;
      await executeRuleAction(rule, message, account);
    }
  }
}

async function executeRuleAction(rule, message, account) {
  try {
    if (rule.action === "archive") {
      await modifyLabels(message.id, account.token, { removeLabelIds: ["INBOX"] });
    } else if (rule.action === "trash") {
      await modifyLabels(message.id, account.token, { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "UNREAD"] });
    } else if (rule.action === "label") {
      console.log(`Label '${rule.actionValue}' toepassen op ${message.id} (labels.create + modify volgt)`);
    } else if (rule.action === "autoreply") {
      console.log(`Auto-reply verzonden voor ${message.id}: "${rule.actionValue}"`);
    }
  } catch (e) {
    console.error("Regel-actie mislukt", rule, message.id, e);
  }
}

/* ---------------- Gmail acties ---------------- */

function accountForMessage(id) {
  const message = state.messages.find(m => m.id === id);
  if (!message) return null;
  return state.accounts.find(a => a.email === message.accountEmail);
}

async function modifyLabels(messageId, token, body) {
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function archiveMessage(id) {
  const account = accountForMessage(id);
  if (!account || !account.token) return;
  if (account.provider === "microsoft") await moveMicrosoftMessage(account, id, "archive");
  else await modifyLabels(id, account.token, { removeLabelIds: ["INBOX"] });
  state.messages = state.messages.filter(m => m.id !== id);
  renderMessages();
}

async function trashMessage(id) {
  const account = accountForMessage(id);
  if (!account || !account.token) return;
  if (account.provider === "microsoft") {
    await moveMicrosoftMessage(account, id, "deleteditems");
  } else {
    await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}` }
    });
  }
  state.messages = state.messages.filter(m => m.id !== id);
  renderMessages();
}

async function snoozeMessage(id, until) {
  const account = accountForMessage(id);
  if (!account || !account.token) return;
  if (account.provider === "microsoft") await moveMicrosoftMessage(account, id, "archive");
  else await modifyLabels(id, account.token, { removeLabelIds: ["INBOX"] });
  state.snoozed[id] = until;
  persistSnoozed();
  state.messages = state.messages.filter(m => m.id !== id);
  renderMessages();
}

async function moveMicrosoftMessage(account, id, destinationId) {
  await fetch(`https://graph.microsoft.com/v1.0/me/messages/${id}/move`, {
    method: "POST",
    headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ destinationId })
  });
}

function snoozeUntilTimestamp(kind) {
  const now = new Date();
  if (kind === "1h") return Date.now() + 60 * 60 * 1000;
  if (kind === "tonight") { const d = new Date(now); d.setHours(19, 0, 0, 0); if (d < now) d.setDate(d.getDate() + 1); return d.getTime(); }
  if (kind === "tomorrow") { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); return d.getTime(); }
  if (kind === "nextweek") { const d = new Date(now); d.setDate(d.getDate() + 7); d.setHours(8, 0, 0, 0); return d.getTime(); }
  return Date.now() + 60 * 60 * 1000;
}

function cleanupExpiredSnoozes() {
  const now = Date.now();
  const dueIds = Object.entries(state.snoozed).filter(([, until]) => until <= now).map(([id]) => id);
  dueIds.forEach(id => delete state.snoozed[id]);
  if (dueIds.length) persistSnoozed();
}

/* ---------------- Detail / volledige berichttekst ---------------- */

function decodeBase64Url(data) {
  if (!data) return "";
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  try { return decodeURIComponent(escape(atob(base64))); }
  catch (e) { try { return atob(base64); } catch (e2) { return ""; } }
}

function getPartHeader(part, name) {
  const headers = part.headers || [];
  const h = headers.find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

function decodeQuotedPrintable(str) {
  // Zachte regeleindes (soft line breaks) weghalen.
  const cleaned = str.replace(/=\r\n/g, "").replace(/=\n/g, "");
  const bytes = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(cleaned.substr(i + 1, 2))) {
      bytes.push(parseInt(cleaned.substr(i + 1, 2), 16));
      i += 2;
    } else {
      bytes.push(cleaned.charCodeAt(i));
    }
  }
  try {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  } catch (e) {
    return cleaned;
  }
}

function decodePartBody(part) {
  const raw = decodeBase64Url(part.body?.data);
  const encoding = getPartHeader(part, "Content-Transfer-Encoding").toLowerCase();
  if (encoding.includes("quoted-printable")) return decodeQuotedPrintable(raw);
  return raw;
}

function extractBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodePartBody(payload);
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === "text/plain");
    if (plain && plain.body?.data) return decodePartBody(plain);
    const html = payload.parts.find(p => p.mimeType === "text/html");
    if (html && html.body?.data) return stripHtml(decodePartBody(html));
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) return stripHtml(decodePartBody(payload));
  return "";
}

function stripHtml(html) {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.textContent || "";
}

let activeDetailMessage = null;

async function openDetail(message) {
  activeDetailMessage = message;
  document.getElementById("detail-subject").textContent = message.subject;
  document.getElementById("detail-from").textContent = `${stripAngle(message.from)} · ${message.accountEmail}`;
  document.getElementById("detail-time").textContent = new Date(message.timestamp).toLocaleString("nl-NL");
  document.getElementById("detail-body").textContent = "Bericht laden…";
  document.getElementById("detail-snooze-options").classList.add("hidden");
  document.getElementById("detail-reply-box").classList.add("hidden");
  document.getElementById("detail-modal").classList.remove("hidden");

  const account = state.accounts.find(a => a.email === message.accountEmail);
  if (!account || !account.token) {
    document.getElementById("detail-body").textContent = "Kan bericht niet laden — account niet verbonden.";
    return;
  }
  try {
    if (account.provider === "microsoft") {
      const r = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${message.id}?$select=body`, {
        headers: { Authorization: `Bearer ${account.token}` }
      });
      const data = await r.json();
      const raw = data.body?.content || "";
      const text = data.body?.contentType === "html" ? stripHtml(raw) : raw;
      document.getElementById("detail-body").textContent = text || message.snippet || "(geen tekst gevonden)";
    } else {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`, {
        headers: { Authorization: `Bearer ${account.token}` }
      });
      const data = await r.json();
      document.getElementById("detail-body").textContent = extractBody(data.payload) || message.snippet || "(geen tekst gevonden)";
    }
  } catch (e) {
    document.getElementById("detail-body").textContent = message.snippet || "Kon bericht niet volledig laden.";
  }
}

async function sendReply(message, bodyText) {
  const account = state.accounts.find(a => a.email === message.accountEmail);
  if (!account || !account.token) { alert("Dit account is niet verbonden."); return; }

  if (account.provider === "microsoft") {
    await fetch(`https://graph.microsoft.com/v1.0/me/messages/${message.id}/reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ comment: bodyText })
    });
    return;
  }

  const toAddress = extractEmailAddress(message.from);
  const subject = message.subject.toLowerCase().startsWith("re:") ? message.subject : `Re: ${message.subject}`;
  await sendMail(message.accountEmail, {
    to: toAddress, subject, body: bodyText,
    inReplyTo: message.messageIdHeader, threadId: message.threadId
  });
}

async function sendMail(fromAccountEmail, { to, subject, body, inReplyTo, threadId }) {
  const account = state.accounts.find(a => a.email === fromAccountEmail);
  if (!account || !account.token) { alert("Dit account is niet verbonden."); return; }

  if (account.provider === "microsoft") {
    await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "Text", content: body },
          toRecipients: [{ emailAddress: { address: to } }]
        },
        saveToSentItems: true
      })
    });
    return;
  }

  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : "",
    inReplyTo ? `References: ${inReplyTo}` : "",
    "Content-Type: text/plain; charset=UTF-8",
    "", body
  ].filter(Boolean).join("\r\n");

  const raw = btoa(unescape(encodeURIComponent(lines)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const payload = { raw };
  if (threadId) payload.threadId = threadId;

  await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
}

function extractEmailAddress(from) {
  const match = from.match(/<(.+)>/);
  return match ? match[1] : from;
}

/* ---------------- Opstellen (nieuwe e-mail) ---------------- */

function openCompose() {
  const connected = state.accounts.filter(a => a.token);
  if (connected.length === 0) { alert("Verbind eerst een account voordat je een e-mail kunt versturen."); return; }

  const fromSelect = document.getElementById("compose-from");
  fromSelect.innerHTML = connected.map(a => `<option value="${a.email}">${a.email}</option>`).join("");
  document.getElementById("compose-to").value = "";
  document.getElementById("compose-subject").value = "";
  document.getElementById("compose-body").value = "";
  document.getElementById("compose-modal").classList.remove("hidden");
}

function wireComposeModal() {
  document.getElementById("compose-cancel").addEventListener("click", () => {
    document.getElementById("compose-modal").classList.add("hidden");
  });
  document.getElementById("compose-send").addEventListener("click", async () => {
    const from = document.getElementById("compose-from").value;
    const to = document.getElementById("compose-to").value.trim();
    const subject = document.getElementById("compose-subject").value.trim();
    const body = document.getElementById("compose-body").value.trim();
    if (!to || !subject) { alert("Vul minstens een ontvanger en onderwerp in."); return; }
    await sendMail(from, { to, subject, body });
    document.getElementById("compose-modal").classList.add("hidden");
    if (state.activeFolder === "SENT") refreshInbox();
  });
}

/* ---------------- Notificaties ---------------- */

function notifyNewMessages(messages) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const fresh = messages.filter(m => !state.seenIds.has(m.id));
  fresh.slice(0, 5).forEach(m => {
    new Notification(stripAngle(m.from), { body: m.subject, tag: m.id });
  });
}

/* ---------------- Google Calendar: fetch + merge ---------------- */

function rangeBounds(range) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  if (range === "today") end.setDate(end.getDate() + 1);
  else if (range === "week") end.setDate(end.getDate() + 7);
  else if (range === "month") end.setMonth(end.getMonth() + 1);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

async function refreshCalendar() {
  const connected = state.accounts.filter(a => a.token);
  if (connected.length === 0) { state.events = []; renderEvents(); return; }

  const { timeMin, timeMax } = rangeBounds(state.activeRange);
  const results = await Promise.all(connected.map(a => fetchAccountEvents(a, timeMin, timeMax)));
  state.events = results.flat().sort((a, b) => a.start - b.start);
  renderEvents();
}

async function fetchAccountEvents(account, timeMin, timeMax) {
  if (account.provider === "microsoft") return fetchMicrosoftEvents(account, timeMin, timeMax);
  try {
    const params = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "50" });
    const r = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${account.token}` } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return (data.items || []).map(ev => ({
      id: ev.id,
      accountEmail: account.email,
      accountColor: account.color,
      title: ev.summary || "(geen titel)",
      location: ev.location || "",
      description: ev.description || "",
      start: new Date(ev.start?.dateTime || ev.start?.date).getTime(),
      end: new Date(ev.end?.dateTime || ev.end?.date).getTime(),
      allDay: !ev.start?.dateTime,
      attendees: (ev.attendees || []).map(a => a.email)
    }));
  } catch (e) {
    console.error("Kalender ophalen mislukt voor", account.email, e);
    return [];
  }
}

async function fetchMicrosoftEvents(account, timeMin, timeMax) {
  try {
    const params = new URLSearchParams({
      startDateTime: timeMin,
      endDateTime: timeMax,
      $select: "subject,bodyPreview,location,start,end,isAllDay,attendees",
      $orderby: "start/dateTime"
    });
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarView?${params.toString()}`,
      { headers: { Authorization: `Bearer ${account.token}`, Prefer: 'outlook.timezone="UTC"' } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return (data.value || []).map(ev => ({
      id: ev.id,
      accountEmail: account.email,
      accountColor: account.color,
      title: ev.subject || "(geen titel)",
      location: ev.location?.displayName || "",
      description: ev.bodyPreview || "",
      start: new Date(ev.start?.dateTime + "Z").getTime(),
      end: new Date(ev.end?.dateTime + "Z").getTime(),
      allDay: Boolean(ev.isAllDay),
      attendees: (ev.attendees || []).map(a => a.emailAddress?.address).filter(Boolean)
    }));
  } catch (e) {
    console.error("Kalender ophalen (Microsoft) mislukt voor", account.email, e);
    return [];
  }
}

async function createEvent(accountEmail, data) {
  const account = state.accounts.find(a => a.email === accountEmail);
  if (!account || !account.token) return;
  if (account.provider === "microsoft") {
    await fetch("https://graph.microsoft.com/v1.0/me/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildMicrosoftEventBody(data))
    });
  } else {
    await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildEventBody(data))
    });
  }
  refreshCalendar();
}

async function updateEvent(accountEmail, eventId, data) {
  const account = state.accounts.find(a => a.email === accountEmail);
  if (!account || !account.token) return;
  if (account.provider === "microsoft") {
    await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildMicrosoftEventBody(data))
    });
  } else {
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildEventBody(data))
    });
  }
  refreshCalendar();
}

async function deleteEvent(accountEmail, eventId) {
  const account = state.accounts.find(a => a.email === accountEmail);
  if (!account || !account.token) return;
  if (account.provider === "microsoft") {
    await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${account.token}` }
    });
  } else {
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${account.token}` }
    });
  }
  refreshCalendar();
}

function buildEventBody({ title, start, end, allDay, location, description, guests }) {
  const body = { summary: title, location, description };
  if (allDay) { body.start = { date: start }; body.end = { date: end }; }
  else { body.start = { dateTime: new Date(start).toISOString() }; body.end = { dateTime: new Date(end).toISOString() }; }
  if (guests && guests.length) body.attendees = guests.map(email => ({ email }));
  return body;
}

function buildMicrosoftEventBody({ title, start, end, allDay, location, description, guests }) {
  const body = {
    subject: title,
    body: { contentType: "Text", content: description || "" },
    location: { displayName: location || "" },
    isAllDay: Boolean(allDay)
  };
  if (allDay) {
    body.start = { dateTime: `${start}T00:00:00`, timeZone: "UTC" };
    body.end = { dateTime: `${end}T00:00:00`, timeZone: "UTC" };
  } else {
    body.start = { dateTime: new Date(start).toISOString().replace("Z", ""), timeZone: "UTC" };
    body.end = { dateTime: new Date(end).toISOString().replace("Z", ""), timeZone: "UTC" };
  }
  if (guests && guests.length) {
    body.attendees = guests.map(email => ({ emailAddress: { address: email }, type: "required" }));
  }
  return body;
}

/* ---------------- Rendering: inbox ---------------- */

function visibleMessages() {
  return state.messages.filter(m => {
    if (state.snoozed[m.id]) return false;
    if (state.activeAccountFilter && m.accountEmail !== state.activeAccountFilter) return false;
    if (state.activeCategoryFilter && m.category !== state.activeCategoryFilter) return false;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!`${m.from} ${m.subject} ${m.snippet}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

function renderFolderChips() {
  const wrap = document.getElementById("folder-chips");
  wrap.innerHTML = "";
  Object.entries(FOLDERS).forEach(([key, label]) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.activeFolder === key ? " active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      state.activeFolder = key;
      renderFolderChips();
      state.messages = [];
      renderMessages();
      refreshInbox();
    });
    wrap.appendChild(chip);
  });
}

function renderChips() {
  const wrap = document.getElementById("account-chips");
  wrap.innerHTML = "";
  const allChip = document.createElement("button");
  allChip.className = "chip" + (state.activeAccountFilter === null ? " active" : "");
  allChip.textContent = "Alle accounts";
  allChip.addEventListener("click", () => { state.activeAccountFilter = null; renderChips(); renderMessages(); });
  wrap.appendChild(allChip);

  state.accounts.forEach(a => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.activeAccountFilter === a.email ? " active" : "");
    chip.innerHTML = `<span class="chip-dot" style="background:${a.color}"></span>${a.email.split("@")[0]}`;
    chip.addEventListener("click", () => { state.activeAccountFilter = a.email; renderChips(); renderMessages(); });
    wrap.appendChild(chip);
  });
}

function renderCategoryChips() {
  const wrap = document.getElementById("category-chips");
  wrap.innerHTML = "";
  if (!state.settings.categorize) return;

  const allChip = document.createElement("button");
  allChip.className = "chip" + (state.activeCategoryFilter === null ? " active" : "");
  allChip.textContent = "Alle categorieën";
  allChip.addEventListener("click", () => { state.activeCategoryFilter = null; renderCategoryChips(); renderMessages(); });
  wrap.appendChild(allChip);

  Object.entries(CATEGORY_LABELS).forEach(([key, label]) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.activeCategoryFilter === key ? " active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => { state.activeCategoryFilter = key; renderCategoryChips(); renderMessages(); });
    wrap.appendChild(chip);
  });
}

function renderMessages() {
  const list = document.getElementById("message-list");
  const empty = document.getElementById("inbox-empty");
  const filtered = visibleMessages();

  list.innerHTML = "";
  empty.classList.toggle("hidden", filtered.length > 0);

  filtered.forEach(m => {
    const li = document.createElement("li");
    li.className = "message-row" + (state.selectionMode ? " selectable" : "") + (state.selectedIds.has(m.id) ? " selected" : "");
    li.style.borderLeftColor = m.accountColor;

    const rightLabel = ACTION_LABELS[state.settings.swipeRight];
    const leftLabel = ACTION_LABELS[state.settings.swipeLeft];
    const time = new Date(m.timestamp).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const categoryPill = state.settings.categorize ? `<span class="category-pill">${CATEGORY_LABELS[m.category]}</span>` : "";

    li.innerHTML = `
      <div class="swipe-bg">
        <span>${leftLabel}</span>
        <span>${rightLabel}</span>
      </div>
      <div class="select-checkbox">${state.selectedIds.has(m.id) ? "✓" : ""}</div>
      <div class="message-row-inner">
        <div class="row-top">
          <span class="message-from">${escapeHtml(stripAngle(m.from))}${categoryPill}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-subject">${escapeHtml(m.subject)}</div>
        <div class="message-snippet">${escapeHtml(m.snippet)}</div>
      </div>
    `;
    li.addEventListener("click", () => {
      if (li.dataset.swiping === "1") return;
      if (state.selectionMode) toggleMessageSelection(m.id);
      else openDetail(m);
    });
    if (!state.selectionMode) wireSwipe(li, m.id);
    list.appendChild(li);
  });
}

function toggleMessageSelection(id) {
  if (state.selectedIds.has(id)) state.selectedIds.delete(id);
  else state.selectedIds.add(id);
  updateSelectionBar();
  renderMessages();
}

function updateSelectionBar() {
  const bar = document.getElementById("selection-bar");
  const count = state.selectedIds.size;
  document.getElementById("selection-count").textContent = `${count} geselecteerd`;
  bar.classList.toggle("hidden", !state.selectionMode || count === 0);
}

function wireSelectionMode() {
  document.getElementById("select-mode-btn").addEventListener("click", () => {
    state.selectionMode = !state.selectionMode;
    state.selectedIds.clear();
    document.getElementById("select-mode-btn").textContent = state.selectionMode ? "Klaar" : "Selecteren";
    updateSelectionBar();
    renderMessages();
  });

  document.getElementById("selection-cancel-btn").addEventListener("click", () => {
    state.selectionMode = false;
    state.selectedIds.clear();
    document.getElementById("select-mode-btn").textContent = "Selecteren";
    updateSelectionBar();
    renderMessages();
  });

  document.getElementById("selection-archive-btn").addEventListener("click", () => runSelectionAction("archive"));
  document.getElementById("selection-trash-btn").addEventListener("click", () => runSelectionAction("trash"));

  async function runSelectionAction(action) {
    const ids = [...state.selectedIds];
    if (ids.length === 0) return;

    // Groepeer per account, want elke Gmail/Microsoft-aanroep werkt met het
    // token van dat specifieke account.
    const byAccount = new Map();
    ids.forEach(id => {
      const account = accountForMessage(id);
      if (!account) return;
      if (!byAccount.has(account.email)) byAccount.set(account.email, { account, ids: [] });
      byAccount.get(account.email).ids.push(id);
    });

    for (const { account, ids: accountIds } of byAccount.values()) {
      try {
        await bulkModifyMessages(account, accountIds, action);
      } catch (e) {
        console.error("Bulkactie mislukt voor", account.email, e);
      }
    }

    const selectedSet = new Set(ids);
    state.messages = state.messages.filter(m => !selectedSet.has(m.id));
    state.selectionMode = false;
    state.selectedIds.clear();
    document.getElementById("select-mode-btn").textContent = "Selecteren";
    updateSelectionBar();
    renderMessages();
  }
}

function runAction(action, id) {
  if (action === "archive") return archiveMessage(id);
  if (action === "trash") return trashMessage(id);
  if (action === "snooze1h") return snoozeMessage(id, snoozeUntilTimestamp("1h"));
}

function wireSwipe(li, id) {
  const inner = li.querySelector(".message-row-inner");
  let startX = 0, currentX = 0, dragging = false;

  li.addEventListener("touchstart", (e) => {
    startX = e.touches[0].clientX;
    dragging = true;
    li.dataset.swiping = "0";
  }, { passive: true });

  li.addEventListener("touchmove", (e) => {
    if (!dragging) return;
    currentX = e.touches[0].clientX - startX;
    if (Math.abs(currentX) > 8) li.dataset.swiping = "1";
    inner.style.transform = `translateX(${currentX}px)`;
  }, { passive: true });

  li.addEventListener("touchend", () => {
    dragging = false;
    const threshold = 90;
    if (currentX > threshold) runAction(state.settings.swipeRight, id);
    else if (currentX < -threshold) runAction(state.settings.swipeLeft, id);
    else inner.style.transform = "translateX(0)";
    currentX = 0;
    setTimeout(() => { li.dataset.swiping = "0"; }, 50);
  });
}

function renderAccounts() {
  const list = document.getElementById("accounts-list");
  list.innerHTML = "";
  state.accounts.forEach(a => {
    const li = document.createElement("li");
    li.className = "account-row";
    const initials = a.email.slice(0, 2).toUpperCase();
    const providerLabel = a.provider === "microsoft" ? "Hotmail/Outlook" : "Google";
    const reconnectBtn = a.token
      ? ""
      : `<button class="account-reconnect" data-email="${a.email}" data-provider="${a.provider || "google"}">Opnieuw verbinden</button>`;
    li.innerHTML = `
      <div class="account-info">
        <div class="account-avatar" style="background:${a.color}">${initials}</div>
        <div>
          <div class="account-email">${escapeHtml(a.email)}</div>
          <div class="account-status">${providerLabel} · ${a.token ? "Verbonden" : "Opnieuw verbinden nodig"}</div>
        </div>
      </div>
      <div class="account-actions">
        ${reconnectBtn}
        <button class="account-delete" data-email="${a.email}">Verwijderen</button>
      </div>
    `;
    list.appendChild(li);
  });
  list.querySelectorAll(".account-delete").forEach(btn => {
    btn.addEventListener("click", () => removeAccount(btn.dataset.email));
  });
  list.querySelectorAll(".account-reconnect").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.provider === "microsoft") reconnectMicrosoftAccount(btn.dataset.email);
      else reconnectAccount(btn.dataset.email);
    });
  });
}

function reconnectAccount(email) {
  if (!window.google || !google.accounts || !google.accounts.oauth2) {
    alert("Google-inlogscript is nog niet geladen. Probeer het over een paar seconden opnieuw.");
    return;
  }
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.clientId,
    scope: SCOPES,
    hint: email,
    callback: async (resp) => {
      if (resp.error) { alert("Opnieuw verbinden mislukt: " + resp.error); return; }
      addOrUpdateAccount(email, resp.access_token, resp.expires_in);
    }
  });
  tokenClient.requestAccessToken();
}

function renderRules() {
  const list = document.getElementById("rules-list");
  const empty = document.getElementById("rules-empty");
  list.innerHTML = "";
  empty.classList.toggle("hidden", state.rules.length > 0);

  const actionLabel = { archive: "Archiveert", trash: "Verwijdert", label: "Labelt", autoreply: "Auto-reply" };

  state.rules.forEach((rule, idx) => {
    const li = document.createElement("li");
    li.className = "rule-row";
    const conditionParts = [];
    if (rule.from) conditionParts.push(`afzender bevat <b>${escapeHtml(rule.from)}</b>`);
    if (rule.subject) conditionParts.push(`onderwerp bevat <b>${escapeHtml(rule.subject)}</b>`);
    li.innerHTML = `
      <div class="rule-condition">${conditionParts.join(" of ")}</div>
      <span class="rule-action-tag">${actionLabel[rule.action]}</span>
      <button class="rule-delete" data-idx="${idx}">✕</button>
    `;
    list.appendChild(li);
  });
  list.querySelectorAll(".rule-delete").forEach(btn => {
    btn.addEventListener("click", () => {
      state.rules.splice(parseInt(btn.dataset.idx, 10), 1);
      persistRules();
      renderRules();
    });
  });
}

/* ---------------- Rendering: kalender ---------------- */

function renderCalendarAccountChips() {
  const wrap = document.getElementById("calendar-account-chips");
  wrap.innerHTML = "";
  const allChip = document.createElement("button");
  allChip.className = "chip" + (state.activeCalendarAccountFilter === null ? " active" : "");
  allChip.textContent = "Alle agenda's";
  allChip.addEventListener("click", () => { state.activeCalendarAccountFilter = null; renderCalendarAccountChips(); renderEvents(); });
  wrap.appendChild(allChip);

  state.accounts.forEach(a => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.activeCalendarAccountFilter === a.email ? " active" : "");
    chip.innerHTML = `<span class="chip-dot" style="background:${a.color}"></span>${a.email.split("@")[0]}`;
    chip.addEventListener("click", () => { state.activeCalendarAccountFilter = a.email; renderCalendarAccountChips(); renderEvents(); });
    wrap.appendChild(chip);
  });
}

function renderRangeChips() {
  const wrap = document.getElementById("calendar-range-chips");
  wrap.innerHTML = "";
  Object.entries(RANGE_LABELS).forEach(([key, label]) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.activeRange === key ? " active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => { state.activeRange = key; renderRangeChips(); refreshCalendar(); });
    wrap.appendChild(chip);
  });
}

/* ---------------- Kalender-subtabs: Agenda / Restaurants ---------------- */

function renderCalendarSubtabs() {
  const wrap = document.getElementById("calendar-subview-chips");
  wrap.innerHTML = "";
  const tabs = { agenda: "Agenda", restaurants: "Restaurants in de buurt" };
  Object.entries(tabs).forEach(([key, label]) => {
    const chip = document.createElement("button");
    chip.className = "chip" + (state.calendarSubView === key ? " active" : "");
    chip.textContent = label;
    chip.addEventListener("click", () => {
      state.calendarSubView = key;
      renderCalendarSubtabs();
      document.getElementById("calendar-agenda-panel").classList.toggle("hidden", key !== "agenda");
      document.getElementById("restaurants-panel").classList.toggle("hidden", key !== "restaurants");
    });
    wrap.appendChild(chip);
  });
}


/* ---------------- Route-pagina (los, niet gekoppeld aan een afspraak) ---------------- */

function wireRoutePage() {
  const trainChip = document.getElementById("route-page-train-chip");
  const carChip = document.getElementById("route-page-car-chip");
  const trainPanel = document.getElementById("route-page-train-panel");
  const carPanel = document.getElementById("route-page-car-panel");

  trainChip.addEventListener("click", () => {
    trainChip.classList.add("active");
    carChip.classList.remove("active");
    trainPanel.classList.remove("hidden");
    carPanel.classList.add("hidden");
    ensureStationsLoaded();
  });
  carChip.addEventListener("click", () => {
    carChip.classList.add("active");
    trainChip.classList.remove("active");
    carPanel.classList.remove("hidden");
    trainPanel.classList.add("hidden");
  });

  let lastTrainSearch = null; // { fromCode, toCode }

  async function runTrainSearch(overrideIso) {
    const statusEl = document.getElementById("route-page-train-status");
    const listEl = document.getElementById("route-page-train-results");
    const shiftRow = document.getElementById("route-page-train-shift-row");
    listEl.innerHTML = "";
    shiftRow.classList.add("hidden");

    if (!state.nsApiKey) { statusEl.classList.remove("hidden"); statusEl.textContent = "Vul eerst je NS API-sleutel in bij Instellingen."; return; }

    await ensureStationsLoaded();
    if (!nsStationsCache) { statusEl.classList.remove("hidden"); statusEl.textContent = "Kon de stationslijst niet ophalen — check je API-sleutel."; return; }

    let fromCode, toCode, dateTimeIso;
    if (overrideIso && lastTrainSearch) {
      ({ fromCode, toCode } = lastTrainSearch);
      dateTimeIso = overrideIso;
    } else {
      const fromName = document.getElementById("route-page-train-from").value.trim();
      const toName = document.getElementById("route-page-train-to").value.trim();
      if (!fromName || !toName) { statusEl.classList.remove("hidden"); statusEl.textContent = "Vul zowel een vertrek- als aankomststation in."; return; }
      fromCode = findStationCode(fromName);
      toCode = findStationCode(toName);
      if (!fromCode || !toCode) { statusEl.classList.remove("hidden"); statusEl.textContent = "Kon een van de stations niet herkennen — kies een station uit de lijst."; return; }
      dateTimeIso = new Date().toISOString();
      lastTrainSearch = { fromCode, toCode };
    }

    statusEl.classList.remove("hidden");
    statusEl.textContent = "Zoeken...";

    try {
      const trips = await fetchNsTripsRaw(fromCode, toCode, dateTimeIso);
      if (trips.length === 0) { statusEl.textContent = "Geen reizen gevonden."; return; }
      statusEl.classList.add("hidden");
      shiftRow.classList.remove("hidden");

      const firstTrip = trips[0];
      const lastTrip = trips[trips.length - 1];
      const firstDep = firstTrip?.legs?.[0]?.origin?.actualDateTime || firstTrip?.legs?.[0]?.origin?.plannedDateTime;
      const lastDep = lastTrip?.legs?.[0]?.origin?.actualDateTime || lastTrip?.legs?.[0]?.origin?.plannedDateTime;

      trips.slice(0, 10).forEach(trip => {
        const firstLeg = trip.legs?.[0];
        const lastLeg = trip.legs?.[trip.legs.length - 1];
        const depTime = firstLeg?.origin?.actualDateTime || firstLeg?.origin?.plannedDateTime;
        const arrTime = lastLeg?.destination?.actualDateTime || lastLeg?.destination?.plannedDateTime;
        const depFmt = depTime ? new Date(depTime).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";
        const arrFmt = arrTime ? new Date(arrTime).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";
        const transfers = Math.max((trip.legs?.length || 1) - 1, 0);
        const platform = firstLeg?.origin?.actualTrack || firstLeg?.origin?.plannedTrack || "?";
        const delayed = trip.status && trip.status !== "NORMAL";

        const li = document.createElement("li");
        li.className = "restaurant-row";
        li.innerHTML = `
          <div class="restaurant-top">
            <span class="restaurant-name">${depFmt} → ${arrFmt}</span>
            <span class="restaurant-distance">spoor ${escapeHtml(String(platform))}</span>
          </div>
          <div class="restaurant-cuisine">${transfers === 0 ? "Rechtstreeks" : `${transfers} overstap${transfers > 1 ? "pen" : ""}`}</div>
          ${delayed ? `<div class="restaurant-hours" style="color:#D68080;">Verstoring/vertraging gemeld</div>` : ""}
        `;
        listEl.appendChild(li);
      });

      document.getElementById("route-page-train-earlier-btn").onclick = () => {
        if (!firstDep) return;
        runTrainSearch(new Date(new Date(firstDep).getTime() - 60 * 60 * 1000).toISOString());
      };
      document.getElementById("route-page-train-later-btn").onclick = () => {
        if (!lastDep) return;
        runTrainSearch(new Date(new Date(lastDep).getTime() + 60 * 60 * 1000).toISOString());
      };
    } catch (e) {
      console.error("Treinreis zoeken mislukt", e);
      statusEl.classList.remove("hidden");
      statusEl.textContent = "Zoeken mislukt — check je API-sleutel of probeer het later opnieuw.";
    }
  }

  document.getElementById("route-page-train-search-btn").addEventListener("click", () => runTrainSearch());

  document.getElementById("route-page-car-search-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("route-page-car-status");
    const listEl = document.getElementById("route-page-car-results");
    listEl.innerHTML = "";

    const fromAddress = document.getElementById("route-page-car-from").value.trim();
    const destination = document.getElementById("route-page-car-to").value.trim();
    if (!destination) { statusEl.classList.remove("hidden"); statusEl.textContent = "Vul een bestemming in."; return; }

    statusEl.classList.remove("hidden");
    statusEl.textContent = fromAddress ? "Vertrekadres zoeken..." : "Je locatie wordt opgevraagd...";

    try {
      const origin = await resolveOrigin(fromAddress);
      statusEl.textContent = "Bestemming zoeken...";
      const geoResult = await geocodeAddress(destination);
      if (!geoResult) { statusEl.textContent = "Kon dit adres niet vinden."; return; }

      statusEl.textContent = "Reistijd berekenen...";
      const routeR = await fetch(`https://router.project-osrm.org/route/v1/driving/${origin.longitude},${origin.latitude};${geoResult.lon},${geoResult.lat}?overview=false`);
      const routeData = await routeR.json();
      const route = routeData.routes?.[0];
      if (!route) { statusEl.textContent = "Kon geen route berekenen."; return; }

      const minutes = Math.round(route.duration / 60);
      const km = (route.distance / 1000).toFixed(1);

      statusEl.classList.add("hidden");
      const li = document.createElement("li");
      li.className = "restaurant-row";
      li.innerHTML = `
        <div class="restaurant-top">
          <span class="restaurant-name">Auto naar ${escapeHtml(destination)}</span>
          <span class="restaurant-distance">${minutes} min</span>
        </div>
        <div class="restaurant-cuisine">${km} km</div>
      `;
      listEl.appendChild(li);
    } catch (e) {
      console.error("Autoroute berekenen mislukt", e);
      statusEl.textContent = e.message || "Berekenen mislukt.";
    }
  });
}

function wireRestaurants() {
  document.getElementById("find-restaurants-btn").addEventListener("click", findNearbyRestaurants);
}

/* ---------------- Treinreis (NS Reisinformatie API) ---------------- */

let nsStationsCache = null;

async function ensureStationsLoaded() {
  if (nsStationsCache || !state.nsApiKey) return;
  try {
    const r = await fetch("https://gateway.apiportal.ns.nl/reisinformatie-api/api/v2/stations", {
      headers: { "Ocp-Apim-Subscription-Key": state.nsApiKey }
    });
    if (!r.ok) return;
    const data = await r.json();
    nsStationsCache = (data.payload || []).map(s => ({
      name: s.namen?.lang || s.namen?.middel || s.code,
      code: s.code,
      lat: s.lat,
      lon: s.lng
    }));
    const listEl = document.getElementById("train-stations-list");
    listEl.innerHTML = nsStationsCache.map(s => `<option value="${escapeHtml(s.name)}"></option>`).join("");
  } catch (e) {
    console.error("Stationslijst ophalen mislukt", e);
  }
}

function findStationCode(name) {
  if (!nsStationsCache) return null;
  const lower = name.trim().toLowerCase();
  const exact = nsStationsCache.find(s => s.name.toLowerCase() === lower);
  if (exact) return exact.code;
  const partial = nsStationsCache.find(s => s.name.toLowerCase().includes(lower));
  return partial ? partial.code : null;
}

function findNearestStation(lat, lon) {
  if (!nsStationsCache) return null;
  const withCoords = nsStationsCache.filter(s => s.lat && s.lon);
  if (withCoords.length === 0) return null;
  return withCoords
    .map(s => ({ ...s, distance: haversineDistanceMeters(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.distance - b.distance)[0];
}

function wireTrainPanel() {
  const nowInput = document.getElementById("train-datetime");
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  nowInput.value = now.toISOString().slice(0, 16);

  document.getElementById("train-search-btn").addEventListener("click", searchTrainTrips);
}

let currentTrainSearchDateTime = null;

async function fetchNsTripsRaw(fromCode, toCode, dateTimeIso) {
  const params = new URLSearchParams({ fromStation: fromCode, toStation: toCode, dateTime: dateTimeIso });
  const r = await fetch(`https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips?${params.toString()}`, {
    headers: { "Ocp-Apim-Subscription-Key": state.nsApiKey }
  });
  if (!r.ok) throw new Error("NS-aanvraag mislukt");
  const data = await r.json();
  return data.trips || [];
}

async function searchTrainTrips(overrideDateTimeIso) {
  const statusEl = document.getElementById("train-status");
  const emptyEl = document.getElementById("train-empty");
  const listEl = document.getElementById("train-trip-list");
  const shiftRow = document.getElementById("train-shift-row");

  if (!state.nsApiKey) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Vul eerst je NS API-sleutel in bij Instellingen.";
    return;
  }

  await ensureStationsLoaded();
  if (!nsStationsCache) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Kon de stationslijst niet ophalen — check je API-sleutel.";
    return;
  }

  const fromName = document.getElementById("train-from").value.trim();
  const toName = document.getElementById("train-to").value.trim();
  const dateTimeInput = document.getElementById("train-datetime").value;
  if (!fromName || !toName) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Vul zowel een vertrek- als aankomststation in.";
    return;
  }

  const fromCode = findStationCode(fromName);
  const toCode = findStationCode(toName);
  if (!fromCode || !toCode) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Kon een van de stations niet herkennen — kies een station uit de lijst.";
    return;
  }

  const searchIso = overrideDateTimeIso
    || (dateTimeInput ? new Date(dateTimeInput).toISOString() : new Date().toISOString());
  currentTrainSearchDateTime = searchIso;

  statusEl.classList.remove("hidden");
  statusEl.textContent = "Zoeken...";
  emptyEl.classList.add("hidden");
  listEl.innerHTML = "";
  shiftRow.classList.add("hidden");

  try {
    const params = new URLSearchParams({
      fromStation: fromCode,
      toStation: toCode,
      dateTime: searchIso
    });
    const r = await fetch(`https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips?${params.toString()}`, {
      headers: { "Ocp-Apim-Subscription-Key": state.nsApiKey }
    });
    if (!r.ok) {
      statusEl.textContent = "Zoeken mislukt — check je API-sleutel of probeer het later opnieuw.";
      return;
    }
    const data = await r.json();
    renderTrainTrips(data.trips || []);
  } catch (e) {
    console.error("Treinreis zoeken mislukt", e);
    statusEl.textContent = "Zoeken mislukt.";
  }
}

function renderTrainTrips(trips) {
  const statusEl = document.getElementById("train-status");
  const emptyEl = document.getElementById("train-empty");
  const listEl = document.getElementById("train-trip-list");
  const shiftRow = document.getElementById("train-shift-row");

  listEl.innerHTML = "";

  if (trips.length === 0) {
    statusEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    emptyEl.querySelector(".empty-title").textContent = "Geen reizen gevonden";
    emptyEl.querySelector(".empty-copy").textContent = "Probeer een ander tijdstip of controleer de stationsnamen.";
    return;
  }

  statusEl.classList.add("hidden");
  emptyEl.classList.add("hidden");
  shiftRow.classList.remove("hidden");

  const firstTrip = trips[0];
  const lastTrip = trips[trips.length - 1];
  const firstDep = firstTrip?.legs?.[0]?.origin?.actualDateTime || firstTrip?.legs?.[0]?.origin?.plannedDateTime;
  const lastDep = lastTrip?.legs?.[0]?.origin?.actualDateTime || lastTrip?.legs?.[0]?.origin?.plannedDateTime;

  trips.slice(0, 10).forEach(trip => {
    const firstLeg = trip.legs?.[0];
    const lastLeg = trip.legs?.[trip.legs.length - 1];
    const depTime = firstLeg?.origin?.actualDateTime || firstLeg?.origin?.plannedDateTime;
    const arrTime = lastLeg?.destination?.actualDateTime || lastLeg?.destination?.plannedDateTime;
    const depFmt = depTime ? new Date(depTime).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";
    const arrFmt = arrTime ? new Date(arrTime).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";
    const transfers = Math.max((trip.legs?.length || 1) - 1, 0);
    const platform = firstLeg?.origin?.actualTrack || firstLeg?.origin?.plannedTrack || "?";
    const delayed = trip.status && trip.status !== "NORMAL";

    const li = document.createElement("li");
    li.className = "restaurant-row";
    li.innerHTML = `
      <div class="restaurant-top">
        <span class="restaurant-name">${depFmt} → ${arrFmt}</span>
        <span class="restaurant-distance">${trip.actualDurationInMinutes || trip.plannedDurationInMinutes || "?"} min</span>
      </div>
      <div class="restaurant-cuisine">${transfers === 0 ? "Rechtstreeks" : `${transfers} overstap${transfers > 1 ? "pen" : ""}`} · spoor ${escapeHtml(String(platform))}</div>
      ${delayed ? `<div class="restaurant-hours" style="color:#D68080;">Verstoring/vertraging gemeld</div>` : ""}
      <button class="btn-ghost small add-trip-to-event-btn" style="margin-top:8px; width:auto;">Toevoegen aan afspraak</button>
    `;
    if (depTime && arrTime) {
      li.querySelector(".add-trip-to-event-btn").addEventListener("click", () => {
        const fromName = document.getElementById("train-from").value.trim();
        const toName = document.getElementById("train-to").value.trim();
        openEventModal("create", null, {
          title: `Trein ${fromName ? fromName + " → " : ""}${toName}`.trim(),
          start: toLocalInputValue(new Date(depTime).getTime()),
          end: toLocalInputValue(new Date(arrTime).getTime()),
          location: toName,
          description: `Route: trein ${fromName ? fromName + " → " : ""}${toName}, vertrek ${depFmt}, aankomst ${arrFmt}, spoor ${platform}${transfers > 0 ? `, ${transfers} overstap${transfers > 1 ? "pen" : ""}` : ""}.`
        });
      });
    }
    listEl.appendChild(li);
  });

  document.getElementById("train-earlier-btn").onclick = () => {
    if (!firstDep) return;
    const shifted = new Date(new Date(firstDep).getTime() - 60 * 60 * 1000).toISOString();
    searchTrainTrips(shifted);
  };
  document.getElementById("train-later-btn").onclick = () => {
    if (!lastDep) return;
    const shifted = new Date(new Date(lastDep).getTime() + 60 * 60 * 1000).toISOString();
    searchTrainTrips(shifted);
  };
}

/* ---------------- OV in de buurt (OVapi — bus/tram/metro) ---------------- */

let ovStopsCache = null;

async function ensureOvStopsLoaded() {
  if (ovStopsCache) return;
  try {
    const r = await fetch("https://v0.ovapi.nl/stopareacode/");
    if (!r.ok) return;
    const data = await r.json();
    ovStopsCache = Object.values(data)
      .filter(s => s.Latitude && s.Longitude && s.StopAreaCode)
      .map(s => ({
        code: s.StopAreaCode,
        name: s.TimingPointName || s.StopAreaCode,
        town: s.TimingPointTown || "",
        lat: s.Latitude,
        lon: s.Longitude
      }));
  } catch (e) {
    console.error("OV-haltes ophalen mislukt", e);
  }
}

function wireOvPanel() {
  document.getElementById("find-ov-btn").addEventListener("click", findNearbyOvDepartures);
}

function findNearbyOvDepartures() {
  const statusEl = document.getElementById("ov-status");
  const emptyEl = document.getElementById("ov-empty");
  const listEl = document.getElementById("ov-list");

  if (!("geolocation" in navigator)) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Locatie is niet beschikbaar in deze browser.";
    return;
  }

  statusEl.classList.remove("hidden");
  statusEl.textContent = "Je locatie wordt opgevraagd...";
  emptyEl.classList.add("hidden");
  listEl.innerHTML = "";

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      statusEl.textContent = "Haltes zoeken...";
      await ensureOvStopsLoaded();
      if (!ovStopsCache) {
        statusEl.textContent = "Kon de haltelijst niet ophalen — probeer het later opnieuw.";
        return;
      }

      const nearest = ovStopsCache
        .map(s => ({ ...s, distance: haversineDistanceMeters(latitude, longitude, s.lat, s.lon) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 4);

      statusEl.textContent = "Vertrektijden ophalen...";
      const perStop = await Promise.all(nearest.map(async (stop) => {
        const passes = await fetchOvDepartures(stop.code);
        return { stop, passes };
      }));

      renderOvDepartures(perStop);
    },
    (err) => {
      statusEl.textContent = "Kon je locatie niet ophalen: " + (err.message || "toestemming geweigerd.");
    },
    { enableHighAccuracy: false, timeout: 15000 }
  );
}

async function fetchOvDepartures(stopCode) {
  try {
    const r = await fetch(`https://v0.ovapi.nl/stopareacode/${encodeURIComponent(stopCode)}/departures`);
    if (!r.ok) return [];
    const data = await r.json();
    const stopObj = data[stopCode] || Object.values(data)[0] || {};
    const passes = [];
    Object.values(stopObj).forEach(tp => {
      Object.values(tp.Passes || {}).forEach(pass => passes.push(pass));
    });
    return passes
      .filter(p => p.TargetDepartureTime || p.ExpectedDepartureTime)
      .sort((a, b) => new Date(a.ExpectedDepartureTime || a.TargetDepartureTime) - new Date(b.ExpectedDepartureTime || b.TargetDepartureTime))
      .slice(0, 6);
  } catch (e) {
    console.error("Vertrektijden ophalen mislukt voor", stopCode, e);
    return [];
  }
}

function renderOvDepartures(perStop) {
  const statusEl = document.getElementById("ov-status");
  const emptyEl = document.getElementById("ov-empty");
  const listEl = document.getElementById("ov-list");

  listEl.innerHTML = "";
  const anyPasses = perStop.some(s => s.passes.length > 0);

  if (!anyPasses) {
    statusEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    emptyEl.querySelector(".empty-title").textContent = "Niets gevonden";
    emptyEl.querySelector(".empty-copy").textContent = "Geen live vertrektijden gevonden bij de dichtstbijzijnde haltes.";
    return;
  }

  statusEl.classList.add("hidden");
  emptyEl.classList.add("hidden");

  perStop.forEach(({ stop, passes }) => {
    if (passes.length === 0) return;

    const heading = document.createElement("li");
    heading.className = "event-day-heading";
    const distanceLabel = stop.distance < 1000 ? `${Math.round(stop.distance)} m` : `${(stop.distance / 1000).toFixed(1)} km`;
    heading.textContent = `${stop.name}${stop.town ? " · " + stop.town : ""} (${distanceLabel})`;
    listEl.appendChild(heading);

    passes.forEach(p => {
      const time = p.ExpectedDepartureTime || p.TargetDepartureTime;
      const timeFmt = time ? new Date(time).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";
      const delayed = p.ExpectedDepartureTime && p.TargetDepartureTime && p.ExpectedDepartureTime !== p.TargetDepartureTime;

      const li = document.createElement("li");
      li.className = "restaurant-row";
      li.innerHTML = `
        <div class="restaurant-top">
          <span class="restaurant-name">${escapeHtml(p.LinePublicNumber || "")} → ${escapeHtml(p.DestinationName50 || "?")}</span>
          <span class="restaurant-distance">${timeFmt}</span>
        </div>
        ${delayed ? `<div class="restaurant-hours" style="color:#D68080;">Vertraagd</div>` : ""}
      `;
      listEl.appendChild(li);
    });
  });
}

function normalizeWebsiteUrl(url) {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

let fixedOriginCoordsCache = null;

async function resolveOrigin(fromAddress) {
  if (fromAddress && fromAddress.trim()) {
    const geo = await geocodeAddress(fromAddress.trim());
    if (!geo) throw new Error("Kon het vertrekadres niet vinden.");
    return { latitude: geo.lat, longitude: geo.lon };
  }
  if (state.fixedOrigin) {
    if (fixedOriginCoordsCache) return fixedOriginCoordsCache;
    const geo = await geocodeAddress(state.fixedOrigin);
    if (!geo) throw new Error("Kon het vaste vertrekadres (bij Instellingen) niet vinden.");
    fixedOriginCoordsCache = { latitude: geo.lat, longitude: geo.lon };
    return fixedOriginCoordsCache;
  }
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) { reject(new Error("Locatie niet beschikbaar in deze browser.")); return; }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      (err) => reject(new Error(err.message || "Kon locatie niet ophalen.")),
      { enableHighAccuracy: false, timeout: 25000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

async function geocodeAddress(query) {
  const trimmed = query.trim();
  const alias = state.addressAliases[trimmed.toLowerCase()];
  const resolvedQuery = alias || trimmed;

  // Photon (Komoot) eerst — heeft ingebouwde tolerantie voor kleine
  // spel-/spatiefouten. Nominatim als terugval als Photon niets vindt.
  try {
    const r = await fetch(`https://photon.komoot.io/api/?limit=1&lang=nl&q=${encodeURIComponent(resolvedQuery)}`);
    if (r.ok) {
      const data = await r.json();
      const feature = data.features?.[0];
      if (feature?.geometry?.coordinates) {
        const [lon, lat] = feature.geometry.coordinates;
        return { lat, lon };
      }
    }
  } catch (e) {
    console.error("Photon-geocodering mislukt", e);
  }

  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(resolvedQuery)}`);
    if (r.ok) {
      const data = await r.json();
      if (data[0]) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    }
  } catch (e) {
    console.error("Nominatim-geocodering mislukt", e);
  }

  return null;
}

function haversineDistanceMeters(lat1, lon1, lat2, lon2) {  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearbyRestaurants() {
  const statusEl = document.getElementById("restaurants-status");
  const emptyEl = document.getElementById("restaurants-empty");
  const listEl = document.getElementById("restaurant-list");

  if (!("geolocation" in navigator)) {
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Locatie is niet beschikbaar in deze browser.";
    return;
  }

  statusEl.classList.remove("hidden");
  statusEl.textContent = "Je locatie wordt opgevraagd...";
  emptyEl.classList.add("hidden");
  listEl.innerHTML = "";

  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const { latitude, longitude } = position.coords;
      statusEl.textContent = "Restaurants in de buurt zoeken...";
      try {
        const restaurants = await fetchNearbyRestaurants(latitude, longitude);
        renderRestaurants(restaurants, latitude, longitude);
      } catch (e) {
        console.error("Restaurants zoeken mislukt", e);
        statusEl.textContent = "Zoeken mislukt — probeer het straks nog eens.";
      }
    },
    (err) => {
      statusEl.textContent = "Kon je locatie niet ophalen: " + (err.message || "toestemming geweigerd.");
    },
    { enableHighAccuracy: false, timeout: 15000 }
  );
}

async function fetchNearbyRestaurants(lat, lon) {
  const radius = 1500; // meter
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="restaurant"](around:${radius},${lat},${lon});
      way["amenity"="restaurant"](around:${radius},${lat},${lon});
    );
    out center tags;
  `;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: query
  });
  if (!r.ok) throw new Error("Overpass API-fout");
  const data = await r.json();

  return (data.elements || [])
    .map(el => {
      const tags = el.tags || {};
      const elLat = el.lat ?? el.center?.lat;
      const elLon = el.lon ?? el.center?.lon;
      if (!tags.name || elLat == null || elLon == null) return null;
      return {
        name: tags.name,
        cuisine: tags.cuisine ? tags.cuisine.replace(/_/g, " ") : "",
        openingHours: tags.opening_hours || "",
        address: [tags["addr:street"], tags["addr:housenumber"]].filter(Boolean).join(" "),
        website: normalizeWebsiteUrl(
          tags.website || tags["contact:website"] || tags["website:menu"] || tags.url || ""
        ),
        lat: elLat,
        lon: elLon,
        distance: haversineDistanceMeters(lat, lon, elLat, elLon)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);
}

function renderRestaurants(restaurants, userLat, userLon) {
  const statusEl = document.getElementById("restaurants-status");
  const emptyEl = document.getElementById("restaurants-empty");
  const listEl = document.getElementById("restaurant-list");

  listEl.innerHTML = "";

  if (restaurants.length === 0) {
    statusEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    emptyEl.querySelector(".empty-title").textContent = "Niets gevonden";
    emptyEl.querySelector(".empty-copy").textContent = "Geen restaurants gevonden binnen 1,5 km van je locatie.";
    return;
  }

  statusEl.classList.add("hidden");
  emptyEl.classList.add("hidden");

  restaurants.slice(0, 40).forEach(r => {
    const li = document.createElement("li");
    li.className = "restaurant-row";
    li.style.cursor = "pointer";
    const distanceLabel = r.distance < 1000
      ? `${Math.round(r.distance)} m`
      : `${(r.distance / 1000).toFixed(1)} km`;
    li.innerHTML = `
      <div class="restaurant-top">
        <span class="restaurant-name">${escapeHtml(r.name)}</span>
        <span class="restaurant-distance">${distanceLabel}</span>
      </div>
      ${r.cuisine ? `<div class="restaurant-cuisine">${escapeHtml(r.cuisine)}</div>` : ""}
      <div class="restaurant-hours">${r.openingHours ? escapeHtml(r.openingHours) : "Openingstijden onbekend"}</div>
      <div class="restaurant-meta">Tik voor route</div>
      ${r.address ? `<div class="restaurant-address">${escapeHtml(r.address)}</div>` : ""}
      ${r.website ? `<a class="restaurant-website" href="${escapeHtml(r.website)}" target="_blank" rel="noopener">Website openen</a>` : ""}
    `;
    li.addEventListener("click", () => {
      const url = `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lon}`;
      window.open(url, "_blank");
    });
    const websiteLink = li.querySelector(".restaurant-website");
    if (websiteLink) websiteLink.addEventListener("click", (e) => e.stopPropagation());
    listEl.appendChild(li);
  });
}

function renderEvents() {
  const list = document.getElementById("event-list");
  const empty = document.getElementById("calendar-empty");
  const filtered = state.events.filter(e => !state.activeCalendarAccountFilter || e.accountEmail === state.activeCalendarAccountFilter);
  list.innerHTML = "";
  empty.classList.toggle("hidden", filtered.length > 0);

  let lastDay = "";
  filtered.forEach(ev => {
    const dayKey = new Date(ev.start).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long" });
    if (dayKey !== lastDay) {
      const heading = document.createElement("li");
      heading.className = "event-day-heading";
      heading.textContent = dayKey;
      list.appendChild(heading);
      lastDay = dayKey;
    }
    const li = document.createElement("li");
    li.className = "event-row";
    li.style.borderLeftColor = ev.accountColor;
    const timeLabel = ev.allDay
      ? "Hele dag"
      : `${new Date(ev.start).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })} – ${new Date(ev.end).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })}`;
    li.innerHTML = `
      <div class="event-time">${timeLabel}</div>
      <div class="event-title">${escapeHtml(ev.title)}</div>
      <div class="event-meta">${escapeHtml(ev.location || ev.accountEmail)}</div>
    `;
    li.addEventListener("click", () => openEventModal("edit", ev));
    list.appendChild(li);
  });
}

let activeEditEvent = null;

function toLocalInputValue(timestamp) {
  const d = new Date(timestamp);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openEventModal(mode, ev, prefill) {
  const connected = state.accounts.filter(a => a.token);
  if (connected.length === 0) { alert("Verbind eerst een account voordat je een afspraak kunt maken."); return; }

  activeEditEvent = mode === "edit" ? ev : null;
  document.getElementById("event-modal-title").textContent = mode === "edit" ? "Afspraak bewerken" : "Nieuwe afspraak";
  document.getElementById("event-delete").classList.toggle("hidden", mode !== "edit");

  const accountSelect = document.getElementById("event-account");
  accountSelect.innerHTML = connected.map(a => `<option value="${a.email}">${a.email}</option>`).join("");

  if (mode === "edit") {
    accountSelect.value = ev.accountEmail;
    document.getElementById("event-title").value = ev.title;
    document.getElementById("event-allday").checked = ev.allDay;
    document.getElementById("event-start").value = toLocalInputValue(ev.start);
    document.getElementById("event-end").value = toLocalInputValue(ev.end);
    document.getElementById("event-location").value = ev.location;
    document.getElementById("event-description").value = ev.description;
    document.getElementById("event-guests").value = (ev.attendees || []).join(", ");
  } else if (prefill) {
    document.getElementById("event-title").value = prefill.title || "";
    document.getElementById("event-allday").checked = false;
    document.getElementById("event-start").value = prefill.start || "";
    document.getElementById("event-end").value = prefill.end || "";
    document.getElementById("event-location").value = prefill.location || "";
    document.getElementById("event-description").value = prefill.description || "";
    document.getElementById("event-guests").value = "";
  } else {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    now.setHours(now.getHours() + 1);
    const later = new Date(now.getTime() + 60 * 60 * 1000);
    document.getElementById("event-title").value = "";
    document.getElementById("event-allday").checked = false;
    document.getElementById("event-start").value = toLocalInputValue(now.getTime());
    document.getElementById("event-end").value = toLocalInputValue(later.getTime());
    document.getElementById("event-location").value = "";
    document.getElementById("event-description").value = "";
    document.getElementById("event-guests").value = "";
  }

  document.getElementById("event-travel-advice").classList.add("hidden");
  document.getElementById("event-modal").classList.remove("hidden");
  lastAdviceCoords = null;
  lastAdviceComputeTime = 0;
  startLiveLocationWatch();
  if (document.getElementById("event-start").value && document.getElementById("event-location").value.trim()) {
    clearTimeout(travelAdviceTimer);
    travelAdviceTimer = setTimeout(updateTravelAdvice, 400);
  }
}

function wireEventModal() {
  const modal = document.getElementById("event-modal");
  document.getElementById("event-cancel").addEventListener("click", () => {
    modal.classList.add("hidden");
    stopLiveLocationWatch();
  });

  document.getElementById("event-save").addEventListener("click", () => {
    const accountEmail = document.getElementById("event-account").value;
    const title = document.getElementById("event-title").value.trim();
    const allDay = document.getElementById("event-allday").checked;
    const startVal = document.getElementById("event-start").value;
    const endVal = document.getElementById("event-end").value;
    const location = document.getElementById("event-location").value.trim();
    const description = document.getElementById("event-description").value.trim();
    const guests = document.getElementById("event-guests").value.split(",").map(s => s.trim()).filter(Boolean);

    if (!title || !startVal || !endVal) { alert("Vul minstens een titel, begin- en eindtijd in."); return; }

    const data = {
      title, allDay,
      start: allDay ? startVal.slice(0, 10) : startVal,
      end: allDay ? endVal.slice(0, 10) : endVal,
      location, description, guests
    };

    if (activeEditEvent) updateEvent(accountEmail, activeEditEvent.id, data);
    else createEvent(accountEmail, data);
    modal.classList.add("hidden");
    stopLiveLocationWatch();
  });

  document.getElementById("event-delete").addEventListener("click", () => {
    if (!activeEditEvent) return;
    if (!confirm("Deze afspraak verwijderen?")) return;
    deleteEvent(activeEditEvent.accountEmail, activeEditEvent.id);
    modal.classList.add("hidden");
    stopLiveLocationWatch();
  });

  wireEventRoutePanel();
  wireTravelAdvice();
}

/* ---------------- Automatisch reisadvies (auto + trein) ---------------- */

let cachedUserPosition = null;
let travelAdviceTimer = null;
let liveLocationWatchId = null;
let lastAdviceCoords = null;
let lastAdviceComputeTime = 0;

function getUserPositionOnce() {
  return new Promise(async (resolve, reject) => {
    if (state.fixedOrigin) {
      try {
        if (!fixedOriginCoordsCache) {
          const geo = await geocodeAddress(state.fixedOrigin);
          if (!geo) { reject(new Error("Kon het vaste vertrekadres niet vinden.")); return; }
          fixedOriginCoordsCache = { latitude: geo.lat, longitude: geo.lon };
        }
        resolve(fixedOriginCoordsCache);
      } catch (e) { reject(e); }
      return;
    }
    if (cachedUserPosition) { resolve(cachedUserPosition); return; }
    if (!("geolocation" in navigator)) { reject(new Error("Geen locatie beschikbaar")); return; }
    navigator.geolocation.getCurrentPosition(
      (position) => { cachedUserPosition = position.coords; resolve(cachedUserPosition); },
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 25000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

function startLiveLocationWatch() {
  if (state.fixedOrigin) return; // vast adres ingesteld — geen GPS nodig
  if (liveLocationWatchId !== null || !("geolocation" in navigator)) return;
  liveLocationWatchId = navigator.geolocation.watchPosition(
    (position) => {
      cachedUserPosition = position.coords;

      const modalOpen = !document.getElementById("event-modal").classList.contains("hidden");
      const hasInput = document.getElementById("event-start").value && document.getElementById("event-location").value.trim();
      if (!modalOpen || !hasInput) return;

      const movedFar = !lastAdviceCoords
        || haversineDistanceMeters(lastAdviceCoords.latitude, lastAdviceCoords.longitude, position.coords.latitude, position.coords.longitude) > 150;
      const longEnoughAgo = Date.now() - lastAdviceComputeTime > 20000;

      if (movedFar && longEnoughAgo) {
        lastAdviceCoords = position.coords;
        lastAdviceComputeTime = Date.now();
        updateTravelAdvice();
      }
    },
    (err) => console.error("Live locatie volgen mislukt", err),
    { enableHighAccuracy: false, maximumAge: 60000, timeout: 25000 }
  );
}

function stopLiveLocationWatch() {
  if (liveLocationWatchId !== null) {
    navigator.geolocation.clearWatch(liveLocationWatchId);
    liveLocationWatchId = null;
  }
}

function wireTravelAdvice() {
  const startInput = document.getElementById("event-start");
  const locationInput = document.getElementById("event-location");

  const trigger = () => {
    clearTimeout(travelAdviceTimer);
    travelAdviceTimer = setTimeout(updateTravelAdvice, 700);
  };
  startInput.addEventListener("change", trigger);
  locationInput.addEventListener("change", trigger);
  locationInput.addEventListener("blur", trigger);
}

async function updateTravelAdvice() {
  const box = document.getElementById("event-travel-advice");
  const startVal = document.getElementById("event-start").value;
  const destination = document.getElementById("event-location").value.trim();

  if (!startVal || !destination) { box.classList.add("hidden"); box.innerHTML = ""; return; }

  const eventStart = new Date(startVal);
  if (isNaN(eventStart.getTime())) { box.classList.add("hidden"); return; }

  box.classList.remove("hidden");
  box.innerHTML = "Reisadvies wordt berekend...";

  try {
    const coords = await getUserPositionOnce();
    const { latitude, longitude } = coords;

    const geoResult = await geocodeAddress(destination);
    if (!geoResult) { box.innerHTML = "Kon de locatie van de afspraak niet herkennen als adres — reisadvies niet mogelijk."; return; }
    const destLat = geoResult.lat;
    const destLon = geoResult.lon;

    const lines = [];

    // --- Auto ---
    try {
      const routeR = await fetch(`https://router.project-osrm.org/route/v1/driving/${longitude},${latitude};${destLon},${destLat}?overview=false`);
      const routeData = await routeR.json();
      const route = routeData.routes?.[0];
      if (route) {
        const minutes = Math.round(route.duration / 60);
        const departBy = new Date(eventStart.getTime() - route.duration * 1000);
        const departFmt = departBy.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
        lines.push(`🚗 <b>Auto</b>: vertrek uiterlijk ${departFmt} (${minutes} min rijden) om op tijd te zijn.`);
      }
    } catch (e) { console.error("Autoadvies mislukt", e); }

    // --- Trein ---
    if (state.nsApiKey) {
      try {
        await ensureStationsLoaded();
        const fromStation = findNearestStation(latitude, longitude);
        const toStation = findNearestStation(destLat, destLon);
        if (fromStation && toStation && fromStation.code !== toStation.code) {
          const params = new URLSearchParams({
            fromStation: fromStation.code,
            toStation: toStation.code,
            dateTime: eventStart.toISOString(),
            searchForArrival: "true"
          });
          const r = await fetch(`https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/trips?${params.toString()}`, {
            headers: { "Ocp-Apim-Subscription-Key": state.nsApiKey }
          });
          if (r.ok) {
            const data = await r.json();
            const best = (data.trips || [])[data.trips.length - 1];
            if (best) {
              const firstLeg = best.legs?.[0];
              const lastLeg = best.legs?.[best.legs.length - 1];
              const depTime = firstLeg?.origin?.actualDateTime || firstLeg?.origin?.plannedDateTime;
              const arrTime = lastLeg?.destination?.actualDateTime || lastLeg?.destination?.plannedDateTime;
              const depFmt = depTime ? new Date(depTime).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";
              const arrFmt = arrTime ? new Date(arrTime).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";
              const transfers = Math.max((best.legs?.length || 1) - 1, 0);
              lines.push(`🚆 <b>Trein</b>: ${fromStation.name} ${depFmt} → ${toStation.name} ${arrFmt}${transfers > 0 ? ` (${transfers} overstap${transfers > 1 ? "pen" : ""})` : " (rechtstreeks)"}.`);
            } else {
              lines.push(`🚆 <b>Trein</b>: geen passende reis gevonden.`);
            }
          }
        } else if (fromStation && toStation) {
          lines.push(`🚆 <b>Trein</b>: dichtstbijzijnde station is al hetzelfde als bij de bestemming.`);
        }
      } catch (e) { console.error("Treinadvies mislukt", e); }
    } else {
      lines.push(`🚆 <b>Trein</b>: vul een NS API-sleutel in bij Instellingen om dit advies te zien.`);
    }

    box.innerHTML = lines.length
      ? lines.map(l => `<div style="margin-bottom:6px;">${l}</div>`).join("")
      : "Geen reisadvies beschikbaar.";
  } catch (e) {
    console.error("Reisadvies mislukt", e);
    box.innerHTML = "Kon geen reisadvies berekenen (locatietoegang nodig).";
  }
}

function wireEventRoutePanel() {
  const panel = document.getElementById("event-route-panel");
  const trainForm = document.getElementById("event-route-train-form");
  const ovForm = document.getElementById("event-route-ov-form");
  const carForm = document.getElementById("event-route-car-form");

  document.getElementById("event-route-toggle").addEventListener("click", () => {
    panel.classList.toggle("hidden");
  });

  document.getElementById("event-route-train-btn").addEventListener("click", () => {
    trainForm.classList.remove("hidden");
    ovForm.classList.add("hidden");
    carForm.classList.add("hidden");
  });
  document.getElementById("event-route-ov-btn").addEventListener("click", () => {
    ovForm.classList.remove("hidden");
    trainForm.classList.add("hidden");
    carForm.classList.add("hidden");
  });
  document.getElementById("event-route-car-btn").addEventListener("click", () => {
    carForm.classList.remove("hidden");
    trainForm.classList.add("hidden");
    ovForm.classList.add("hidden");
  });

  document.getElementById("event-route-train-search-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("event-route-train-status");
    const listEl = document.getElementById("event-route-train-results");
    listEl.innerHTML = "";

    if (!state.nsApiKey) { statusEl.classList.remove("hidden"); statusEl.textContent = "Vul eerst je NS API-sleutel in bij Instellingen."; return; }

    const fromName = document.getElementById("event-route-train-from").value.trim();
    const toName = document.getElementById("event-route-train-to").value.trim();
    if (!fromName || !toName) { statusEl.classList.remove("hidden"); statusEl.textContent = "Vul zowel Van als Naar in."; return; }

    statusEl.classList.remove("hidden");
    statusEl.textContent = "Zoeken...";

    await ensureStationsLoaded();
    const fromCode = findStationCode(fromName);
    const toCode = findStationCode(toName);
    if (!fromCode || !toCode) { statusEl.textContent = "Kon een van de stations niet herkennen."; return; }

    // Gebruik de starttijd van de afspraak als vertrekmoment.
    const eventStart = document.getElementById("event-start").value;
    const dateTimeIso = eventStart ? new Date(eventStart).toISOString() : new Date().toISOString();

    try {
      const trips = await fetchNsTripsRaw(fromCode, toCode, dateTimeIso);
      statusEl.classList.add("hidden");
      if (trips.length === 0) { statusEl.classList.remove("hidden"); statusEl.textContent = "Geen reizen gevonden."; return; }

      trips.slice(0, 5).forEach(trip => {
        const firstLeg = trip.legs?.[0];
        const lastLeg = trip.legs?.[trip.legs.length - 1];
        const depTime = firstLeg?.origin?.actualDateTime || firstLeg?.origin?.plannedDateTime;
        const arrTime = lastLeg?.destination?.actualDateTime || lastLeg?.destination?.plannedDateTime;
        const depFmt = depTime ? new Date(depTime).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";
        const arrFmt = arrTime ? new Date(arrTime).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";
        const transfers = Math.max((trip.legs?.length || 1) - 1, 0);
        const platform = firstLeg?.origin?.actualTrack || firstLeg?.origin?.plannedTrack || "?";

        const li = document.createElement("li");
        li.className = "restaurant-row";
        li.innerHTML = `
          <div class="restaurant-top">
            <span class="restaurant-name">${depFmt} → ${arrFmt}</span>
            <span class="restaurant-distance">spoor ${escapeHtml(String(platform))}</span>
          </div>
          <div class="restaurant-cuisine">${transfers === 0 ? "Rechtstreeks" : `${transfers} overstap${transfers > 1 ? "pen" : ""}`}</div>
          <button type="button" class="btn-ghost small use-route-btn" style="margin-top:6px; width:auto;">Gebruik deze reis</button>
        `;
        li.querySelector(".use-route-btn").addEventListener("click", () => {
          const routeText = `Route: trein ${fromName} → ${toName}, vertrek ${depFmt}, aankomst ${arrFmt}, spoor ${platform}${transfers > 0 ? `, ${transfers} overstap${transfers > 1 ? "pen" : ""}` : ""}.`;
          const descEl = document.getElementById("event-description");
          descEl.value = descEl.value ? `${descEl.value}\n\n${routeText}` : routeText;
          panel.classList.add("hidden");
        });
        listEl.appendChild(li);
      });
    } catch (e) {
      console.error("Route zoeken (trein) mislukt", e);
      statusEl.classList.remove("hidden");
      statusEl.textContent = "Zoeken mislukt.";
    }
  });

  document.getElementById("event-route-ov-search-btn").addEventListener("click", () => {
    const statusEl = document.getElementById("event-route-ov-status");
    const listEl = document.getElementById("event-route-ov-results");
    listEl.innerHTML = "";

    if (!("geolocation" in navigator)) { statusEl.classList.remove("hidden"); statusEl.textContent = "Locatie niet beschikbaar."; return; }

    statusEl.classList.remove("hidden");
    statusEl.textContent = "Je locatie wordt opgevraagd...";

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { latitude, longitude } = position.coords;
        statusEl.textContent = "Haltes zoeken...";
        await ensureOvStopsLoaded();
        if (!ovStopsCache) { statusEl.textContent = "Kon de haltelijst niet ophalen."; return; }

        const nearest = ovStopsCache
          .map(s => ({ ...s, distance: haversineDistanceMeters(latitude, longitude, s.lat, s.lon) }))
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 3);

        statusEl.textContent = "Vertrektijden ophalen...";
        const perStop = await Promise.all(nearest.map(async (stop) => ({ stop, passes: await fetchOvDepartures(stop.code) })));

        statusEl.classList.add("hidden");
        let any = false;
        perStop.forEach(({ stop, passes }) => {
          passes.forEach(p => {
            any = true;
            const time = p.ExpectedDepartureTime || p.TargetDepartureTime;
            const timeFmt = time ? new Date(time).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" }) : "?";

            const li = document.createElement("li");
            li.className = "restaurant-row";
            li.innerHTML = `
              <div class="restaurant-top">
                <span class="restaurant-name">${escapeHtml(p.LinePublicNumber || "")} → ${escapeHtml(p.DestinationName50 || "?")}</span>
                <span class="restaurant-distance">${timeFmt}</span>
              </div>
              <div class="restaurant-cuisine">${escapeHtml(stop.name)}</div>
              <button type="button" class="btn-ghost small use-route-btn" style="margin-top:6px; width:auto;">Gebruik deze rit</button>
            `;
            li.querySelector(".use-route-btn").addEventListener("click", () => {
              const routeText = `Route: lijn ${p.LinePublicNumber || ""} richting ${p.DestinationName50 || "?"}, vertrek ${timeFmt} vanaf ${stop.name}.`;
              const descEl = document.getElementById("event-description");
              descEl.value = descEl.value ? `${descEl.value}\n\n${routeText}` : routeText;
              panel.classList.add("hidden");
            });
            listEl.appendChild(li);
          });
        });
        if (!any) { statusEl.classList.remove("hidden"); statusEl.textContent = "Geen vertrektijden gevonden."; }
      },
      (err) => {
        statusEl.textContent = "Kon je locatie niet ophalen: " + (err.message || "toestemming geweigerd.");
      },
      { enableHighAccuracy: false, timeout: 15000 }
    );
  });

  document.getElementById("event-route-car-search-btn").addEventListener("click", async () => {
    const statusEl = document.getElementById("event-route-car-status");
    const listEl = document.getElementById("event-route-car-results");
    listEl.innerHTML = "";

    const fromAddress = document.getElementById("event-route-car-from").value.trim();
    const destination = document.getElementById("event-route-car-to").value.trim();
    if (!destination) { statusEl.classList.remove("hidden"); statusEl.textContent = "Vul een bestemming in."; return; }

    statusEl.classList.remove("hidden");
    statusEl.textContent = fromAddress ? "Vertrekadres zoeken..." : "Je locatie wordt opgevraagd...";

    try {
      const origin = await resolveOrigin(fromAddress);
      statusEl.textContent = "Bestemming zoeken...";
      const geoResult = await geocodeAddress(destination);
      if (!geoResult) { statusEl.textContent = "Kon dit adres niet vinden."; return; }
      const destLat = geoResult.lat;
      const destLon = geoResult.lon;

      statusEl.textContent = "Reistijd berekenen...";
      const routeR = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${origin.longitude},${origin.latitude};${destLon},${destLat}?overview=false`
      );
      const routeData = await routeR.json();
      const route = routeData.routes?.[0];
      if (!route) { statusEl.textContent = "Kon geen route berekenen."; return; }

      const minutes = Math.round(route.duration / 60);
      const km = (route.distance / 1000).toFixed(1);

      statusEl.classList.add("hidden");
      const li = document.createElement("li");
      li.className = "restaurant-row";
      li.innerHTML = `
        <div class="restaurant-top">
          <span class="restaurant-name">Auto naar ${escapeHtml(destination)}</span>
          <span class="restaurant-distance">${minutes} min</span>
        </div>
        <div class="restaurant-cuisine">${km} km</div>
        <button type="button" class="btn-ghost small use-route-btn" style="margin-top:6px; width:auto;">Gebruik deze route</button>
      `;
      li.querySelector(".use-route-btn").addEventListener("click", () => {
        const routeText = `Route: auto naar ${destination}, geschatte reistijd ${minutes} min (${km} km).`;
        const descEl = document.getElementById("event-description");
        descEl.value = descEl.value ? `${descEl.value}\n\n${routeText}` : routeText;
        panel.classList.add("hidden");
      });
      listEl.appendChild(li);
    } catch (e) {
      console.error("Autoroute berekenen mislukt", e);
      statusEl.textContent = e.message || "Berekenen mislukt.";
    }
  });
}

/* ---------------- Helpers ---------------- */

function stripAngle(from) { return from.replace(/<.*>/, "").trim() || from; }

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* ---------------- Navigation ---------------- */

function wireNav() {
  document.querySelectorAll(".tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const view = tab.dataset.view;
      state.activeView = view;
      document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));

      if (view === "archive") {
        // "Archief" is geen aparte weergave — het is de Postvak IN-weergave
        // met de map ARCHIVE geselecteerd (Gmail heeft geen los archiefvak,
        // "gearchiveerd" betekent daar simpelweg "geen INBOX-label meer").
        document.getElementById("view-inbox").classList.remove("hidden");
        state.activeFolder = "ARCHIVE";
        state.messages = [];
        renderFolderChips();
        renderMessages();
        refreshInbox();
      } else if (view === "inbox") {
        document.getElementById("view-inbox").classList.remove("hidden");
        if (state.activeFolder === "ARCHIVE") {
          state.activeFolder = "INBOX";
          state.messages = [];
          renderFolderChips();
          renderMessages();
          refreshInbox();
        }
      } else {
        document.getElementById(`view-${view}`).classList.remove("hidden");
      }
    });
  });
}

function wireSearch() {
  document.getElementById("search-input").addEventListener("input", (e) => {
    state.searchQuery = e.target.value.trim();
    renderMessages();
  });
}

/* ---------------- Rule modal ---------------- */

function wireRuleModal() {
  const modal = document.getElementById("rule-modal");
  const actionSelect = document.getElementById("rule-action");
  const valueLabel = document.getElementById("rule-action-value-label");
  const valueWrap = document.getElementById("rule-action-value-wrap");

  document.getElementById("add-rule-btn").addEventListener("click", () => {
    document.getElementById("rule-from").value = "";
    document.getElementById("rule-subject").value = "";
    document.getElementById("rule-action-value").value = "";
    actionSelect.value = "archive";
    updateActionValueVisibility();
    modal.classList.remove("hidden");
  });

  document.getElementById("rule-cancel").addEventListener("click", () => modal.classList.add("hidden"));

  actionSelect.addEventListener("change", updateActionValueVisibility);
  function updateActionValueVisibility() {
    if (actionSelect.value === "archive" || actionSelect.value === "trash") valueWrap.classList.add("hidden");
    else {
      valueWrap.classList.remove("hidden");
      valueLabel.textContent = actionSelect.value === "label" ? "Label naam" : "Auto-reply tekst";
    }
  }

  document.getElementById("rule-save").addEventListener("click", () => {
    const from = document.getElementById("rule-from").value.trim();
    const subject = document.getElementById("rule-subject").value.trim();
    const action = actionSelect.value;
    const actionValue = document.getElementById("rule-action-value").value.trim();
    if (!from && !subject) { alert("Vul minstens één voorwaarde in (afzender of onderwerp)."); return; }
    state.rules.push({ from, subject, action, actionValue });
    persistRules();
    renderRules();
    modal.classList.add("hidden");
  });
}

/* ---------------- Detail modal wiring ---------------- */

function wireDetailModal() {
  const modal = document.getElementById("detail-modal");
  document.getElementById("detail-close").addEventListener("click", () => modal.classList.add("hidden"));

  document.getElementById("detail-archive").addEventListener("click", () => {
    if (!activeDetailMessage) return;
    archiveMessage(activeDetailMessage.id);
    modal.classList.add("hidden");
  });
  document.getElementById("detail-trash").addEventListener("click", () => {
    if (!activeDetailMessage) return;
    trashMessage(activeDetailMessage.id);
    modal.classList.add("hidden");
  });
  document.getElementById("detail-snooze-toggle").addEventListener("click", () => {
    document.getElementById("detail-snooze-options").classList.toggle("hidden");
  });
  document.querySelectorAll("#detail-snooze-options button").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!activeDetailMessage) return;
      snoozeMessage(activeDetailMessage.id, snoozeUntilTimestamp(btn.dataset.snooze));
      modal.classList.add("hidden");
    });
  });
  document.getElementById("detail-reply-toggle").addEventListener("click", () => {
    document.getElementById("detail-reply-box").classList.toggle("hidden");
  });
  document.getElementById("detail-reply-send").addEventListener("click", async () => {
    if (!activeDetailMessage) return;
    const text = document.getElementById("detail-reply-text").value.trim();
    if (!text) return;
    await sendReply(activeDetailMessage, text);
    document.getElementById("detail-reply-text").value = "";
    document.getElementById("detail-reply-box").classList.add("hidden");
    modal.classList.add("hidden");
  });
}

/* ---------------- Instellingen ---------------- */

function persistAddressAliases() {
  localStorage.setItem("postbus:addressAliases", JSON.stringify(state.addressAliases));
}

function renderAddressAliases() {
  const list = document.getElementById("address-aliases-list");
  list.innerHTML = "";
  Object.entries(state.addressAliases).forEach(([name, address]) => {
    const li = document.createElement("li");
    li.className = "rule-row";
    li.innerHTML = `
      <div class="rule-summary"><b>${escapeHtml(name)}</b> → ${escapeHtml(address)}</div>
      <button class="btn-ghost small alias-delete-btn" style="width:auto;">✕</button>
    `;
    li.querySelector(".alias-delete-btn").addEventListener("click", () => {
      delete state.addressAliases[name];
      persistAddressAliases();
      renderAddressAliases();
    });
    list.appendChild(li);
  });
}

function wireAddressAliases() {
  renderAddressAliases();
  document.getElementById("alias-add-btn").addEventListener("click", () => {
    const nameInput = document.getElementById("alias-name-input");
    const addressInput = document.getElementById("alias-address-input");
    const name = nameInput.value.trim();
    const address = addressInput.value.trim();
    if (!name || !address) { alert("Vul zowel een naam als een adres in."); return; }

    state.addressAliases[name.toLowerCase()] = address;
    persistAddressAliases();
    renderAddressAliases();
    nameInput.value = "";
    addressInput.value = "";
  });
}

function wireSettings() {
  wireAddressAliases();

  const pollSelect = document.getElementById("setting-poll-interval");
  const fetchSelect = document.getElementById("setting-fetch-count");
  const categorizeToggle = document.getElementById("setting-categorize");
  const swipeRightSelect = document.getElementById("setting-swipe-right");
  const swipeLeftSelect = document.getElementById("setting-swipe-left");
  const notificationsToggle = document.getElementById("setting-notifications");
  const msClientIdInput = document.getElementById("setting-ms-client-id");

  msClientIdInput.value = state.msClientId;
  msClientIdInput.addEventListener("change", () => {
    state.msClientId = msClientIdInput.value.trim();
    localStorage.setItem("postbus:msClientId", state.msClientId);
    msalInstance = null; // opnieuw aanmaken met de nieuwe Client ID
  });

  const nsApiKeyInput = document.getElementById("setting-ns-api-key");
  nsApiKeyInput.value = state.nsApiKey;
  nsApiKeyInput.addEventListener("change", () => {
    state.nsApiKey = nsApiKeyInput.value.trim();
    localStorage.setItem("postbus:nsApiKey", state.nsApiKey);
    nsStationsCache = null; // opnieuw ophalen met de nieuwe sleutel
  });

  const fixedOriginInput = document.getElementById("setting-fixed-origin");
  fixedOriginInput.value = state.fixedOrigin;
  fixedOriginInput.addEventListener("change", () => {
    state.fixedOrigin = fixedOriginInput.value.trim();
    localStorage.setItem("postbus:fixedOrigin", state.fixedOrigin);
    fixedOriginCoordsCache = null; // opnieuw geocoderen met het nieuwe adres
  });

  pollSelect.value = String(state.settings.pollIntervalMinutes);
  fetchSelect.value = String(state.settings.fetchCount);
  categorizeToggle.checked = state.settings.categorize;
  swipeRightSelect.value = state.settings.swipeRight;
  swipeLeftSelect.value = state.settings.swipeLeft;
  notificationsToggle.checked = state.settings.notifications;

  pollSelect.addEventListener("change", () => {
    state.settings.pollIntervalMinutes = parseInt(pollSelect.value, 10);
    persistSettings();
    startPolling();
  });
  fetchSelect.addEventListener("change", () => {
    state.settings.fetchCount = parseInt(fetchSelect.value, 10);
    persistSettings();
  });
  categorizeToggle.addEventListener("change", () => {
    state.settings.categorize = categorizeToggle.checked;
    persistSettings();
    renderCategoryChips();
    renderMessages();
  });
  swipeRightSelect.addEventListener("change", () => {
    state.settings.swipeRight = swipeRightSelect.value;
    persistSettings();
    renderMessages();
  });
  swipeLeftSelect.addEventListener("change", () => {
    state.settings.swipeLeft = swipeLeftSelect.value;
    persistSettings();
    renderMessages();
  });
  notificationsToggle.addEventListener("change", async () => {
    if (notificationsToggle.checked && "Notification" in window) {
      const perm = await Notification.requestPermission();
      notificationsToggle.checked = perm === "granted";
    }
    state.settings.notifications = notificationsToggle.checked;
    persistSettings();
  });

  document.getElementById("reset-app-btn").addEventListener("click", () => {
    if (!confirm("Weet je zeker dat je alles wilt wissen? Dit verwijdert je accounts, regels en instellingen uit deze browser.")) return;
    localStorage.clear();
    location.reload();
  });

  wireCleanupModal();
  wireWebshopSettings();
  wireBulkNameCleanup();
}

function wireBulkNameCleanup() {
  const input = document.getElementById("bulk-name-input");
  const statusEl = document.getElementById("bulk-name-status");
  const resultBox = document.getElementById("bulk-name-result");
  const countEl = document.getElementById("bulk-name-count");

  // Bewaart de al-gevonden id's per account tussen 'Zoeken' en de
  // uiteindelijke actie, zodat er niet twee keer gezocht hoeft te worden.
  let foundName = "";
  let foundPerAccount = []; // [{ account, ids }]

  document.getElementById("bulk-name-search-btn").addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) { alert("Vul eerst een afzendernaam in, bijv. Zalando."); return; }
    const connected = state.accounts.filter(a => a.token);
    if (connected.length === 0) { alert("Verbind eerst minstens één account."); return; }

    resultBox.classList.add("hidden");
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Zoeken...";

    foundName = name;
    foundPerAccount = [];
    let total = 0;

    for (const account of connected) {
      statusEl.textContent = `Zoeken bij ${account.email}...`;
      try {
        const ids = await fetchMessageIdsByFromName(account, name);
        foundPerAccount.push({ account, ids });
        total += ids.length;
      } catch (e) {
        console.error("Zoeken op naam mislukt voor", account.email, e);
        foundPerAccount.push({ account, ids: [] });
      }
    }

    statusEl.classList.add("hidden");

    if (total === 0) {
      statusEl.classList.remove("hidden");
      statusEl.textContent = `Geen berichten gevonden van "${name}".`;
      return;
    }

    countEl.textContent = `${total} berichten gevonden van "${name}". Wat wil je ermee doen?`;
    resultBox.classList.remove("hidden");
  });

  document.getElementById("bulk-name-archive-btn").addEventListener("click", () => runBulkNameAction("archive"));
  document.getElementById("bulk-name-trash-btn").addEventListener("click", () => runBulkNameAction("trash"));

  async function runBulkNameAction(action) {
    resultBox.classList.add("hidden");
    statusEl.classList.remove("hidden");
    let total = 0;
    const perAccountLabels = [];

    for (const { account, ids } of foundPerAccount) {
      if (ids.length === 0) continue;
      statusEl.textContent = `Bezig bij ${account.email}...`;
      try {
        await bulkModifyMessages(account, ids, action);
        total += ids.length;
        perAccountLabels.push(`${account.email}: ${ids.length}`);
      } catch (e) {
        console.error("Verwerken mislukt voor", account.email, e);
        perAccountLabels.push(`${account.email}: mislukt`);
      }
    }

    const actionLabel = action === "archive" ? "gearchiveerd" : "naar de prullenbak verplaatst";
    statusEl.textContent = `Klaar — ${total} berichten van "${foundName}" ${actionLabel}.\n` + perAccountLabels.join(" · ");

    if (state.activeFolder === "INBOX") refreshInbox();
  }
}

async function fetchMessageIdsByFromName(account, name) {
  if (account.provider === "microsoft") {
    const encoded = encodeURIComponent(`"from:${name}"`);
    const msgs = await fetchAllMicrosoftMessages(account, {
      select: "id",
      extraParams: `&$search=${encoded}`
    });
    return msgs.map(m => m.id);
  }

  const ids = [];
  let pageToken = null;
  let pages = 0;
  const q = `in:anywhere from:(${name})`;
  do {
    const params = new URLSearchParams({ q, maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
      { headers: { Authorization: `Bearer ${account.token}` } }
    );
    if (!r.ok) break;
    const data = await r.json();
    (data.messages || []).forEach(m => ids.push(m.id));
    pageToken = data.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < 10); // veiligheidsgrens: max 5000 berichten per account

  return ids;
}

function wireWebshopSettings() {
  const autoWebshopToggle = document.getElementById("setting-auto-webshop");
  autoWebshopToggle.checked = state.settings.autoWebshop;
  autoWebshopToggle.addEventListener("change", () => {
    state.settings.autoWebshop = autoWebshopToggle.checked;
    persistSettings();
  });

  const statusEl = document.getElementById("backfill-webshop-status");
  const resultBox = document.getElementById("backfill-webshop-result");
  const countEl = document.getElementById("backfill-webshop-count");

  let foundPerAccount = []; // [{ account, ids }]

  document.getElementById("backfill-webshop-search-btn").addEventListener("click", async () => {
    const connected = state.accounts.filter(a => a.token);
    if (connected.length === 0) { alert("Verbind eerst minstens één account."); return; }

    resultBox.classList.add("hidden");
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Zoeken...";

    foundPerAccount = [];
    let total = 0;
    for (const account of connected) {
      statusEl.textContent = `Zoeken bij ${account.email}...`;
      try {
        const ids = await findWebshopMessageIdsForAccount(account);
        foundPerAccount.push({ account, ids });
        total += ids.length;
      } catch (e) {
        console.error("Webshopmail zoeken mislukt voor", account.email, e);
        foundPerAccount.push({ account, ids: [] });
      }
    }

    statusEl.classList.add("hidden");
    if (total === 0) {
      statusEl.classList.remove("hidden");
      statusEl.textContent = "Geen webshopmail gevonden.";
      return;
    }
    countEl.textContent = `${total} berichten gevonden. Wat wil je ermee doen?`;
    resultBox.classList.remove("hidden");
  });

  document.getElementById("backfill-webshop-move-btn").addEventListener("click", () => runWebshopAction("move"));
  document.getElementById("backfill-webshop-trash-btn").addEventListener("click", () => runWebshopAction("trash"));

  async function runWebshopAction(action) {
    resultBox.classList.add("hidden");
    statusEl.classList.remove("hidden");
    let total = 0;
    const perAccountLabels = [];

    for (const { account, ids } of foundPerAccount) {
      if (ids.length === 0) continue;
      statusEl.textContent = `Bezig bij ${account.email}...`;
      try {
        if (action === "move") await applyWebshopMove(account, ids);
        else await bulkModifyMessages(account, ids, "trash");
        total += ids.length;
        perAccountLabels.push(`${account.email}: ${ids.length}`);
      } catch (e) {
        console.error("Verwerken mislukt voor", account.email, e);
        perAccountLabels.push(`${account.email}: mislukt`);
      }
    }

    const actionLabel = action === "move" ? "verplaatst naar Webshops" : "naar de prullenbak verplaatst";
    statusEl.textContent = `Klaar — ${total} berichten ${actionLabel}.\n` + perAccountLabels.join(" · ");

    if (state.activeFolder === "INBOX") refreshInbox();
  }
}

/* ---------------- Promotiemail opruimen (eenmalige bulkactie) ---------------- */

function wireCleanupModal() {
  const modal = document.getElementById("cleanup-modal");
  const searchRow = document.getElementById("cleanup-search-row");
  const choiceBox = document.getElementById("cleanup-choice");
  const countEl = document.getElementById("cleanup-count");
  const progressBox = document.getElementById("cleanup-progress");
  const resultBox = document.getElementById("cleanup-result");
  const statusEl = document.getElementById("cleanup-status");
  const resultEl = document.getElementById("cleanup-result-text");

  let foundPerAccount = []; // [{ account, ids }]

  document.getElementById("cleanup-promotions-btn").addEventListener("click", () => {
    searchRow.classList.remove("hidden");
    choiceBox.classList.add("hidden");
    progressBox.classList.add("hidden");
    resultBox.classList.add("hidden");
    modal.classList.remove("hidden");
  });

  document.getElementById("cleanup-close").addEventListener("click", () => modal.classList.add("hidden"));

  document.getElementById("cleanup-search-btn").addEventListener("click", async () => {
    const connected = state.accounts.filter(a => a.token);
    if (connected.length === 0) { alert("Verbind eerst minstens één account."); return; }

    searchRow.classList.add("hidden");
    progressBox.classList.remove("hidden");
    statusEl.textContent = "Zoeken...";

    foundPerAccount = [];
    let total = 0;
    for (const account of connected) {
      statusEl.textContent = `Zoeken bij ${account.email}...`;
      try {
        const ids = await fetchPromotionMessageIds(account);
        foundPerAccount.push({ account, ids });
        total += ids.length;
      } catch (e) {
        console.error("Zoeken mislukt voor", account.email, e);
        foundPerAccount.push({ account, ids: [] });
      }
    }

    progressBox.classList.add("hidden");
    if (total === 0) {
      searchRow.classList.remove("hidden");
      statusEl.classList.remove("hidden");
      progressBox.classList.remove("hidden");
      statusEl.textContent = "Geen promotiemail gevonden.";
      return;
    }
    countEl.textContent = `${total} berichten gevonden. Wat wil je ermee doen?`;
    choiceBox.classList.remove("hidden");
  });

  document.getElementById("cleanup-archive-btn").addEventListener("click", () => runCleanup("archive"));
  document.getElementById("cleanup-trash-btn").addEventListener("click", () => runCleanup("trash"));

  async function runCleanup(action) {
    choiceBox.classList.add("hidden");
    progressBox.classList.remove("hidden");
    resultBox.classList.add("hidden");

    let totalHandled = 0;
    const perAccountResults = [];

    for (const { account, ids } of foundPerAccount) {
      if (ids.length === 0) continue;
      statusEl.textContent = `Bezig bij ${account.email}...`;
      try {
        await bulkModifyMessages(account, ids, action);
        totalHandled += ids.length;
        perAccountResults.push(`${account.email}: ${ids.length}`);
      } catch (e) {
        console.error("Opruimen mislukt voor", account.email, e);
        perAccountResults.push(`${account.email}: mislukt`);
      }
    }

    progressBox.classList.add("hidden");
    resultBox.classList.remove("hidden");
    const actionLabel = action === "archive" ? "gearchiveerd" : "naar de prullenbak verplaatst";
    resultEl.textContent = `Klaar — ${totalHandled} berichten ${actionLabel}.\n` + perAccountResults.join(" · ");

    // Als de huidige map Postvak IN is, ververs de weergave.
    if (state.activeFolder === "INBOX") refreshInbox();
  }
}

async function fetchPromotionMessageIds(account) {
  if (account.provider === "microsoft") {
    // Outlook heeft geen "Promoties"-categorie zoals Gmail — als benadering
    // gebruiken we hetzelfde kenmerk als bij nieuwsbrieven: een
    // List-Unsubscribe-header (commerciële afzenders hebben die vrijwel
    // altijd, persoonlijke mail nooit).
    const msgs = await fetchAllMicrosoftMessages(account, {
      select: "id,subject,from,internetMessageHeaders"
    });
    return msgs
      .map(d => mapMicrosoftMessage(d, account))
      .filter(m => m.hasListUnsubscribe)
      .map(m => m.id);
  }

  const ids = [];
  let pageToken = null;
  let pages = 0;
  do {
    const params = new URLSearchParams({
      q: "category:promotions",
      maxResults: "500"
    });
    if (pageToken) params.set("pageToken", pageToken);

    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
      { headers: { Authorization: `Bearer ${account.token}` } }
    );
    if (!r.ok) break;
    const data = await r.json();
    (data.messages || []).forEach(m => ids.push(m.id));
    pageToken = data.nextPageToken || null;
    pages += 1;
  } while (pageToken && pages < 10); // veiligheidsgrens: max 5000 berichten per account per keer

  return ids;
}

async function bulkModifyMessages(account, ids, action) {
  if (account.provider === "microsoft") {
    const destinationId = action === "archive" ? "archive" : "deleteditems";
    await moveMicrosoftMessagesBulk(account, ids, destinationId);
    return;
  }

  const body = action === "archive"
    ? { removeLabelIds: ["INBOX"] }
    : { addLabelIds: ["TRASH"], removeLabelIds: ["INBOX", "UNREAD"] };

  // Gmail's batchModify accepteert maximaal 1000 id's per aanroep.
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: chunk, ...body })
    });
  }
}

/* ---------------- Polling ---------------- */

function startPolling() {
  if (state.pollHandle) clearInterval(state.pollHandle);
  const minutes = state.settings.pollIntervalMinutes;
  if (!minutes) return;
  state.pollHandle = setInterval(() => {
    if (state.accounts.some(a => a.token)) { refreshInbox(); refreshCalendar(); }
  }, minutes * 60 * 1000);
}

/* ---------------- Service worker ---------------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

initSetup();
