#!/usr/bin/env bash
# Show quick DB stats: row counts, file size, last backup age, oldest/newest backup.
#
# Usage:
#   tools/db-stats.sh
#   BACKUPS_DIR=/path/to/backups tools/db-stats.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BACKUPS_DIR="${BACKUPS_DIR:-$ROOT/backups}"

echo "=== Database ==="
DB="$ROOT/data/bookingagent.sqlite"
if [ -f "$DB" ]; then
  SIZE=$(stat -c %s "$DB" 2>/dev/null || stat -f %z "$DB")
  printf "  %-22s %s bytes\n" "bookingagent.sqlite" "$SIZE"
  printf "  %-22s %s\n" "modified" "$(date -u -r "$DB" '+%Y-%m-%dT%H:%M:%SZ')"
  if command -v sqlite3 >/dev/null 2>&1; then
    echo "  Row counts:"
    sqlite3 "$DB" "SELECT '    ' || tbl, COUNT(*) FROM (
      SELECT 'accounts' AS tbl FROM accounts UNION ALL
      SELECT 'sessions' FROM sessions UNION ALL
      SELECT 'recurring_bookings' FROM recurring_bookings UNION ALL
      SELECT 'watches' FROM watches UNION ALL
      SELECT 'bookings' FROM bookings UNION ALL
      SELECT 'fire_events' FROM fire_events UNION ALL
      SELECT 'audit_log' FROM audit_log
    ) GROUP BY tbl;" 2>/dev/null | sed 's/|/                    /' || echo "    (sqlite3 not available)"
  fi
else
  echo "  (no DB file at $DB)"
fi

echo ""
echo "=== Backups ($BACKUPS_DIR) ==="
if [ -d "$BACKUPS_DIR" ]; then
  COUNT=$(ls -1 "$BACKUPS_DIR"/bookingagent-*.sqlite 2>/dev/null | wc -l)
  echo "  count: $COUNT"
  if [ "$COUNT" -gt 0 ]; then
    NEWEST=$(ls -1t "$BACKUPS_DIR"/bookingagent-*.sqlite | head -1)
    OLDEST=$(ls -1t "$BACKUPS_DIR"/bookingagent-*.sqlite | tail -1)
    NEWEST_BASE=$(basename "$NEWEST" .sqlite)
    OLDEST_BASE=$(basename "$OLDEST" .sqlite)
    echo "  newest: $NEWEST_BASE"
    echo "  oldest: $OLDEST_BASE"
    echo "  total size: $(du -sh "$BACKUPS_DIR" | awk '{print $1}')"
  fi
else
  echo "  (no backups dir)"
fi
