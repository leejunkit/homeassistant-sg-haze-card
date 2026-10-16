/**
 * End-to-end check: real Home Assistant (docker) + real browser + real API.
 *
 * Onboards the sandbox HA over the API, grabs a token, injects it into the
 * browser's localStorage, opens the YAML dashboard that uses haze-pm25-card,
 * and asserts the cards rendered real data fetched live from haze.gov.sg.
 *
 * Run:
 *   docker run --rm --network hazetest \
 *     -v "$PWD":/src:ro -w /app mcr.microsoft.com/playwright:v1.47.0-jammy \
 *     sh -c "cp -r /src/. /app/ && npm i --silent playwright@1.47.0 && node tests/sandbox/verify.mjs"
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.HA_BASE || 'http://haze-ha:8123';
const CLIENT_ID = `${BASE}/`;
const USER = { username: 'sandbox', password: 'sandbox-password-123' };

let failures = 0;
function check(label, condition, detail) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition ? '' : ` -> ${detail ?? ''}`}`);
  if (!condition) failures += 1;
}

async function json(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${options.method || 'GET'} ${url} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function onboard() {
  const steps = await json(`${BASE}/api/onboarding`);
  if (steps.every((s) => s.done)) {
    console.log('  (already onboarded)');
    return login();
  }

  const { auth_code } = await json(`${BASE}/api/onboarding/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      name: 'Sandbox',
      username: USER.username,
      password: USER.password,
      language: 'en',
    }),
  });

  const tokens = await exchange(auth_code);
  const auth = { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' };
  await json(`${BASE}/api/onboarding/core_config`, { method: 'POST', headers: auth, body: '{}' });
  await json(`${BASE}/api/onboarding/analytics`, { method: 'POST', headers: auth, body: '{}' });
  await json(`${BASE}/api/onboarding/integration`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ client_id: CLIENT_ID, redirect_uri: CLIENT_ID }),
  }).catch(() => {});

  console.log(`  onboarded as ${USER.username}`);
  return tokens;
}

async function exchange(authCode) {
  return json(`${BASE}/auth/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: authCode,
      client_id: CLIENT_ID,
    }),
  });
}

/** Log in as the sandbox user, for reruns where onboarding is already done. */
async function login() {
  const flow = await json(`${BASE}/auth/login_flow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      redirect_uri: CLIENT_ID,
      handler: ['homeassistant', null],
    }),
  });

  const result = await json(`${BASE}/auth/login_flow/${flow.flow_id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, username: USER.username, password: USER.password }),
  });

  if (!result.result) throw new Error(`login failed: ${JSON.stringify(result)}`);
  console.log(`  logged in as ${USER.username}`);
  return exchange(result.result);
}

async function main() {
  console.log('onboarding');
  const tokens = await onboard();

  console.log('browser');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });

  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console: ${msg.text()}`);
  });

  // Establish the origin first so localStorage is writable for it.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ base, t }) => {
      localStorage.setItem(
        'hassTokens',
        JSON.stringify({
          access_token: t.access_token,
          token_type: t.token_type,
          expires_in: t.expires_in,
          refresh_token: t.refresh_token,
          clientId: `${base}/`,
          expires: Date.now() + t.expires_in * 1000,
          hassUrl: base,
        })
      );
    },
    { base: BASE, t: tokens }
  );

  await page.goto(`${BASE}/lovelace/haze`, { waitUntil: 'domcontentloaded' });

  // Playwright selectors pierce shadow DOM (document.querySelectorAll does not),
  // which matters because Home Assistant nests cards inside shadow roots.
  const cards = page.locator('haze-pm25-card');
  await cards.first().waitFor({ timeout: 60000 });
  check('custom element registered in HA', await page.evaluate(() => !!customElements.get('haze-pm25-card')));
  check('4 cards rendered', (await cards.count()) === 4, await cards.count());

  // Wait until every card has resolved its value (i.e. left the Loading state).
  await page.locator('haze-pm25-card .value').last().waitFor({ timeout: 60000 });

  if (process.env.HAZE_DEBUG) {
    console.log('  url:', page.url());
    console.log('  title:', await page.title());
    console.log(
      '  states:',
      JSON.stringify(
        await cards.evaluateAll((els) =>
          els.map((el) => (el.shadowRoot.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60))
        ),
        null,
        2
      )
    );
  }

  const cardData = await cards.evaluateAll((els) =>
    els.map((el) => {
      const root = el.shadowRoot;
      const value = root.querySelector('.value')?.textContent?.trim() ?? null;
      const band = root.querySelector('.chip')?.textContent?.trim() ?? null;
      const caption = root.querySelector('.caption-main')?.textContent?.trim() ?? null;
      return {
        value,
        band,
        caption,
        points: root.querySelectorAll('.spark circle').length,
        hasSvg: !!root.querySelector('svg polyline'),
        text: root.textContent.replace(/\s+/g, ' ').trim(),
      };
    })
  );

  console.log('cards found:', cardData.length);
  for (const c of cardData) {
    console.log(`    value=${c.value} band=${JSON.stringify(c.band)} sparkPoints=${c.points} svg=${c.hasSvg}`);
  }

  check('all cards show a numeric value', cardData.every((c) => /^\d+$/.test(c.value || '')), JSON.stringify(cardData.map((c) => c.value)));
  check('all cards show a band', cardData.every((c) => /Band \d/.test(c.band || '')), JSON.stringify(cardData.map((c) => c.band)));
  check('graph cards have a sparkline', cardData.filter((c) => c.hasSvg).length === 4, cardData.filter((c) => c.hasSvg).length);
  check('no card is in an error state', cardData.every((c) => !c.text.includes('Unavailable')));

  const outDir = process.env.SCREENSHOT_DIR || '/app/tests/sandbox/screenshots';
  mkdirSync(outDir, { recursive: true });
  const shotPath = `${outDir}/haze-cards.png`;
  // Let Home Assistant's view-loading overlay finish fading out before capturing.
  await page.waitForTimeout(3000);
  // Crop to the card grid rather than capturing the whole dashboard chrome.
  try {
    await page.locator('hui-grid-card').first().screenshot({ path: shotPath, timeout: 10000 });
  } catch {
    console.log('  (grid element screenshot unavailable, falling back to full page)');
    await page.screenshot({ path: shotPath, fullPage: true });
  }
  console.log(`  screenshot: ${shotPath}`);

  // Home Assistant's own frontend logs unrelated CSS deprecation warnings; only
  // fail on errors that could come from the card.
  const relevant = consoleErrors.filter((e) => !/Custom state pseudo classes have been changed/.test(e));
  check('no browser errors attributable to the card', relevant.length === 0, relevant.slice(0, 5).join(' | '));
  if (consoleErrors.length !== relevant.length) {
    console.log(`  (ignored ${consoleErrors.length - relevant.length} unrelated HA frontend warning(s))`);
  }

  await browser.close();
  console.log(`\n${failures === 0 ? 'E2E PASSED' : `${failures} E2E CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
