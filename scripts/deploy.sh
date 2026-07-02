#!/usr/bin/env bash
# Builds the app locally and packages the Next.js "standalone" output into a
# tarball ready to run on the VPS — no build step needed on the server.
#
# Usage:
#   bash scripts/deploy.sh
#
# To also auto-upload via scp/ssh, set these env vars first:
#   VPS_HOST=your.server.ip VPS_USER=root VPS_PATH=/var/www/mcwpay062026 bash scripts/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Building production bundle..."
npm run build

DEPLOY_DIR=".next/standalone"

echo "==> Copying static assets into standalone bundle..."
mkdir -p "$DEPLOY_DIR/.next/static"
cp -r .next/static/. "$DEPLOY_DIR/.next/static/"

echo "==> Copying public assets into standalone bundle..."
mkdir -p "$DEPLOY_DIR/public"
cp -r public/. "$DEPLOY_DIR/public/"

TARBALL="deploy-$(date +%Y%m%d-%H%M%S).tar.gz"
echo "==> Packaging into $TARBALL..."
tar -czf "$TARBALL" -C "$DEPLOY_DIR" .

echo ""
echo "==> Done: $TARBALL"

if [[ -n "${VPS_HOST:-}" && -n "${VPS_USER:-}" && -n "${VPS_PATH:-}" ]]; then
  echo "==> Uploading to $VPS_USER@$VPS_HOST:$VPS_PATH ..."
  ssh "$VPS_USER@$VPS_HOST" "mkdir -p $VPS_PATH"
  scp "$TARBALL" "$VPS_USER@$VPS_HOST:$VPS_PATH/"
  echo "==> Extracting on VPS (existing .env is preserved)..."
  ssh "$VPS_USER@$VPS_HOST" "mkdir -p $VPS_PATH/release && tar -xzf $VPS_PATH/$TARBALL -C $VPS_PATH/release && rm $VPS_PATH/$TARBALL"
  echo ""
  echo "Deployed to $VPS_PATH/release on $VPS_HOST."
  echo "Make sure $VPS_PATH/release/.env has GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY, GOOGLE_SHEET_ID."
  echo "Then (re)start the server, e.g.:"
  echo "  ssh $VPS_USER@$VPS_HOST 'pm2 restart mcwpay-dashboard || PORT=3000 nohup node $VPS_PATH/release/server.js &'"
else
  echo ""
  echo "VPS_HOST/VPS_USER/VPS_PATH not set — skipping auto-upload."
  echo "Manual steps:"
  echo "  1. scp \"$TARBALL\" user@your-vps:/path/to/app/"
  echo "  2. ssh user@your-vps"
  echo "  3. mkdir -p /path/to/app/release && tar -xzf /path/to/app/$TARBALL -C /path/to/app/release"
  echo "  4. Put GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY / GOOGLE_SHEET_ID in /path/to/app/release/.env"
  echo "  5. PORT=3000 node /path/to/app/release/server.js   (or run it under pm2/systemd)"
fi
