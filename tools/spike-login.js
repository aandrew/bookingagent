#!/usr/bin/env node
'use strict';

/**
 * One-off Playwright spike: log in to kooroora.asn.au, drive a few booking
 * flows, and capture a HAR + cookies + screenshots.
 *
 * Reads creds from .env (KOOROO_SPIKE_USER, KOOROO_SPIKE_PASS) — never commit
 * the real values. See .env.example.
 *
 * Targets: Ultimate Member login form (WordPress) on /login/, then drives
 * /members-court-booking/ which uses a custom "tpcb" court-booking plugin.
 *
 * Outputs (under data/):
 *   spike.har              full request/response archive
 *   spike-cookies.json     cookies after login
 *   spike-manifest.json    which flows were exercised
 *   spike-*.png            screenshots of each step
 *   spike-console.log      browser console output
 *   spike-requests.log     every XHR/fetch URL+method+status we saw
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const config = require('../src/config');

const KNOWN_BOOKING_PATH = '/members-court-booking/';
const KNOWN_LOGIN_PATH = '/login/';

async function main() {
  const baseUrl = config.kooroo.baseUrl;
  const username = process.env.KOOROO_SPIKE_USER;
  const password = process.env.KOOROO_SPIKE_PASS;
  if (!username || !password) {
    console.error('Set KOOROO_SPIKE_USER and KOOROO_SPIKE_PASS in .env (see .env.example).');
    process.exit(2);
  }

  const outDir = path.resolve(config.dataDir);
  fs.mkdirSync(outDir, { recursive: true });

  const headless = (process.env.SPIKE_HEADED || '').toLowerCase() === '1' ? false : true;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    recordHar: { path: path.join(outDir, 'spike.har'), content: 'embed' },
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const consoleLines = [];
  const requestLog = [];
  page.on('console', (msg) => consoleLines.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => consoleLines.push(`[pageerror] ${err.message}`));
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('admin-ajax') || u.includes('/wp-json/') || u.includes('booking') || u.includes('court')) {
      requestLog.push(`> ${req.method()} ${u}  (resource=${req.resourceType()})`);
    }
  });
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('admin-ajax') || u.includes('/wp-json/') || u.includes('booking') || u.includes('court')) {
      requestLog.push(`< ${res.status()} ${res.request().method()} ${u}  (ct=${res.headers()['content-type'] || ''})`);
    }
  });

  const manifest = { steps: [] };

  async function step(name, fn) {
    process.stdout.write(`> ${name} ... `);
    try {
      const r = await fn();
      console.log('ok');
      manifest.steps.push({ name, ok: true, result: r ?? null });
    } catch (e) {
      console.log('FAIL:', e.message);
      manifest.steps.push({ name, ok: false, error: e.message });
      try { await page.screenshot({ path: path.join(outDir, `spike-${name}-FAIL.png`), fullPage: true }); } catch {}
      throw e;
    }
    try { await page.screenshot({ path: path.join(outDir, `spike-${name}.png`), fullPage: true }); } catch {}
  }

  function isLoggedIn() {
    return page.evaluate(() => {
      const body = document.body?.innerText || '';
      return !/login|log in/i.test(document.title) && /logout|my account|dashboard/i.test(body);
    });
  }

  try {
    await step('open-booking-page', async () => {
      // The booking page is gated by login; going there first will redirect us
      // to the login form. Either way we end up on the login page.
      const target = `${baseUrl}${KNOWN_BOOKING_PATH}`;
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      manifest.bookingEntryUrl = page.url();
      return page.url();
    });

    await step('detect-login-form', async () => {
      // Ultimate Member form: look for a text input with name like username-NNNN
      // or the form_id hidden field.
      const formInfo = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const userField = inputs.find((i) => /^username(-\d+)?$/.test(i.name) || /type=(?:text|email)/i.test(i.outerHTML) && /user(name)?/i.test(i.name));
        const passField = inputs.find((i) => /^user_password(-\d+)?$/.test(i.name) || i.type === 'password');
        const formId = (document.querySelector('input[name="form_id"]') || {}).value || null;
        return {
          url: location.href,
          userName: userField?.name || null,
          passName: passField?.name || null,
          formId,
          hasSubmit: !!document.querySelector('input[type="submit"], button[type="submit"], #um-submit-btn'),
        };
      });
      if (!formInfo.userName || !formInfo.passName) {
        throw new Error(`No login form found. url=${formInfo.url} formId=${formInfo.formId} hasSubmit=${formInfo.hasSubmit}`);
      }
      manifest.loginForm = formInfo;
      return formInfo;
    });

    await step('fill-credentials', async () => {
      const f = manifest.loginForm;
      await page.fill(`input[name="${f.userName}"]`, username);
      await page.fill(`input[name="${f.passName}"]`, password);
    });

    await step('submit-login', async () => {
      const submitSel = '#um-submit-btn, input[type="submit"], button[type="submit"]';
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {}),
        page.click(submitSel),
      ]);
      await page.waitForTimeout(1500);
    });

    await step('post-login-state', async () => {
      const url = page.url();
      manifest.postLoginUrl = url;
      const text = (await page.textContent('body').catch(() => '')) || '';
      const looksLikeLogin = /incorrect|password|invalid|try again/i.test(text) && /username|user_password/i.test(text);
      if (looksLikeLogin) throw new Error('Login appears to have failed (still on login form with error text)');
      return { url, loggedIn: await isLoggedIn() };
    });

    await step('navigate-to-booking', async () => {
      if (!page.url().endsWith(KNOWN_BOOKING_PATH)) {
        await page.goto(`${baseUrl}${KNOWN_BOOKING_PATH}`, { waitUntil: 'networkidle', timeout: 30_000 });
      }
      // Let any AJAX (calendar load) settle.
      await page.waitForTimeout(3000);
      const probe = await page.evaluate(() => {
        const tpcb = !!document.querySelector('#tpcb-calendar, .tpcb-court-time-slots, #tpcb-booking-form');
        const title = document.title;
        const tpcbFormText = (document.querySelector('#tpcb-booking-form')?.innerText) || '';
        const params = (typeof tpcb_court_params !== 'undefined') ? tpcb_court_params : null;
        return { tpcb, title, tpcbFormTextPreview: tpcbFormText.slice(0, 300), tpcbParams: params };
      });
      manifest.bookingProbe = probe;
      if (probe.tpcbParams) {
        fs.writeFileSync(path.join(outDir, 'spike-tpcb-params.json'), JSON.stringify(probe.tpcbParams, null, 2));
      }
      return probe;
    });

    await step('dump-cookies', async () => {
      const cookies = await context.cookies();
      fs.writeFileSync(path.join(outDir, 'spike-cookies.json'), JSON.stringify(cookies, null, 2));
      manifest.cookiesCount = cookies.length;
      return { count: cookies.length, names: cookies.map((c) => c.name) };
    });

  } finally {
    fs.writeFileSync(path.join(outDir, 'spike-manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(outDir, 'spike-console.log'), consoleLines.join('\n'));
    fs.writeFileSync(path.join(outDir, 'spike-requests.log'), requestLog.join('\n'));
    await context.close();
    await browser.close();
    console.log('\nArtifacts in', outDir);
    console.log('  spike.har              request/response archive');
    console.log('  spike-cookies.json     cookies after login');
    console.log('  spike-manifest.json    which steps succeeded');
    console.log('  spike-requests.log     every booking/admin-ajax call');
    console.log('  spike-*.png            screenshots');
    console.log('\nNext: npm run extract');
  }
}

main().catch((e) => {
  console.error('SPIKE FAILED:', e.message);
  process.exit(1);
});
