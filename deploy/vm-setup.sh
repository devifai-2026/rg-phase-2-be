#!/usr/bin/env bash
# Run ON the GCP VM (over SSH) to install everything and start the backend
# behind Caddy with auto-HTTPS. Idempotent: safe to re-run for updates.
#
#   curl -fsSL .../vm-setup.sh | sudo bash          # or copy + run
#   sudo bash deploy/vm-setup.sh
#
# What it does:
#   1. installs Node 20 + Caddy
#   2. creates an unprivileged `rgapp` user and /opt/rg-backend
#   3. clones (or pulls) the repo, installs prod deps
#   4. installs the systemd service + Caddyfile (with your IP baked in)
#   5. starts both services
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/devifai-2026/rg-phase-2-be.git}"
APP_DIR="/opt/rg-backend"
APP_USER="rgapp"

echo "==> Detecting public IP for the sslip.io hostname..."
PUBLIC_IP="$(curl -fsSL -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)"
[ -z "$PUBLIC_IP" ] && PUBLIC_IP="$(curl -fsSL https://ifconfig.me)"
DASH_IP="${PUBLIC_IP//./-}"
HOSTNAME_SSLIP="${DASH_IP}.sslip.io"
echo "    Public IP: $PUBLIC_IP  ->  https://${HOSTNAME_SSLIP}"

echo "==> Installing Node 20..."
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing Caddy..."
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "==> Creating app user + dir..."
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"

echo "==> Fetching code..."
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin && git -C "$APP_DIR" reset --hard origin/main
else
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "==> Installing prod deps..."
( cd "$APP_DIR" && sudo -u "$APP_USER" npm ci --omit=dev )

echo "==> Installing systemd service..."
install -m 644 "$APP_DIR/deploy/rg-backend.service" /etc/systemd/system/rg-backend.service
if [ ! -f /etc/rg-backend.env ]; then
  echo "    !! /etc/rg-backend.env not found — creating a stub. EDIT IT with real secrets."
  cp "$APP_DIR/.env.example" /etc/rg-backend.env || touch /etc/rg-backend.env
  chmod 600 /etc/rg-backend.env
fi

echo "==> Installing Caddyfile with hostname $HOSTNAME_SSLIP..."
sed "s/REPLACE_WITH_DASHED_IP/${DASH_IP}/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile

echo "==> Starting services..."
systemctl daemon-reload
systemctl enable --now rg-backend
systemctl restart caddy

echo
echo "Done. Your backend is at:  https://${HOSTNAME_SSLIP}"
echo "Health check:              https://${HOSTNAME_SSLIP}/healthz"
echo "API docs:                  https://${HOSTNAME_SSLIP}/api-docs"
echo
echo "REMINDER: edit /etc/rg-backend.env with real MONGO_URI/JWT_SECRET/etc, then:"
echo "  sudo systemctl restart rg-backend"
