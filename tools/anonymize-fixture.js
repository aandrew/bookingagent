#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DEFAULT_SOURCE = path.join(__dirname, '..', 'backups');
const SOURCE = process.argv[2] || (() => {
  const files = fs.readdirSync(DEFAULT_SOURCE)
    .filter(f => f.startsWith('bookingagent-') && f.endsWith('.sqlite'))
    .sort();
  if (!files.length) throw new Error(`no backups in ${DEFAULT_SOURCE}`);
  return path.join(DEFAULT_SOURCE, files[files.length - 1]);
})();
const TARGET = process.argv[3] || path.join(__dirname, '..', 'test', 'fixtures', 'bookingagent-debug.sqlite');
const SIDECAR = TARGET + '.anonymized.json';

if (!fs.existsSync(SOURCE)) { console.error(`source not found: ${SOURCE}`); process.exit(2); }
fs.mkdirSync(path.dirname(TARGET), { recursive: true });
for (const f of [TARGET, TARGET + '-wal', TARGET + '-shm', SIDECAR]) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const sourceSha = crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex');
console.log(`[anon] source: ${SOURCE}`);
console.log(`[anon] source sha256: ${sourceSha}`);
console.log(`[anon] target: ${TARGET}`);

async function main() {
  const src = new Database(SOURCE, { readonly: true, fileMustExist: true });
  const result = src.backup(TARGET);
  if (result && typeof result.then === 'function') {
    await result;
  }
  src.close();

  const db = new Database(TARGET);
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = OFF');

  const stats = db.transaction(() => {
    const accountUpdates = db.prepare(`SELECT id, label, username FROM accounts ORDER BY id`).all();
    for (const row of accountUpdates) {
      db.prepare(`UPDATE accounts SET label = ?, username = ?, password = 'REDACTED' WHERE id = ?`)
        .run(`User ${row.id}`, `user${row.id}@example.test`, row.id);
    }

    const sessionUpd = db.prepare(`UPDATE sessions SET cookies_json = '{}', bearer_token = 'REDACTED', csrf_token = 'REDACTED'`).run();
    console.log(`[anon]   sessions: ${sessionUpd.changes} (tokens redacted)`);

    for (const row of accountUpdates) {
      console.log(`[anon]   accounts[${row.id}]: "${row.label}" / "${row.username}" -> "User ${row.id}" / "user${row.id}@example.test" (password REDACTED)`);
    }

    const watchRows = db.prepare(`SELECT id FROM watches ORDER BY id`).all();
    for (const row of watchRows) {
      db.prepare(`UPDATE watches SET label = ? WHERE id = ?`).run(`Watch ${row.id}`, row.id);
    }
    if (watchRows.length) console.log(`[anon]   watches: ${watchRows.length} labels anonymized`);

    const recRows = db.prepare(`SELECT id FROM recurring_bookings ORDER BY id`).all();
    for (const row of recRows) {
      db.prepare(`UPDATE recurring_bookings SET label = ? WHERE id = ?`).run(`Recurring ${row.id}`, row.id);
    }
    if (recRows.length) console.log(`[anon]   recurring_bookings: ${recRows.length} labels anonymized`);

    const redactBody = (body) => {
      if (!body) return { body, changed: false };
      const trimmed = body.trimStart();
      if (trimmed.startsWith('<')) {
        return { body: `[HTML redacted, ${body.length} bytes]`, changed: true };
      }
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const scrubbed = body
          .replace(/"name"\s*:\s*"[^"]*"/g, '"name":"<redacted>"')
          .replace(/"contact_id"\s*:\s*"[^"]*"/g, '"contact_id":"<redacted>"')
          .replace(/"user_id"\s*:\s*"[^"]*"/g, '"user_id":"<redacted>"')
          .replace(/"email"\s*:\s*"[^"]*"/g, '"email":"<redacted>"')
          .replace(/"bookingName"\s*:\s*"[^"]*"/g, '"bookingName":"<redacted>"')
          .replace(/"bookingContactPhone"\s*:\s*"[^"]*"/g, '"bookingContactPhone":"<redacted>"')
          .replace(/"bookingEmail"\s*:\s*"[^"]*"/g, '"bookingEmail":"<redacted>"')
          .replace(/"membershipOrCardNumber"\s*:\s*"[^"]*"/g, '"membershipOrCardNumber":"<redacted>"')
          .replace(/"firstName"\s*:\s*"[^"]*"/g, '"firstName":"<redacted>"')
          .replace(/"lastName"\s*:\s*"[^"]*"/g, '"lastName":"<redacted>"')
          .replace(/"fullName"\s*:\s*"[^"]*"/g, '"fullName":"<redacted>"')
          .replace(/"phone"\s*:\s*"[^"]*"/g, '"phone":"<redacted>"')
          .replace(/"mobile"\s*:\s*"[^"]*"/g, '"mobile":"<redacted>"')
          .replace(/"phoneNumber"\s*:\s*"[^"]*"/g, '"phoneNumber":"<redacted>"')
          .replace(/\b0[2-9][\s-]?\d{1,3}[\s-]?\d{2,4}[\s-]?\d{2,4}\b/g, '<phone>')
          .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<email>');
        return { body: scrubbed, changed: scrubbed !== body };
      }
      return { body, changed: false };
    };

    const auditRows = db.prepare(`SELECT id, response_body FROM audit_log WHERE response_body IS NOT NULL AND response_body != ''`).all();
    const updAudit = db.prepare(`UPDATE audit_log SET response_body = ? WHERE id = ?`);
    let auditScrubbed = 0;
    for (const row of auditRows) {
      const r = redactBody(row.response_body);
      if (r.changed) { updAudit.run(r.body, row.id); auditScrubbed++; }
    }
    console.log(`[anon]   audit_log.response_body: ${auditScrubbed}/${auditRows.length} scrubbed`);

    const fireRows = db.prepare(`SELECT id, response_body FROM fire_events WHERE response_body IS NOT NULL AND response_body != ''`).all();
    const updFire = db.prepare(`UPDATE fire_events SET response_body = ? WHERE id = ?`);
    let fireScrubbed = 0;
    for (const row of fireRows) {
      const r = redactBody(row.response_body);
      if (r.changed) { updFire.run(r.body, row.id); fireScrubbed++; }
    }
    if (fireRows.length) console.log(`[anon]   fire_events.response_body: ${fireScrubbed}/${fireRows.length} scrubbed`);

    const reqRows = db.prepare(`SELECT id, request_body FROM audit_log WHERE request_body IS NOT NULL AND request_body != ''`).all();
    const updReqAudit = db.prepare(`UPDATE audit_log SET request_body = ? WHERE id = ?`);
    let reqScrubbed = 0;
    for (const row of reqRows) {
      const scrubbed = row.request_body.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '<email>');
      if (scrubbed !== row.request_body) { updReqAudit.run(scrubbed, row.id); reqScrubbed++; }
    }
    if (reqScrubbed) console.log(`[anon]   audit_log.request_body: ${reqScrubbed} emails redacted`);

    return { auditScrubbed, fireScrubbed, reqScrubbed, accountCount: accountUpdates.length, watchCount: watchRows.length, recCount: recRows.length };
  })();

  db.close();

  const vacuumDb = new Database(TARGET);
  vacuumDb.pragma('journal_mode = DELETE');
  vacuumDb.exec('VACUUM');
  vacuumDb.close();
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const p = TARGET + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const targetSha = crypto.createHash('sha256').update(fs.readFileSync(TARGET)).digest('hex');
  const targetSize = fs.statSync(TARGET).size;

  const sidecar = {
    generated_at: new Date().toISOString(),
    source: SOURCE,
    source_sha256: sourceSha,
    target: TARGET,
    target_sha256: targetSha,
    target_bytes: targetSize,
    redactions: {
      accounts: { count: stats.accountCount, fields: ['label', 'username', 'password'] },
      sessions: { fields: ['cookies_json', 'bearer_token', 'csrf_token'] },
      watches: { count: stats.watchCount, fields: ['label'] },
      recurring_bookings: { count: stats.recCount, fields: ['label'] },
      audit_log: {
        response_body_rows_scrubbed: stats.auditScrubbed,
        request_body_emails_redacted: stats.reqScrubbed,
        rules: [
          'HTML -> "[HTML redacted, N bytes]"',
          'JSON fields redacted: name, contact_id, user_id, email, bookingName, bookingContactPhone, bookingEmail, membershipOrCardNumber, firstName, lastName, fullName, phone, mobile, phoneNumber',
          'phone pattern -> <phone>, email pattern -> <email>'
        ]
      },
      fire_events: {
        response_body_rows_scrubbed: stats.fireScrubbed,
        rules: ['same as audit_log.response_body']
      }
    },
    kept: {
      bookings_court_date_time_status_external_id: true,
      bookings_raw_json: 'generic API messages (e.g. "Your booking has been made."), no PII',
      watches_court_date_time: true,
      recurring_bookings_courts_time: true,
      audit_log_url_method_status_latency_ts_request_body: true,
      audit_log_request_body: 'form-encoded action params + numeric IDs; emails scrubbed'
    }
  };
  fs.writeFileSync(SIDECAR, JSON.stringify(sidecar, null, 2));
  console.log(`[anon] wrote sidecar: ${SIDECAR}`);
  console.log(`[anon] target sha256: ${targetSha}`);
  console.log(`[anon] target bytes:  ${targetSize}`);
  console.log(`[anon] done.`);
}

main().catch(e => { console.error(e); process.exit(1); });
