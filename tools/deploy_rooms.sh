#!/bin/bash
# Installs the online mode's room server (server/rooms.py) on the asset host: a systemd service on 127.0.0.1:8787 that
# only takes pages from the published site's origin, and the web server's /signal route to it. The host is given by
# the environment, never stored:
#   N64WEB_ASSET_SSH=user@host N64WEB_SITE_ORIGIN=https://<user>.github.io tools/deploy_rooms.sh
# The host's Caddyfile is expected to have the site block publish_site.sh uses, with its final `handle { respond 404 }`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${N64WEB_ASSET_SSH:?}"; : "${N64WEB_SITE_ORIGIN:?}"
ssh -o BatchMode=yes "$N64WEB_ASSET_SSH" "mkdir -p /opt/n64web/rooms"
scp -q "$ROOT/server/rooms.py" "$N64WEB_ASSET_SSH:/opt/n64web/rooms/rooms.py"
ssh -o BatchMode=yes "$N64WEB_ASSET_SSH" ORIGIN="$N64WEB_SITE_ORIGIN" 'bash -s' <<'EOF'
set -euo pipefail
chmod 644 /opt/n64web/rooms/rooms.py
cat > /etc/systemd/system/n64web-rooms.service <<UNIT
[Unit]
Description=n64web online room server
After=network.target

[Service]
ExecStart=/usr/bin/python3 -I /opt/n64web/rooms/rooms.py --host 127.0.0.1 --port 8787 --origin $ORIGIN
DynamicUser=yes
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
MemoryMax=128M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now n64web-rooms.service
systemctl restart n64web-rooms.service
# The /signal route, once, before the site block's catch-all 404.
if ! grep -q 'handle /signal' /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-rooms
  python3 -I - <<'PY'
p = '/etc/caddy/Caddyfile'
s = open(p).read()
anchor = '\thandle {\n\t\trespond 404\n\t}'
assert s.count(anchor) == 1, 'catch-all handle not found'
s = s.replace(anchor, '\thandle /signal {\n\t\treverse_proxy 127.0.0.1:8787\n\t}\n' + anchor)
open(p, 'w').write(s)
PY
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl reload caddy
fi
systemctl is-active n64web-rooms.service
EOF
echo "room server deployed"
