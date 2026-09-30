#!/usr/bin/env bash
#
# Render a markdown document to a client-ready PDF.
#
#   ./scripts/make-pdf.sh docs/CLIENT-UPDATE-2026-09-29.md "docs/NoteMD - Update.pdf"
#
# pandoc has no PDF engine on this machine (no LaTeX), so it produces styled
# HTML and headless Chrome prints it. Chrome is the better route anyway: the
# stylesheet controls page breaks around headings and keeps tables from
# splitting, which a LaTeX pipeline would need separate handling for.
#
set -euo pipefail

SRC="${1:?usage: make-pdf.sh <input.md> [output.pdf]}"
OUT="${2:-${SRC%.md}.pdf}"
CSS="$(cd "$(dirname "$0")" && pwd)/report.css"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

command -v pandoc >/dev/null || { echo "error: pandoc is not installed (brew install pandoc)" >&2; exit 78; }
[[ -x "$CHROME" ]] || { echo "error: Google Chrome not found at $CHROME" >&2; exit 78; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$CSS" "$TMP/report.css"

pandoc "$SRC" --standalone --from=gfm --to=html5 \
  --metadata pagetitle="$(basename "${SRC%.md}")" \
  --css=report.css -o "$TMP/doc.html"

# --no-pdf-header-footer drops Chrome's default URL and date furniture;
# the stylesheet's @page rule owns the margins.
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --run-all-compositor-stages-before-draw \
  --print-to-pdf="$TMP/doc.pdf" "file://$TMP/doc.html" >/dev/null 2>&1

mv "$TMP/doc.pdf" "$OUT"
SIZE_PAGES=$(python3 -c "import re,sys; d=open(sys.argv[1],'rb').read(); pages=len(re.findall(b'/Type' + rb'\\s*' + b'/Page[^s]', d)); print('{:.0f} KB, {} pages'.format(len(d)/1024, pages))" "$OUT")
echo "wrote $OUT ($SIZE_PAGES)"
