#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f index.html || ! -f app.js || ! -f style.css ]]; then
  echo "FOUT: voer dit script uit in de hoofdmap van de Gmailorg/Mail repository." >&2
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

echo "Mail-update toegepast: fullscreen e-mailweergave + Doorsturen."
echo "Controleer met: git status --short"
