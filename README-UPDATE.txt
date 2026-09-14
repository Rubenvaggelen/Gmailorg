MAIL UPDATE
===========

Deze patch voegt toe:
- e-mails openen volledig scherm;
- knop "← Terug naar mails";
- knop "Doorsturen";
- Doorsturen opent het bestaande opstelscherm met Fwd:-onderwerp en de volledige mailtekst (waar mogelijk) voorgeladen;
- Escape sluit een geopend bericht en keert terug naar de maillijst.

Toepassen in de hoofdmap van de Gmailorg/Mail repository:
  bash apply-mail-update.sh

Daarna committen en pushen.

Let op: deze versie stuurt de mailtekst door. Bijlagen worden nog niet automatisch als nieuwe Gmail/Outlook-bijlage meegestuurd.
