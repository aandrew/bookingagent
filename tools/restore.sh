#!/usr/bin/env bash
# Restore the SQLite database from a backup.
#   - Verifies SHA256
#   - Stops the app container
#   - Copies the backup into place
#   - Brings the app back up
#   - Re-runs migrations on boot (idempotent)
#
# Usage:
#   tools/restore.sh                       # restore latest
#   tools/restore.sh bookingagent-20260703T120000Z.sqlite   # specific file
#   BACKUPS_DIR=/path/to/backups tools/restore.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BACKUPS_DIR="${BACKUPS_DIR:-$ROOT/backups}"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  TARGET=$(ls -1t "$BACKUPS_DIR"/bookingagent-*.sqlite 2>/dev/null | grep -v '\.tmp$' | head -1 || true)
fi

if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  echo "No backup found. Available:"
  ls -1t "$BACKUPS_DIR"/bookingagent-*.sqlite 2>/dev/null | head -10 || echo "  (none)"
  exit 2
fi

echo "[restore] using: $TARGET"

# Verify SHA256
SHA_FILE="${TARGET}.sha256"
if [ -f "$SHA_FILE" ]; then
  echo "[restore] verifying SHA256..."
  EXPECTED=$(awk '{print $1}' "$SHA_FILE")
  ACTUAL=$(sha256sum "$TARGET" | awk '{print $1}')
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "[restore] SHA256 mismatch"
    echo "  expected: $EXPECTED"
    echo "  actual:   $ACTUAL"
    exit 3
  fi
  echo "[restore] SHA256 OK"
else
  echo "[restore] WARNING: no .sha256 file, skipping verification"
fi

# Stop the app
echo "[restore] stopping app container..."
docker compose stop app

# Snapshot the current DB (in case restore goes wrong)
SNAPSHOT="$BACKUPS_DIR/bookingagent-pre-restore-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
if [ -f "$ROOT/data/bookingagent.sqlite" ]; then
  cp "$ROOT/data/bookingagent.sqlite" "$SNAPSHOT"
  echo "[restore] current DB snapshotted to $SNAPSHOT"
fi

# Copy backup into place
cp "$TARGET" "$ROOT/data/bookingagent.sqlite"
echo "[restore] restored $TARGET -> data/bookingagent.sqlite"

# Restart
echo "[restore] starting app..."
docker compose up -d app
echo "[restore] waiting for health check..."
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    echo "[restore] app is healthy"
    break
  fi
  sleep 1
done

echo "[restore] done"
