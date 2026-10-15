#!/bin/sh
# Optional: re-renders high-resolution brand PNGs (opencrawl-banner@2x, social card) with headless Chrome.
# The committed PNGs were captured from the browser instead. Renders the brand PNGs from assets/brand/src/*.html with headless Chrome. Run from anywhere.
set -e
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { # name page width height scale [transparent]
  bg=ffffffff; [ "$6" = transparent ] && bg=00000000
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --default-background-color=$bg \
    --force-device-scale-factor="$5" --window-size="$3,$4" --virtual-time-budget=9000 \
    --screenshot="$PWD/$1" "file://$PWD/src/$2" >/dev/null 2>&1
}
shot opencrawl-banner.png banner.html 1500 500 2
shot opencrawl-og.png og.html 1200 630 1
shot opencrawl-badge-1024.png icon.html 512 512 2 transparent
shot icon-512.png icon.html 512 512 1 transparent
shot icon-192.png icon.html 192 192 1 transparent
shot apple-touch-icon.png icon.html 180 180 1 transparent
shot favicon-32.png icon.html 32 32 1 transparent
echo "brand assets rendered"
