/* ============================================================
   Gmail Org — multi-account Gmail + Calendar control tower
   Alles draait client-side: geen eigen server, geen wachtwoorden
   opgeslagen. Tokens leven alleen in het geheugen van de sessie.
   ============================================================ */

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
const MS_FOLDER_MAP = { INBOX: "inbox", SENT: "sentitems", DRAFT: "drafts", TRASH: "deleteditems" };
const MS_SCOPES = ["Mail.Read", "Mail.ReadWrite", "Mail.Send", "User.Read"];
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
  wireRuleModal();
  wireDetailModal();
  wireComposeModal();
  wireEventModal();
  wireSettings();
  wireRestaurants();

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
    const listResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${count}&labelIds=${state.activeFolder}`,
      { headers: { Authorization: `Bearer ${account.token}` } }
    );
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

    return (data.value || []).map(d => {
      const fromAddr = d.from?.emailAddress?.address || "";
      const fromName = d.from?.emailAddress?.name || fromAddr;
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
        hasListUnsubscribe: false, // Graph API levert dit niet zonder extra aanroep
        labelIds: []
      };
      message.category = classifyMessage(message);
      return message;
    });
  } catch (e) {
    console.error("Fetch (Microsoft) mislukt voor", account.email, e);
    return [];
  }
}

/* ---------------- Webshopmail automatisch naar map verplaatsen ---------------- */

async function getOrCreateWebshopLabelId(account) {
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

async function autoMoveWebshopMail(connectedAccounts, messages) {
  for (const account of connectedAccounts) {
    if (account.provider === "microsoft") continue; // labels-systeem verschilt bij Outlook, nog niet ondersteund
    const labelId = state.webshopLabelIds[account.email] || await getOrCreateWebshopLabelId(account);
    if (!labelId) continue;

    const toMove = messages.filter(m =>
      m.accountEmail === account.email &&
      m.category === "webshop" &&
      !m.labelIds.includes(labelId)
    );
    if (toMove.length === 0) continue;

    await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: toMove.map(m => m.id),
        addLabelIds: [labelId],
        removeLabelIds: ["INBOX"]
      })
    });

    // Lokaal ook meteen uit Postvak IN halen, zodat het gelijk klopt in beeld.
    const movedIds = new Set(toMove.map(m => m.id));
    state.messages = state.messages.filter(m => !movedIds.has(m.id));
  }
}

/* ---------------- Oude webshopmail met terugwerkende kracht verplaatsen ---------------- */

async function backfillWebshopMail(onProgress) {
  const connected = state.accounts.filter(a => a.token && a.provider !== "microsoft");
  const results = [];

  for (const account of connected) {
    onProgress(`Bezig met ${account.email}...`);
    const labelId = await getOrCreateWebshopLabelId(account);
    if (!labelId) { results.push(`${account.email}: mislukt`); continue; }

    // Bouw een zoekopdracht op basis van de bekende domeinenlijst, in kleine
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

    const ids = [...idSet];
    for (let i = 0; i < ids.length; i += 1000) {
      const idsChunk = ids.slice(i, i + 1000);
      await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", {
        method: "POST",
        headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: idsChunk, addLabelIds: [labelId], removeLabelIds: ["INBOX"] })
      });
    }
    results.push(`${account.email}: ${ids.length}`);
  }

  if (state.activeFolder === "INBOX") refreshInbox();
  return results;
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

function extractBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64Url(payload.body.data);
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === "text/plain");
    if (plain && plain.body?.data) return decodeBase64Url(plain.body.data);
    const html = payload.parts.find(p => p.mimeType === "text/html");
    if (html && html.body?.data) return stripHtml(decodeBase64Url(html.body.data));
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  if (payload.mimeType === "text/html" && payload.body?.data) return stripHtml(decodeBase64Url(payload.body.data));
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
  const connected = state.accounts.filter(a => a.token && a.provider !== "microsoft");
  if (connected.length === 0) { state.events = []; renderEvents(); return; }

  const { timeMin, timeMax } = rangeBounds(state.activeRange);
  const results = await Promise.all(connected.map(a => fetchAccountEvents(a, timeMin, timeMax)));
  state.events = results.flat().sort((a, b) => a.start - b.start);
  renderEvents();
}

async function fetchAccountEvents(account, timeMin, timeMax) {
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

async function createEvent(accountEmail, data) {
  const account = state.accounts.find(a => a.email === accountEmail);
  if (!account || !account.token) return;
  await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildEventBody(data))
  });
  refreshCalendar();
}

async function updateEvent(accountEmail, eventId, data) {
  const account = state.accounts.find(a => a.email === accountEmail);
  if (!account || !account.token) return;
  await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildEventBody(data))
  });
  refreshCalendar();
}

async function deleteEvent(accountEmail, eventId) {
  const account = state.accounts.find(a => a.email === accountEmail);
  if (!account || !account.token) return;
  await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${account.token}` }
  });
  refreshCalendar();
}

