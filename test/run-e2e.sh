#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

TJS="$DIR/dist/Latata.Hub.app/Contents/MacOS/tjs"
[ -f "$TJS" ] || TJS="/tmp/.tinyjs/.tinyjs/bin/tjs"
[ -f "$TJS" ] || TJS="$HOME/.tinyjs/bin/tjs"
TINYJS="/tmp/.tinyjs/.tinyjs/tinyjs"

echo "========================================================"
echo "          🚀 Latata.Hub — End-to-End Test Suite         "
echo "========================================================"

echo ""
echo "▶ Krok 1/2: Uruchamianie testów E2E warstwy natywnej i backendu (txiki.js)..."
"$TJS" run "$DIR/test/e2e-backend.js"

if [ "$1" = "--ui" ]; then
  echo ""
  echo "▶ Krok 2/2: Uruchamianie testów E2E interfejsu w natywnym oknie WebKit (WKWebView)..."
  "$TJS" run "$DIR/test/generate-e2e-html.js" > /dev/null
  TINYJS_HTML="$DIR/test/e2e-ui.html" "$TINYJS" dev
else
  echo ""
  echo "▶ Aby uruchomić testy E2E na żywo w oknie WebKit (symulacja kliknięć i animacji):"
  echo "    ./test/run-e2e.sh --ui"
fi

echo ""
echo "========================================================"
echo "          ✅ WSZYSTKIE TESTY E2E ZAKOŃCZONE SUKCESEM!   "
echo "========================================================"
