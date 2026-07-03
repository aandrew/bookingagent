#!/usr/bin/env node
'use strict';

/**
 * Reads cookies captured by the spike (data/spike-cookies.json), imports them
 * into the database for the given account, then proves the runtime API works
 * by calling getDaySchedule against the real site.
 *
 * Usage:
 *   node tools/import-session.js --label "Andrew"
 *   node tools/import-session.js --label "Andrew" --probe
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const repo = require('../src/db/repo');
const { KoorooClient } = require('../src/kooroo/client');

function parseArgs() {
  const args = { label: null, username: null, probe: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i];
    else if (a === '--username') args.username = argv[++i];
    else if (a === '--probe') args.probe = true;
  }
  return args;
}

async function main() {
  const args = parseArgs();
  db.init();

  const cookiesFile = path.join(config.dataDir, 'spike-cookies.json');
  if (!fs.existsSync(cookiesFile)) {
    console.error('No spike-cookies.json. Run `npm run spike` first.');
    process.exit(2);
  }
  const cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
  if (!cookies.length) {
    console.error('spike-cookies.json is empty.');
    process.exit(2);
  }
  const baseHost = (() => { try { return new URL(require('../src/kooroo/endpoints.json').baseUrl).host; } catch { return 'kooroora.asn.au'; } })();
  const filtered = cookies.filter((c) => c.domain && (c.domain === baseHost || c.domain === '.' + baseHost));
  if (!filtered.length) {
    console.error('No cookies match', baseHost, '— check spike-cookies.json domains:', [...new Set(cookies.map(c => c.domain))]);
    process.exit(2);
  }
  if (filtered.length !== cookies.length) {
    console.log(`Filtered ${cookies.length} → ${filtered.length} cookies (kept only ${baseHost})`);
  }

  // Pick a wordpress auth cookie to derive a username if not given
  const wpAuth = filtered.find((c) => /wordpress_(sec|logged_in)/.test(c.name));
  if (!wpAuth) {
    console.error('No wordpress_* auth cookies found in spike-cookies.json.');
    process.exit(2);
  }
  // The cookie value is URL-encoded: username|expiration|token|hash
  let usernameFromCookie = null;
  try { usernameFromCookie = decodeURIComponent(wpAuth.value).split('|')[0]; } catch {}

  const label = args.label || usernameFromCookie || 'Imported';
  const username = args.username || usernameFromCookie || label;
  const password = process.env.KOOROO_SPIKE_PASS || 'unknown-from-import';

  // Find or create the account
  let account = repo.accounts.byUsername(username);
  if (!account) {
    account = repo.accounts.create({ label, username, password });
    console.log('Created account id', account.id, 'for', username);
  } else {
    account = repo.accounts.update(account.id, { label, password });
    console.log('Updated existing account id', account.id, 'for', username);
  }

  // Persist cookies (as full JSON so the runtime can restore name+domain+path+value+expiry)
  repo.sessions.upsert({
    accountId: account.id,
    cookiesJson: filtered,
  });

  const client = new KoorooClient(account);
  await client.hydrateFromSession();

  if (args.probe) {
    console.log('\nBootstrapping tpcb_court_params...');
    const boot = await client.bootstrapParams();
    if (!boot.ok) {
      console.error('Bootstrap failed:', boot.reason);
      process.exit(3);
    }
    console.log('  user_id    =', client.userId);
    console.log('  contact_id =', client.contactId);
    console.log('  max_hours  =', client.maxHoursPerBooking);
  } else {
    console.log('\nRun with --probe to bootstrap params and test the API.');
  }
}

const { Cookie } = require('tough-cookie');
main().catch((e) => { console.error('IMPORT FAILED:', e.message); process.exit(1); });
