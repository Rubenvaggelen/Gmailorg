MAIL UPDATE — BIJLAGEN + HYPERLINKS
===================================

Deze patch bouwt verder op de fullscreen/doorstuur-update en voegt toe:
- Doorsturen neemt Gmail- en Outlook/Hotmail-bestandsbijlagen automatisch mee.
- Bijlagen zijn vóór verzenden zichtbaar en afzonderlijk verwijderbaar.
- Voorkomt dubbel versturen: in doorstuurmodus neemt de patch de verzendactie over.
- HTML-links in ontvangen mails openen buiten het mailframe.
- URL's in platte-tekstmail worden klikbaar gemaakt.
- De volledige schermweergave en "← Terug naar mails" blijven behouden.

Toepassen in de hoofdmap van de Gmailorg/Mail repository:
  unzip -o gmailorg-mail-attachments-links-update.zip
  bash apply-mail-update.sh

Daarna:
  git add -A
  git status --short
  git commit -m "Forward mail attachments and open hyperlinks"
  git push origin main

Opmerking:
Zeer grote Outlook/Hotmail-bijlagen kunnen door de directe Microsoft Graph-verzendlimiet worden geweigerd. De app toont dan een foutmelding in plaats van stil te mislukken.
