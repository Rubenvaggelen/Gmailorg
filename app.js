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
  notifications: false
};

const COLORS = ["#E0A458", "#6FA287", "#7B93D6", "#C97B7B", "#9C7BC9", "#6FB8B0"];
const CATEGORY_LABELS = { personal: "Persoonlijk", newsletter: "Nieuwsbrieven", notification: "Meldingen" };
const FOLDERS = { INBOX: "Postvak IN", SENT: "Verzonden", DRAFT: "Concepten", TRASH: "Prullenbak" };
const RANGE_LABELS = { today: "Vandaag", week: "Deze week", month: "Deze maand" };
const ACTION_LABELS = { archive: "Archiveren", trash: "Verwijderen", snooze1h: "Snoozen" };

const state = {
  clientId: "1057161054676-mg300mfsuca24ju7l84muia382nc84t6.apps.googleusercontent.com",
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
  activeFolder: "INBOX",
  searchQuery: "",
  activeView: "inbox",
  pollHandle: null
};

function persistAccounts() {
  localStorage.setItem("postbus:accounts", JSON.stringify(
    state.accounts.map(a => ({ email: a.email, color: a.color }))
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
  state.accounts = state.accounts.map(a => ({ ...a, token: null }));

  renderAccounts();
  renderChips();
  renderFolderChips();
  renderCategoryChips();
  renderCalendarAccountChips();
  renderRangeChips();
  renderRules();
  updateSubline();

  wireNav();
  wireSearch();
  wireRuleModal();
  wireDetailModal();
  wireComposeModal();
  wireEventModal();
  wireSettings();

  document.getElementById("add-account-btn").addEventListener("click", startAddAccount);
  document.getElementById("add-account-btn-2").addEventListener("click", startAddAccount);
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

function addOrUpdateAccount(email, token, expiresIn) {
  const existing = state.accounts.find(a => a.email === email);
  const tokenExpiry = Date.now() + expiresIn * 1000;
  if (existing) {
    existing.token = token;
    existing.tokenExpiry = tokenExpiry;
  } else {
    state.accounts.push({ email, color: COLORS[state.accounts.length % COLORS.length], token, tokenExpiry });
  }
  persistAccounts();
  renderAccounts();
  renderChips();
  renderCalendarAccountChips();
  updateSubline();
  refreshInbox();
  refreshCalendar();
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
  renderMessages();

  merged.forEach(m => state.seenIds.add(m.id));
  persistSeenIds();
}

async function fetchAccountMessages(account) {
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
        hasListUnsubscribe: Boolean(get("List-Unsubscribe"))
      };
      message.category = classifyMessage(message);
      return message;
    });
  } catch (e) {
    console.error("Fetch mislukt voor", account.email, e);
    return [];
  }
}

function classifyMessage(message) {
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
  await modifyLabels(id, account.token, { removeLabelIds: ["INBOX"] });
  state.messages = state.messages.filter(m => m.id !== id);
  renderMessages();
}

async function trashMessage(id) {
  const account = accountForMessage(id);
  if (!account || !account.token) return;
  await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`, {
    method: "POST",
    headers: { Authorization: `Bearer ${account.token}` }
  });
  state.messages = state.messages.filter(m => m.id !== id);
  renderMessages();
}

async function snoozeMessage(id, until) {
  const account = accountForMessage(id);
  if (!account || !account.token) return;
  await modifyLabels(id, account.token, { removeLabelIds: ["INBOX"] });
  state.snoozed[id] = until;
  persistSnoozed();
  state.messages = state.messages.filter(m => m.id !== id);
  renderMessages();
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
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}?format=full`, {
      headers: { Authorization: `Bearer ${account.token}` }
    });
    const data = await r.json();
    document.getElementById("detail-body").textContent = extractBody(data.payload) || message.snippet || "(geen tekst gevonden)";
  } catch (e) {
    document.getElementById("detail-body").textContent = message.snippet || "Kon bericht niet volledig laden.";
  }
}

async function sendReply(message, bodyText) {
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
    li.innerHTML = `
      <div class="account-info">
        <div class="account-avatar" style="background:${a.color}">${initials}</div>
        <div>
          <div class="account-email">${escapeHtml(a.email)}</div>
          <div class="account-status">${a.token ? "Verbonden" : "Opnieuw verbinden nodig"}</div>
        </div>
      </div>
      <button class="account-delete" data-email="${a.email}">Verwijderen</button>
    `;
    list.appendChild(li);
  });
  list.querySelectorAll(".account-delete").forEach(btn => {
    btn.addEventListener("click", () => removeAccount(btn.dataset.email));
  });
}

function renderRules() {
  const list = document.getElementById("rules-list");
  const empty = document.getElementById("rules-empty");
  list.innerHTML = "";
  empty.classList.toggle("hidden", state.rules.length > 0);

  const actionLabel = { archive: "Archiveert", label: "Labelt", autoreply: "Auto-reply" };

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
    if (actionSelect.value === "archive") valueWrap.classList.add("hidden");
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