function buildEventBody({ title, start, end, allDay, location, description, guests }) {
  const body = { summary: title, location, description };
  if (allDay) { body.start = { date: start }; body.end = { date: end }; }
  else { body.start = { dateTime: new Date(start).toISOString() }; body.end = { dateTime: new Date(end).toISOString() }; }
  if (guests && guests.length) body.attendees = guests.map(email => ({ email }));
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
    li.className = "message-row";
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
      <div class="message-row-inner">
        <div class="row-top">
          <span class="message-from">${escapeHtml(stripAngle(m.from))}${categoryPill}</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-subject">${escapeHtml(m.subject)}</div>
        <div class="message-snippet">${escapeHtml(m.snippet)}</div>
      </div>
    `;
    li.addEventListener("click", () => { if (li.dataset.swiping !== "1") openDetail(m); });
    wireSwipe(li, m.id);
    list.appendChild(li);
  });
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

  state.accounts.filter(a => a.provider !== "microsoft").forEach(a => {
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

function wireRestaurants() {
  document.getElementById("find-restaurants-btn").addEventListener("click", findNearbyRestaurants);
}

function normalizeWebsiteUrl(url) {
  if (!url) return "";
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
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

function openEventModal(mode, ev) {
  const connected = state.accounts.filter(a => a.token && a.provider !== "microsoft");
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

  document.getElementById("event-modal").classList.remove("hidden");
}

function wireEventModal() {
  const modal = document.getElementById("event-modal");
  document.getElementById("event-cancel").addEventListener("click", () => modal.classList.add("hidden"));

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
  });

  document.getElementById("event-delete").addEventListener("click", () => {
    if (!activeEditEvent) return;
    if (!confirm("Deze afspraak verwijderen?")) return;
    deleteEvent(activeEditEvent.accountEmail, activeEditEvent.id);
    modal.classList.add("hidden");
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
      document.getElementById(`view-${view}`).classList.remove("hidden");
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

function wireSettings() {
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
    const connected = state.accounts.filter(a => a.token && a.provider !== "microsoft");
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
  document.getElementById("backfill-webshop-btn").addEventListener("click", async () => {
    const connected = state.accounts.filter(a => a.token && a.provider !== "microsoft");
    if (connected.length === 0) { alert("Verbind eerst minstens één account."); return; }
    statusEl.classList.remove("hidden");
    statusEl.textContent = "Bezig...";
    const results = await backfillWebshopMail((msg) => { statusEl.textContent = msg; });
    statusEl.textContent = "Klaar — " + results.join(" · ");
  });
}

/* ---------------- Promotiemail opruimen (eenmalige bulkactie) ---------------- */

function wireCleanupModal() {
  const modal = document.getElementById("cleanup-modal");
  const choiceBox = document.getElementById("cleanup-choice");
  const progressBox = document.getElementById("cleanup-progress");
  const resultBox = document.getElementById("cleanup-result");
  const statusEl = document.getElementById("cleanup-status");
  const resultEl = document.getElementById("cleanup-result-text");

  document.getElementById("cleanup-promotions-btn").addEventListener("click", () => {
    choiceBox.classList.remove("hidden");
    progressBox.classList.add("hidden");
    resultBox.classList.add("hidden");
    modal.classList.remove("hidden");
  });

  document.getElementById("cleanup-close").addEventListener("click", () => modal.classList.add("hidden"));

  document.getElementById("cleanup-archive-btn").addEventListener("click", () => runCleanup("archive"));
  document.getElementById("cleanup-trash-btn").addEventListener("click", () => runCleanup("trash"));

  async function runCleanup(action) {
    const connected = state.accounts.filter(a => a.token && a.provider !== "microsoft");
    if (connected.length === 0) {
      alert("Verbind eerst minstens één account.");
      return;
    }
    choiceBox.classList.add("hidden");
    progressBox.classList.remove("hidden");
    resultBox.classList.add("hidden");

    let totalHandled = 0;
    const perAccountResults = [];

    for (const account of connected) {
      statusEl.textContent = `Bezig met ${account.email}...`;
      try {
        const ids = await fetchPromotionMessageIds(account);
        if (ids.length > 0) {
          await bulkModifyMessages(account, ids, action);
        }
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
