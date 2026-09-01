# Postbus — je Gmail-accounts in één app

Een installeerbare web-app (PWA) die 3-5 Gmail-accounts samenvoegt tot
één overzicht, en regels kan toepassen (archiveren, labelen, auto-reply).
Er is geen eigen server: de app praat via jouw browser rechtstreeks met
Google, met een OAuth-token per account. Er wordt niets naar een derde
partij gestuurd.

## Stap 1 — Zet de app online (nodig voor Google-login)

Google OAuth werkt niet vanaf een lokaal bestand (`file://`) — de app
moet op een echt `https://`-adres staan. De makkelijkste gratis opties:

**GitHub Pages** (aanrader)
1. Maak een nieuwe repository op GitHub, upload deze 7 bestanden.
2. Ga naar Settings → Pages → kies de main-branch als bron.
3. Je krijgt een adres als `https://jouwnaam.github.io/postbus/`.

**Alternatief:** Netlify of Vercel — sleep de map in hun dashboard en je
krijgt direct een live URL.

## Stap 2 — Voeg je site toe als 'Authorized origin' in Google Cloud

1. Ga naar console.cloud.google.com → jouw project → APIs & Services →
   Credentials.
2. Open (of maak) een OAuth Client ID van het type **Web application**.
3. Zet bij **Authorized JavaScript origins** het adres van stap 1, zonder
   pad erachter, bijv. `https://jouwnaam.github.io`.
4. Kopieer de Client ID (eindigt op `.apps.googleusercontent.com`).

## Stap 3 — Open de app en plak je Client ID

Bezoek je live URL op je telefoon. Bij eerste gebruik vraagt de app om de
Client ID uit stap 2 — plak die en je bent klaar.

## Stap 4 — Installeer op je startscherm

- **Android/Chrome:** menu (⋮) → "Toevoegen aan startscherm".
- **iPhone/Safari:** deelknop → "Zet op beginscherm".

Vanaf dan opent de app als een gewone app-icoon, los van de browserbalk.

## Stap 5 — Verbind je 3-5 accounts

Tik op **+ Account** en log in met elk Gmail-adres. Zorg dat elk adres al
als testgebruiker in het OAuth-consentscherm staat (dat hadden we al
gezet) — anders weigert Google de login met een waarschuwing.

## Mappen en opstellen

- **Map-kiezer** bovenin de Postbus-tab: Postvak IN / Verzonden /
  Concepten / Prullenbak — schakel ertussen om die map van al je
  accounts te zien.
- **Opstellen-knop** rechtsboven: schrijf een gloednieuwe e-mail
  (los van een reply), kies vanaf welk account je 'm verstuurt.

## Smart-client functies

- **Zoekbalk** — filtert direct op afzender, onderwerp en tekst.
- **Categorieën** — Persoonlijk / Nieuwsbrieven / Meldingen, automatisch
  bepaald (aan/uit in Instellingen).
- **Berichtdetail** — tik een bericht open voor de volledige tekst,
  met knoppen om te archiveren, verwijderen, snoozen of te beantwoorden.
- **Swipe-gebaren** — naar links/rechts vegen voert de actie uit die je
  in Instellingen hebt gekozen (archiveren, verwijderen of snoozen).
- **Snoozen** — kies "over 1 uur", "vanavond", "morgen" of "volgende
  week"; het bericht verdwijnt tot dat moment.
- **Instellingen-tab** — ververs-interval, aantal berichten per ronde,
  categorieën aan/uit, swipe-gedrag, browser-notificaties, en een
  knop om alles te wissen.

## Regels instellen

Tab **Regels** → **+ Regel**. Een regel controleert bij elke ververs-cyclus
(elke 2 minuten, of handmatig door de app te heropenen) of een binnenkomend
bericht aan de voorwaarde voldoet, en voert dan de actie uit.

- **Archiveren** werkt direct.
- **Labelen** en **Auto-reply** staan in de code klaar als volgende stap
  (zie de `TODO`-achtige commentaren in `app.js` bij `executeRuleAction`)
  — dit vereist een klein beetje extra Gmail API-werk (label aanmaken,
  of een RFC 2822-bericht samenstellen voor het versturen van een reply).
  Zeg het gewoon als je wilt dat ik dat afmaak.

## Bestanden in dit project

| Bestand | Doel |
|---|---|
| `index.html` | Schermopbouw: setup, postbus, regels, accounts |
| `style.css` | Vormgeving |
| `app.js` | Login per account, ophalen/mergen van mail, regels-engine |
| `manifest.json` | Maakt de app installeerbaar |
| `sw.js` | Laat de app-schil ook zonder verbinding openen |
| `icon-192.png` / `icon-512.png` | App-iconen (placeholder, mag je vervangen) |

## Beperkingen van deze versie

- Ververst zolang de app open staat — geen achtergrondverwerking als de
  app dicht is (dat vereist server-side Gmail push-notificaties via
  Cloud Pub/Sub; kan een volgende stap zijn).
- **Snoozen** archiveert het bericht en onthoudt de tijd, maar het
  automatisch terugzetten in Postvak IN zodra de tijd verstrijkt is nog
  niet volledig afgerond.
- Labelen (in Regels) is nog niet uitgevoerd — archiveren en
  auto-reply-logging werken al.
- Notificaties werken alleen zolang de app open staat in de browser.
- De map "Concepten" toont bestaande concepten, maar nieuwe concepten
  opslaan vanuit de app kan nog niet — Opstellen verstuurt direct.
