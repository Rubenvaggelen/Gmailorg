/* Mail update: fullscreen message view + forwarding */
(() => {
  "use strict";

  const byId = id => document.getElementById(id);

  function stripHtmlToText(html) {
    if (!html) return "";
    const box = document.createElement("div");
    box.innerHTML = html;
    box.querySelectorAll("script,style,noscript").forEach(el => el.remove());
    return (box.innerText || box.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function loadForwardBody(message) {
    const account = state.accounts.find(a => a.email === message.accountEmail);
    if (!account || !account.token) return message.snippet || "";

    try {
      if (account.provider === "microsoft") {
        const r = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(message.id)}?$select=body`,
          { headers: { Authorization: `Bearer ${account.token}` } }
        );
        if (!r.ok) throw new Error(`Microsoft bericht laden mislukt (${r.status})`);
        const data = await r.json();
        const content = data?.body?.content || "";
        return String(data?.body?.contentType || "").toLowerCase() === "html"
          ? stripHtmlToText(content)
          : content.trim();
      }

      const r = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`,
        { headers: { Authorization: `Bearer ${account.token}` } }
      );
      if (!r.ok) throw new Error(`Gmail bericht laden mislukt (${r.status})`);
      const data = await r.json();
      const parts = typeof extractRawParts === "function"
        ? extractRawParts(data.payload)
        : { html: null, plain: null };

      if (parts.plain && parts.plain.trim()) {
        return typeof cleanBodyText === "function"
          ? cleanBodyText(parts.plain)
          : parts.plain.trim();
      }
      if (parts.html && parts.html.trim()) return stripHtmlToText(parts.html);
      return message.snippet || "";
    } catch (error) {
      console.warn("Volledige tekst voor doorsturen laden mislukt", error);
      return message.snippet || "";
    }
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

  async function startForward() {
    if (typeof activeDetailMessage === "undefined" || !activeDetailMessage) return;
    const message = activeDetailMessage;
    const btn = byId("detail-forward");
    const oldText = btn?.textContent || "Doorsturen";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Laden…";
    }

    try {
      const body = await loadForwardBody(message);
      if (typeof openCompose !== "function") throw new Error("Opstelscherm niet beschikbaar");
      openCompose();

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
      byId("compose-body").value = forwardedHeader(message, body);
      byId("compose-to").focus();
    } catch (error) {
      console.error(error);
      alert("Doorsturen kon niet worden geopend. Probeer het opnieuw.");
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    }
  }

  function resetComposeTitle() {
    const title = document.querySelector("#compose-modal h2");
    if (title) title.textContent = "Nieuwe e-mail";
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
      forward.addEventListener("click", startForward);
    }

    // Gewoon opstellen moet na een eerdere forward weer de normale titel tonen.
    ["compose-btn"].forEach(id => {
      const el = byId(id);
      if (el) el.addEventListener("click", resetComposeTitle, true);
    });

    // Escape werkt ook als terugknop vanuit een geopend bericht.
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
