# Deployment guide (bookings.boomercheugys.com)

## Data tier (v3)

**Simple, durable, restorable.** The whole data tier is **SQLite** plus a bind mount plus daily hot backups.

### What lives where

| Data | Location | Type | Survives |
|---|---|---|---|
| Active database | `./data/bookingagent.sqlite` (bind mount → container `/app/data`) | SQLite | Container rebuilds, image upgrades, `docker compose down` (NOT removed by `down -v`) |
| Spike artefacts (cookies, HAR) | `./data/spike-*` | files | Same as above |
| Daily backups | `bookingagent_backups` (named Docker volume → container `/app/backups`) | SQLite | Container rebuilds, image upgrades, AND the host's `./backups/` (because backups live in a separate volume) |
| Caddy TLS certs + ACME account | `caddy_data` named volume | files | Container rebuilds |

### Why a bind mount for the DB, named volume for backups

- **Bind mount for the DB** = "simple". You can `ls -la data/`, `sqlite3 data/bookingagent.sqlite`, even `rm -rf node_modules` and reinstall without losing data. Unlike a named volume, a bind mount is not auto-removed by `docker compose down -v`.
- **Named volume for backups** = "durable against host mistakes". If you `rm -rf backups/` by accident, the daily backups still exist in the `bookingagent_backups` Docker volume.

### Backup procedures

```bash
# 1. Manual backup (hot, doesn't take the app down)
tools/backup.sh

# 2. Check DB and backup state
tools/db-stats.sh

# 3. Restore from a backup (default = latest)
tools/restore.sh
tools/restore.sh backups/bookingagent-20260703T143423Z.sqlite

# 4. Deploy with auto-snapshot first
tools/deploy.sh
```

Backups are also written daily by the in-container cron (`BACKUP_CRON`, default `30 2 * * *` — 02:30). The container writes a marker file so the dashboard knows when the last backup ran; the actual `tools/backup.sh` (host-side) is what produces the file.

### Switching to a fully named-volume tier (optional)

If you want the data to live entirely in Docker volumes (more "production idiomatic", less portable), edit `docker-compose.yml`:

```yaml
volumes:
  - bookingagent_data:/app/data      # instead of ./data:/app/data
  - bookingagent_backups:/app/backups
volumes:
  bookingagent_data:                  # add to volumes: block
  bookingagent_backups:
  ...
```

Then copy the existing DB into the volume:
```bash
sudo docker compose up -d app  # creates the volume
sudo docker compose stop app
sudo docker run --rm -v $(pwd)/data:/src -v bookingagent_data:/dst alpine cp /src/bookingagent.sqlite /dst/bookingagent.sqlite
sudo docker compose up -d app
```

After that, the DB lives entirely in `bookingagent_data`. But you lose the ability to `sqlite3 data/bookingagent.sqlite` from the host — you'd have to `docker compose exec app sqlite3 /app/data/bookingagent.sqlite`.

## One-time VPS setup (already done)
```bash
apt update && apt install -y docker.io docker-compose-v2
systemctl enable --now docker
```

## Deploy / upgrade
```bash
cd /opt/kooroo-agent
git pull
tools/deploy.sh             # auto-snapshots DB → builds → restarts
```

The `tools/deploy.sh` script:
1. Snapshots the current DB via `tools/backup.sh --label=pre-deploy`
2. Rebuilds the app image
3. Restarts the app
4. Waits for the health check

If the new build is bad, roll back:
```bash
tools/restore.sh   # picks the most recent backup
```

## First-run: capture the session
The container can't log in to kooroora.asn.au from headless Chromium (Cloudflare + reCAPTCHA), so you capture the session once locally and seed the DB:

```bash
# On your local machine
cp .env.example .env
nano .env       # add KOOROO_SPIKE_USER / KOOROO_SPIKE_PASS
npm install
npm run spike
node tools/import-session.js --label "Andrew" --probe

# Now copy the DB file to the VPS
scp data/bookingagent.sqlite vps:/opt/kooroo-agent/data/
```

After that, the dashboard's **Re-login** button does the spike + import on the server (Playwright runs in the container) so subsequent renewals are automatic.

## DNS + TLS
The Caddyfile uses the Cloudflare DNS challenge. Point `bookings.boomercheugys.com` (and `www.`) at the VPS. Caddy will issue a Let's Encrypt cert on first start.

The Caddy binary used by the container is a custom build at `./caddy-build/caddy` that includes the `caddy-dns/cloudflare` module. Rebuild it with:
```bash
sudo docker run --rm -v $(pwd)/caddy-build:/out caddy:2-builder sh -c '
  apk add --no-cache git
  xcaddy build --with github.com/caddy-dns/cloudflare --output /out/caddy
'
```

## Health
- `GET /healthz` — plain `{ok:true}` (no auth)
- `GET /` — dashboard (admin login required)
- `tools/db-stats.sh` — row counts + backup state

## Backups
- Frequency: daily at 02:30 UTC (configurable via `BACKUP_CRON`)
- Retention: 30 days (configurable via `BACKUP_RETENTION_DAYS`)
- Location: `bookingagent_backups` Docker volume, surfaced as `/app/backups` in the container
- Contents: a SQLite backup file + `.sha256` + `.counts` sidecar per snapshot
- Manual: `tools/backup.sh` (writes a new snapshot + prunes old ones)

## Rotating the Cloudflare API token
Edit `.env`, set `CF_API_TOKEN=<new>`, then `sudo docker compose restart caddy`.

## Resetting everything (DANGER)
```bash
sudo docker compose down -v   # removes containers AND named volumes
sudo rm -rf data/ backups/
# then re-capture the session from your local machine
```
