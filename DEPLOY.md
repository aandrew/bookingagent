# Deployment guide (boomercheugys.com)

## One-time VPS setup
```bash
# Ubuntu 22.04+
apt update && apt install -y docker.io docker-compose-v2
systemctl enable --now docker
```

## Deploy
```bash
git clone <your-repo> /opt/kooroo-agent
cd /opt/kooroo-agent
cp .env.example .env
# edit .env:
#   ADMIN_USER, ADMIN_PASS, SESSION_SECRET
#   KOOROO_BASE_URL=https://www.kooroora.asn.au
#   KOOROO_SPIKE_USER=...
#   KOOROO_SPIKE_PASS=...
#   CF_API_TOKEN=<cloudflare token with DNS edit on boomercheugys.com>
nano Caddyfile   # set boomercheugys.com block
docker compose up -d --build
docker compose logs -f app
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

## DNS
The Caddyfile uses the Cloudflare DNS challenge. Point `boomercheugys.com` (and `www.`) at the VPS and Caddy will issue a Let's Encrypt cert on first start.

## Backups
- `data/bookingagent.sqlite` — DB (accounts, sessions, watches, bookings, audit)
- `data/spike-*` — last spike artefacts (only needed for debugging)

Add to cron:
```cron
0 4 * * * tar czf /backup/kooroo-$(date +\%F).tgz /opt/kooroo-agent/data/bookingagent.sqlite
```

## Updating
```bash
git pull
docker compose up -d --build
```

## Health
- `GET /healthz` — plain `{ok:true}` (no auth)
- `GET /` — dashboard (admin login required)
