#!/bin/bash
# Publishes the page: uploads game.wasm and game.data (and gzipped copies) to the asset host under a version path,
# writes the site's index.html (tools/make_site.py) and pushes the site repository. The host is given by the
# environment, never stored:
#   N64WEB_ASSET_SSH=user@host N64WEB_ASSET_URL=https://host N64WEB_SITE_DIR=build/site tools/publish_site.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; B="$ROOT/build/stadium2-web"; SITE="$ROOT/${N64WEB_SITE_DIR:-build/site}"
: "${N64WEB_ASSET_SSH:?}"; : "${N64WEB_ASSET_URL:?}"
V=$(cat "$B/game.wasm" "$B/game.data" | shasum | cut -c1-8)
ssh -o BatchMode=yes "$N64WEB_ASSET_SSH" "mkdir -p /opt/n64web/srv/web/$V && chmod 755 /opt/n64web/srv/web/$V"
scp -q "$B/game.wasm" "$B/game.data" "$N64WEB_ASSET_SSH:/opt/n64web/srv/web/$V/"
# Gzipped copies beside them: the web server sends those to browsers that take gzip (game.wasm 51 MB -> 12 MB).
ssh -o BatchMode=yes "$N64WEB_ASSET_SSH" "cd /opt/n64web/srv/web/$V && gzip -k -9 -f game.wasm game.data && chmod 644 *"
cp "$B/game.js" "$B/coi_serviceworker.js" "$SITE/"
python3 -I "$ROOT/tools/make_site.py" "$B/game.html" "$SITE/index.html" "$N64WEB_ASSET_URL/web/$V/"
git -C "$SITE" add -A && git -C "$SITE" commit -q -m "Page $V" && git -C "$SITE" push -q origin main
echo "published $V"
