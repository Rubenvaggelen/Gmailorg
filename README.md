# Gmail Org — je Gmail én Agenda in één app

Een installeerbare web-app (PWA) die 3-5 Google-accounts samenvoegt:
mail met regels/automatisering, én een gedeelde kalender. Er is geen
eigen server: de app praat via jouw browser rechtstreeks met Google,
met een OAuth-token per account.

## Stap 1 — Zet de app online

Google OAuth werkt alleen op een echt `https://`-adres. Gratis optie:
**GitHub Pages**.

1. Maak een nieuwe repository op GitHub, upload alle bestanden uit
   deze map (zorg dat de bestandsnamen exact kloppen — geen `(1)` of
   `(2)` erachter als je ze via de browser download).
2. Ga naar Settings → Pages → Branch: `main`, map `/ (root)` → Save.
3. Je krijgt een adres als `https://jouwnaam.github.io/jouwrepo/`.

## Stap 2 — Google Cloud: OAuth Client ID

1. console.cloud.google.com → nieuw of bestaand project → APIs &
   Services → Credentials → OAuth Client ID → type **Web application**.
2. Bij **Authorized JavaScript origins**: voeg je site toe zonder pad
   erachter, bijv. `https://jouwnaam.github.io`.
3. Kopieer de Client ID (eindigt op `.apps.googleusercontent.com`).

## Stap 3 — OAuth-consentscherm

1. **Branding**: vul App-naam en je eigen e-mail in bij support/
   developer contact. De rest mag leeg voor persoonlijk gebruik.
2. **Audience/Test users**: voeg je 3-5 Gmail-adressen toe als
   testgebruiker.
3. **Scopes**: voeg toe — `.../auth/gmail.readonly`,
   `.../auth/gmail.modify`, `.../auth/gmail.send`,
   `.../auth/calendar`, `.../auth/userinfo.email`.
4. Zorg dat de publiceringsstatus op **Testing** staat.

## Stap 4 — Open en installeer

Bezoek je live URL op je telefoon, plak de Client ID, en installeer via
"Toevoegen aan startscherm" (Android/Chrome) of "Zet op beginscherm"
(iPhone/Safari).

## Stap 5 — Verbind je accounts

Tik op **+ Account** en log in met elk adres. Geef toestemming voor
zowel Gmail als Agenda in het Google-scherm.

---

## Wat de app kan

**Postbus**
- Samengevoegde inbox van al je accounts, met mappen: Postvak IN,
  Verzonden, Concepten, Prullenbak.
- Zoeken, categorieën (Persoonlijk/Nieuwsbrieven/Meldingen).
- Bericht openen voor volledige tekst, antwoorden, archiveren,
  verwijderen, snoozen (1 uur/vanavond/morgen/volgende week).
- Swipe-gebaren, zelf in te stellen.
- Opstellen-knop voor nieuwe e-mails.

**Regels**
- Automatisch archiveren op basis van afzender/onderwerp.
- Labelen en auto-reply staan als volgende uitbreiding klaar in de
  code (`executeRuleAction` in `app.js`).

**Kalender**
- Agenda-items van al je accounts samengevoegd, gefilterd op account
  en periode (vandaag/week/maand).
- Afspraken aanmaken, bewerken en verwijderen — met locatie,
  beschrijving, hele-dag-optie en gasten uitnodigen.

**Instellingen**
- Ververs-interval, aantal berichten per ronde, categorieën aan/uit,
  swipe-gedrag, browser-notificaties, alles-wissen.

## Beperkingen

- Ververst zolang de app open staat — geen achtergrondverwerking
  (dat vereist server-side push via Cloud Pub/Sub).
- Snoozen archiveert het bericht en onthoudt de tijd, maar zet het nog
  niet automatisch terug in Postvak IN als de tijd verstrijkt.
- Labelen (Regels) en concepten opslaan vanuit Opstellen zijn nog niet
  uitgevoerd.

## Veelvoorkomende problemen

- **404 op je Pages-URL**: check of `index.html` (exacte naam, geen
  toevoegingen) in de hoofdmap staat, en of Settings → Pages een
  branch heeft ingesteld (niet "None").
- **Fout 401: invalid_client**: de Client ID in de app matcht niet met
  Google Cloud — kopieer 'm opnieuw, exact, uit Credentials.
- **Toegang geblokkeerd / OAuth-fout**: check of je e-mailadres als
  testgebruiker staat, en of alle scopes uit stap 3 zijn toegevoegd.
- **Knoppen doen niets / lege schermen**: waarschijnlijk een oude
  service-worker cache. Verwijder de app van je startscherm, wis
  sitegegevens in de browser, en installeer opnieuw.
