/* Mail update: fullscreen message view + forwarding with attachments + clickable links */
(() => {
  "use strict";

  const byId = id => document.getElementById(id);

  const forwardState = {
    active: false,
    message: null,
    attachments: [],
    skipped: []
  };

  function stripHtmlToText(html) {
    if (!html) return "";
    const box = document.createElement("div");
    box.innerHTML = html;
    box.querySelectorAll("script,style,noscript,head").forEach(el => el.remove());
    return (box.innerText || box.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  function normalizeBase64(data) {
    let s = String(data || "").replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    while (s.length % 4) s += "=";
    return s;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function utf8ToBase64(text) {
    return bytesToBase64(new TextEncoder().encode(String(text || "")));
  }

  function utf8ToBase64Url(text) {
    return utf8ToBase64(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function formatSize(size) {
    const n = Number(size || 0);
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function safeFileName(name) {
    return String(name || "bijlage")
      .replace(/[\\"\r\n]/g, "_")
      .replace(/[^\x20-\x7E]/g, "_") || "bijlage";
  }

  function encodeMimeHeader(value) {
    const s = String(value || "");
    return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${utf8ToBase64(s)}?=`;
  }

  function wrapBase64(value) {
    return String(value || "").replace(/\s+/g, "").match(/.{1,76}/g)?.join("\r\n") || "";
  }

  function forwardedHeader(message, body) {
    const when = new Date(message.timestamp).toLocaleString("nl-NL");
    return [
      "",
      "---------- Doorgestuurd bericht ----------",
      `Van: ${message.from || "Onbekend"}`,
      `Datum: ${when}`,
      `Onderwerp: ${message.subject || "(geen onderwerp)"}`,
      `Aan: ${message.accountEmail || ""}`,
      "",
      body || message.snippet || ""
    ].join("\n");
  }

  function partHeader(part, name) {
    const headers = part?.headers || [];
    return headers.find(h => String(h.name || "").toLowerCase() === name.toLowerCase())?.value || "";
  }

  function collectGmailAttachmentParts(part, out = []) {
    if (!part) return out;
    const filename = String(part.filename || "").trim();
    if (filename && (part.body?.attachmentId || part.body?.data)) {
      out.push({
        filename,
        mimeType: part.mimeType || "application/octet-stream",
        size: Number(part.body?.size || 0),
        attachmentId: part.body?.attachmentId || null,
        inlineData: part.body?.data || null,
        disposition: partHeader(part, "Content-Disposition")
      });
    }
    (part.parts || []).forEach(child => collectGmailAttachmentParts(child, out));
    return out;
  }

  async function getGmailAttachmentBase64(account, messageId, item) {
    if (item.inlineData) return normalizeBase64(item.inlineData);
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(item.attachmentId)}`,
      { headers: { Authorization: `Bearer ${account.token}` } }
    );
    if (!r.ok) throw new Error(`Bijlage ${item.filename} kon niet worden geladen (${r.status})`);
    const data = await r.json();
    return normalizeBase64(data.data || "");
  }

  async function loadGmailForwardData(account, message) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`,
      { headers: { Authorization: `Bearer ${account.token}` } }
    );
    if (!r.ok) throw new Error(`Gmail-bericht laden mislukt (${r.status})`);
    const data = await r.json();
    const parts = typeof extractRawParts === "function"
      ? extractRawParts(data.payload)
      : { html: null, plain: null };

    let body = "";
    if (parts.plain && parts.plain.trim()) {
      body = typeof cleanBodyText === "function" ? cleanBodyText(parts.plain) : parts.plain.trim();
    } else if (parts.html && parts.html.trim()) {
      body = stripHtmlToText(parts.html);
    }
    if (!body) body = message.snippet || "";

    const attachmentParts = collectGmailAttachmentParts(data.payload);
    const attachments = [];
    const skipped = [];
    for (const item of attachmentParts) {
      try {
        const base64 = await getGmailAttachmentBase64(account, message.id, item);
        if (!base64) throw new Error("lege bijlage");
        attachments.push({
          name: item.filename,
          mimeType: item.mimeType,
          size: item.size,
          base64,
          source: "gmail"
        });
      } catch (error) {
        console.warn("Gmail-bijlage laden mislukt", item.filename, error);
        skipped.push(item.filename);
      }
    }
    return { body, attachments, skipped };
  }

  async function loadMicrosoftAttachmentContent(account, messageId, attachment) {
    if (attachment.contentBytes) return attachment;
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}`,
      { headers: { Authorization: `Bearer ${account.token}` } }
    );
    if (!r.ok) throw new Error(`Outlook-bijlage kon niet worden geladen (${r.status})`);
    return r.json();
  }

  async function loadMicrosoftForwardData(account, message) {
    const bodyResp = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(message.id)}?$select=body,hasAttachments`,
      {
        headers: {
          Authorization: `Bearer ${account.token}`,
          Prefer: 'outlook.body-content-type="html"'
        }
      }
    );
    if (!bodyResp.ok) throw new Error(`Microsoft bericht laden mislukt (${bodyResp.status})`);
    const bodyData = await bodyResp.json();
    const raw = bodyData?.body?.content || "";
    const body = String(bodyData?.body?.contentType || "").toLowerCase() === "html"
      ? stripHtmlToText(raw)
      : raw.trim();

    const attachments = [];
    const skipped = [];
    let url = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(message.id)}/attachments?$top=100`;
    while (url) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${account.token}` } });
      if (!r.ok) throw new Error(`Microsoft-bijlagen laden mislukt (${r.status})`);
      const data = await r.json();
      for (const rawAttachment of data.value || []) {
        const type = rawAttachment["@odata.type"] || "";
        if (!type.endsWith("fileAttachment")) {
          skipped.push(rawAttachment.name || "niet-ondersteunde bijlage");
          continue;
        }
        try {
          const full = await loadMicrosoftAttachmentContent(account, message.id, rawAttachment);
          if (!full.contentBytes) throw new Error("geen contentBytes");
          attachments.push({
            name: full.name || rawAttachment.name || "bijlage",
            mimeType: full.contentType || rawAttachment.contentType || "application/octet-stream",
            size: Number(full.size || rawAttachment.size || 0),
            base64: normalizeBase64(full.contentBytes),
            source: "microsoft"
          });
        } catch (error) {
          console.warn("Microsoft-bijlage laden mislukt", rawAttachment.name, error);
          skipped.push(rawAttachment.name || "bijlage");
        }
      }
      url = data["@odata.nextLink"] || null;
    }

    return { body: body || message.snippet || "", attachments, skipped };
  }

  async function loadForwardData(message) {
    const account = state.accounts.find(a => a.email === message.accountEmail);
    if (!account || !account.token) return { body: message.snippet || "", attachments: [], skipped: [] };
    return account.provider === "microsoft"
      ? loadMicrosoftForwardData(account, message)
      : loadGmailForwardData(account, message);
  }

  function ensureAttachmentUi() {
    let box = byId("compose-forward-attachments");
    if (box) return box;
    const body = byId("compose-body");
    const field = body?.closest(".field");
    if (!field) return null;
    box = document.createElement("div");
    box.id = "compose-forward-attachments";
    box.className = "compose-forward-attachments hidden";
    field.insertAdjacentElement("afterend", box);
    return box;
  }

  function renderForwardAttachments() {
    const box = ensureAttachmentUi();
    if (!box) return;
    if (!forwardState.active) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }

    const rows = forwardState.attachments.map((a, index) => `
      <div class="forward-attachment-row">
        <div class="forward-attachment-info">
          <span class="forward-attachment-icon">📎</span>
          <span class="forward-attachment-name">${escapeHtml(a.name)}</span>
          ${a.size ? `<span class="forward-attachment-size">${escapeHtml(formatSize(a.size))}</span>` : ""}
        </div>
        <button type="button" class="btn-ghost small forward-attachment-remove" data-forward-attachment-index="${index}" aria-label="Bijlage verwijderen">Verwijder</button>
      </div>`).join("");

    const skipped = forwardState.skipped.length
      ? `<div class="forward-attachment-warning">${forwardState.skipped.length} bijlage${forwardState.skipped.length === 1 ? "" : "n"} kon${forwardState.skipped.length === 1 ? "" : "den"} niet automatisch worden meegenomen.</div>`
      : "";

    box.innerHTML = `
      <div class="forward-attachment-title">Bijlagen die meegaan</div>
      ${rows || '<div class="forward-attachment-empty">Geen bijlagen bij dit bericht.</div>'}
      ${skipped}
    `;
    box.classList.remove("hidden");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function clearForwardState() {
    forwardState.active = false;
    forwardState.message = null;
    forwardState.attachments = [];
    forwardState.skipped = [];
    renderForwardAttachments();
    const title = document.querySelector("#compose-modal h2");
    if (title) title.textContent = "Nieuwe e-mail";
  }

  async function startForward() {
    if (typeof activeDetailMessage === "undefined" || !activeDetailMessage) return;
    const message = activeDetailMessage;
    const btn = byId("detail-forward");
    const oldText = btn?.textContent || "Doorsturen";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Mail + bijlagen laden…";
    }

    try {
      const data = await loadForwardData(message);
      if (typeof openCompose !== "function") throw new Error("Opstelscherm niet beschikbaar");

      openCompose();
      forwardState.active = true;
      forwardState.message = message;
      forwardState.attachments = data.attachments || [];
      forwardState.skipped = data.skipped || [];

      const composeTitle = document.querySelector("#compose-modal h2");
      if (composeTitle) composeTitle.textContent = "E-mail doorsturen";
      const from = byId("compose-from");
      if (from && [...from.options].some(o => o.value === message.accountEmail)) {
        from.value = message.accountEmail;
      }
      byId("compose-to").value = "";
      byId("compose-subject").value = /^fwd:/i.test(message.subject || "")
        ? message.subject
        : `Fwd: ${message.subject || "(geen onderwerp)"}`;
      byId("compose-body").value = forwardedHeader(message, data.body);
      renderForwardAttachments();
      byId("compose-to").focus();
    } catch (error) {
      console.error(error);
      alert("Doorsturen kon niet worden geopend. De mail of bijlagen konden niet worden geladen.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  function buildGmailRawMessage({ to, subject, body, attachments }) {
    if (!attachments?.length) {
      const lines = [
        `To: ${to}`,
        `Subject: ${encodeMimeHeader(subject)}`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        body || ""
      ].join("\r\n");
      return utf8ToBase64Url(lines);
    }

    const boundary = `----=_TheOneMail_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const lines = [
      `To: ${to}`,
      `Subject: ${encodeMimeHeader(subject)}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body || ""
    ];

    for (const attachment of attachments) {
      const safe = safeFileName(attachment.name);
      const encodedName = encodeURIComponent(attachment.name || safe).replace(/'/g, "%27");
      lines.push(
        `--${boundary}`,
        `Content-Type: ${attachment.mimeType || "application/octet-stream"}; name="${safe}"`,
        `Content-Disposition: attachment; filename="${safe}"; filename*=UTF-8''${encodedName}`,
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(attachment.base64),
        ""
      );
    }
    lines.push(`--${boundary}--`, "");
    return utf8ToBase64Url(lines.join("\r\n"));
  }

  async function sendForwardMail(fromAccountEmail, { to, subject, body, attachments }) {
    const account = state.accounts.find(a => a.email === fromAccountEmail);
    if (!account || !account.token) throw new Error("Dit account is niet verbonden.");

    if (!attachments?.length && typeof sendMail === "function") {
      await sendMail(fromAccountEmail, { to, subject, body });
      return;
    }

    if (account.provider === "microsoft") {
      const graphAttachments = (attachments || []).map(a => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.name || "bijlage",
        contentType: a.mimeType || "application/octet-stream",
        contentBytes: a.base64
      }));
      const response = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
        method: "POST",
        headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "Text", content: body || "" },
            toRecipients: [{ emailAddress: { address: to } }],
            attachments: graphAttachments
          },
          saveToSentItems: true
        })
      });
      if (!response.ok) {
        const details = await response.text().catch(() => "");
        throw new Error(`Microsoft kon de mail met bijlagen niet versturen (${response.status}). ${details}`);
      }
      return;
    }

    const raw = buildGmailRawMessage({ to, subject, body, attachments: attachments || [] });
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${account.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw })
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Gmail kon de mail met bijlagen niet versturen (${response.status}). ${details}`);
    }
  }

  async function handleForwardSend(event) {
    const sendButton = event.target?.closest?.("#compose-send");
    if (!sendButton || !forwardState.active) return;

    // De bestaande compose-listener mag in forwardmodus niet ook nog een
    // tweede mail zonder bijlagen versturen.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const from = byId("compose-from")?.value || "";
    const to = byId("compose-to")?.value.trim() || "";
    const subject = byId("compose-subject")?.value.trim() || "";
    const body = byId("compose-body")?.value || "";
    if (!to || !subject) {
      alert("Vul minstens een ontvanger en onderwerp in.");
      return;
    }

    const oldText = sendButton.textContent;
    sendButton.disabled = true;
    sendButton.textContent = "Versturen…";
    try {
      await sendForwardMail(from, {
        to,
        subject,
        body,
        attachments: forwardState.attachments
      });
      byId("compose-modal")?.classList.add("hidden");
      clearForwardState();
      if (state.activeFolder === "SENT" && typeof refreshInbox === "function") refreshInbox();
    } catch (error) {
      console.error("Doorsturen met bijlagen mislukt", error);
      const message = String(error?.message || error || "Onbekende fout");
      alert(`Doorsturen mislukt. ${message}\n\nLet op: zeer grote Outlook-bijlagen kunnen de directe verzendlimiet van Microsoft overschrijden.`);
    } finally {
      sendButton.disabled = false;
      sendButton.textContent = oldText;
    }
  }

  function linkifyTextNodeContainer(el) {
    if (!el || el.dataset.linksReady === "1") return;
    const text = el.textContent || "";
    if (!text) return;
    const regex = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/gi;
    let last = 0;
    let match;
    const frag = document.createDocumentFragment();
    while ((match = regex.exec(text))) {
      frag.append(document.createTextNode(text.slice(last, match.index)));
      let shown = match[0];
      let trailing = "";
      while (/[),.;!?\]}]$/.test(shown)) {
        trailing = shown.slice(-1) + trailing;
        shown = shown.slice(0, -1);
      }
      const a = document.createElement("a");
      a.href = /^www\./i.test(shown) ? `https://${shown}` : shown;
      a.textContent = shown;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "mail-clickable-link";
      frag.append(a);
      if (trailing) frag.append(document.createTextNode(trailing));
      last = match.index + match[0].length;
    }
    if (last === 0) return;
    frag.append(document.createTextNode(text.slice(last)));
    el.textContent = "";
    el.append(frag);
    el.dataset.linksReady = "1";
    el.style.whiteSpace = "pre-wrap";
  }

  function installClickableLinks() {
    const frame = byId("detail-body-frame");
    if (frame) {
      // Scripts blijven geblokkeerd, maar same-origin maakt het mogelijk om
      // vanuit de veilige parent click-events op geschoonde links af te vangen.
      frame.setAttribute(
        "sandbox",
        "allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
      );
      frame.addEventListener("load", () => {
        try {
          const doc = frame.contentDocument;
          if (!doc || doc.__theOneLinkHandlerInstalled) return;
          doc.__theOneLinkHandlerInstalled = true;
          doc.addEventListener("click", event => {
            const anchor = event.target?.closest?.("a[href]");
            if (!anchor) return;
            const href = anchor.href || anchor.getAttribute("href") || "";
            if (!/^(https?:|mailto:|tel:)/i.test(href)) return;
            event.preventDefault();
            event.stopPropagation();
            const opened = window.open(href, "_blank", "noopener,noreferrer");
            if (!opened && /^https?:/i.test(href)) {
              // Als een geïnstalleerde PWA popups blokkeert, gebruik dan een
              // tijdelijke echte <a> in het hoofdvenster als fallback.
              const temp = document.createElement("a");
              temp.href = href;
              temp.target = "_blank";
              temp.rel = "noopener noreferrer";
              temp.style.display = "none";
              document.body.append(temp);
              temp.click();
              temp.remove();
            }
          }, true);
        } catch (error) {
          console.warn("Link-handler voor e-mail kon niet worden geplaatst", error);
        }
      });
    }

    // Voor platte-tekstmail: URLs omzetten in echte links.
    if (typeof renderEmailBody === "function" && !window.__theOneOriginalRenderEmailBody) {
      window.__theOneOriginalRenderEmailBody = renderEmailBody;
      renderEmailBody = function(args) {
        window.__theOneOriginalRenderEmailBody(args);
        if (!args?.html) {
          requestAnimationFrame(() => linkifyTextNodeContainer(byId("detail-body")));
        }
      };
    }
  }

  function resetComposeForNewMail() {
    clearForwardState();
  }

  function install() {
    const detailModal = byId("detail-modal");
    const closeBtn = byId("detail-close");
    const actions = detailModal?.querySelector(".detail-actions");
    if (!detailModal || !closeBtn || !actions) return;

    closeBtn.textContent = "← Terug naar mails";
    closeBtn.setAttribute("aria-label", "Terug naar overige mails");

    if (!byId("detail-forward")) {
      const forward = document.createElement("button");
      forward.id = "detail-forward";
      forward.className = "btn-ghost";
      forward.type = "button";
      forward.textContent = "Doorsturen";
      const reply = byId("detail-reply-toggle");
      actions.insertBefore(forward, reply || null);
    }
    byId("detail-forward")?.addEventListener("click", startForward);

    ensureAttachmentUi();
    installClickableLinks();

    // Capturing: onderschept alleen forwardmodus vóór de oorspronkelijke
    // compose-send listener, zodat er nooit dubbel verstuurd wordt.
    document.addEventListener("click", handleForwardSend, true);

    byId("compose-cancel")?.addEventListener("click", clearForwardState);
    byId("compose-btn")?.addEventListener("click", resetComposeForNewMail, true);

    byId("compose-forward-attachments")?.addEventListener("click", event => {
      const button = event.target?.closest?.("[data-forward-attachment-index]");
      if (!button) return;
      const index = Number(button.dataset.forwardAttachmentIndex);
      if (!Number.isInteger(index) || index < 0 || index >= forwardState.attachments.length) return;
      forwardState.attachments.splice(index, 1);
      renderForwardAttachments();
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && !detailModal.classList.contains("hidden")) {
        const compose = byId("compose-modal");
        if (compose && !compose.classList.contains("hidden")) return;
        closeBtn.click();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
