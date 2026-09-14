#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f index.html || ! -f app.js || ! -f style.css ]]; then
  echo "FOUT: voer dit script uit in de hoofdmap van de Gmailorg/Mail repository." >&2
  exit 1
fi

if [[ ! -f mail-fullscreen-forward.js || ! -f mail-fullscreen-forward.css ]]; then
  echo "FOUT: mail-fullscreen-forward.js/css staan niet in deze map. Pak eerst de update-ZIP hier uit." >&2
  exit 1
fi

# Voeg de extra CSS maar één keer toe.
if ! grep -q 'mail-fullscreen-forward.css' index.html; then
  python3 - <<'PY'
from pathlib import Path
p = Path('index.html')
s = p.read_text(encoding='utf-8')
needle = '<link rel="stylesheet" href="style.css" />'
replacement = needle + '\n<link rel="stylesheet" href="mail-fullscreen-forward.css" />'
if needle not in s:
    raise SystemExit('Kon style.css-verwijzing niet vinden in index.html')
s = s.replace(needle, replacement, 1)
p.write_text(s, encoding='utf-8')
PY
fi

# Laad de update ná app.js, zodat bestaande Mail-functies hergebruikt worden.
if ! grep -q 'mail-fullscreen-forward.js' index.html; then
  python3 - <<'PY'
from pathlib import Path
p = Path('index.html')
s = p.read_text(encoding='utf-8')
needle = '<script src="app.js"></script>'
replacement = needle + '\n<script src="mail-fullscreen-forward.js"></script>'
if needle not in s:
    raise SystemExit('Kon app.js-verwijzing niet vinden in index.html')
s = s.replace(needle, replacement, 1)
p.write_text(s, encoding='utf-8')
PY
fi

# Maak links in de sandboxed mailviewer expliciet navigeerbaar bij user-click.
python3 - <<'PY'
from pathlib import Path
p = Path('index.html')
s = p.read_text(encoding='utf-8')
old = 'sandbox="allow-popups allow-popups-to-escape-sandbox"'
new = 'sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"'
if old in s:
    s = s.replace(old, new)
p.write_text(s, encoding='utf-8')
PY

echo "Mail-update toegepast: fullscreen + doorsturen met bijlagen + klikbare hyperlinks."
echo "Controleer met: git status --short"
