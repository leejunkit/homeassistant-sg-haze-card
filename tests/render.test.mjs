/**
 * Render smoke test for dist/haze-card.js.
 *
 * Runs the card inside jsdom with a recorded API payload, so we can assert on
 * the rendered shadow DOM without a browser or a Home Assistant instance.
 *
 *   docker run --rm -v "$PWD":/src:ro -w /app node:20-alpine \
 *     sh -c "cp -r /src/. /app/; npm i --silent jsdom@24 && node tests/render.test.mjs"
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const cardSource = readFileSync(new URL('../dist/haze-card.js', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url), 'utf8'));

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

function makeDom(fetchImpl) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  dom.window.fetch = fetchImpl;
  dom.window.eval(cardSource);
  return dom;
}

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

/** Freeze "now" inside a jsdom window while preserving normal Date parsing. */
function fakeDate(iso) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  return class extends RealDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixed] : args));
    }
    static now() {
      return fixed;
    }
  };
}

async function main() {
  console.log('registration');
  {
    const dom = makeDom(() => jsonResponse(fixture));
    check('custom element defined', !!dom.window.customElements.get('haze-pm25-card'));
    check('registered in window.customCards', (dom.window.customCards || []).some((c) => c.type === 'haze-pm25-card'));
  }

  console.log('happy path (north)');
  {
    const dom = makeDom(() => jsonResponse(fixture));
    const card = dom.window.document.createElement('haze-pm25-card');
    card.setConfig({ region: 'north' });
    dom.window.document.body.appendChild(card);
    await card._refresh();

    const html = card.shadowRoot.innerHTML;
    const expected = fixture.Chart1HRPM25.North.Data.slice(-1)[0].value;
    check('value rendered', html.includes(`>${Math.round(expected)}<`), `expected ${expected}`);
    check('unit rendered', html.includes('\u00b5g/m\u00b3'));
    check('band chip rendered', /Band \d/.test(html));
    check('caption rendered', html.includes('as of'));
    check('sparkline rendered', html.includes('<polyline') && html.includes('<polygon'));
    check('24 points in model', card._model.points.length === 24, `got ${card._model.points.length}`);
    check('low/high footer', html.includes('high'));
    check('no error state', !html.includes('Unavailable'));
    check('card size', card.getCardSize() === 3, `got ${card.getCardSize()}`);
  }

  console.log('every region renders');
  {
    for (const region of ['north', 'south', 'east', 'west', 'central']) {
      const dom = makeDom(() => jsonResponse(fixture));
      const card = dom.window.document.createElement('haze-pm25-card');
      card.setConfig({ region });
      dom.window.document.body.appendChild(card);
      await card._refresh();
      const expected = fixture.Chart1HRPM25[region[0].toUpperCase() + region.slice(1)].Data.slice(-1)[0].value;
      check(
        `${region} shows ${expected}`,
        card.shadowRoot.innerHTML.includes(`>${Math.round(expected)}<`)
      );
    }
  }

  console.log('options');
  {
    const dom = makeDom(() => jsonResponse(fixture));
    const card = dom.window.document.createElement('haze-pm25-card');
    card.setConfig({ region: 'west', title: 'Westside', hours: 6, show_graph: false });
    dom.window.document.body.appendChild(card);
    await card._refresh();
    const html = card.shadowRoot.innerHTML;
    check('custom title used', html.includes('Westside'));
    check('graph hidden', !html.includes('<polyline'));
    check('hours respected', card._model.points.length === 6, `got ${card._model.points.length}`);
    check('card size shrinks', card.getCardSize() === 2, `got ${card.getCardSize()}`);
  }

  console.log('5-minute rounding');
  {
    const API = 'https://www.haze.gov.sg/api/airquality/jsondata/';
    const cases = [
      ['2026-10-16T15:47:00', '15:45'],
      ['2026-10-16T15:45:00', '15:45'],
      ['2026-10-16T15:44:59', '15:40'],
      ['2026-10-16T15:12:00', '15:10'],
      ['2026-10-16T00:59:00', '00:55'],
      ['2026-10-16T23:59:59', '23:55'],
    ];
    for (const [now, expected] of cases) {
      let requested = null;
      const dom = makeDom((url) => {
        requested = url;
        return jsonResponse(fixture);
      });
      dom.window.Date = fakeDate(now);
      const card = dom.window.document.createElement('haze-pm25-card');
      card.setConfig({ region: 'north' });
      await card._refresh();
      const expectedTs = Math.floor(new Date(`${now.slice(0, 10)}T${expected}:00`).getTime() / 1000);
      check(`${now.slice(11)} -> ${expected}`, requested === `${API}${expectedTs}`, requested);
      check(`  _usedTimestamp is the slot`, card._usedTimestamp === expectedTs, card._usedTimestamp);
    }

    // The refresh timer should target the next 5-minute slot, not the next hour.
    let captured = null;
    const dom = makeDom(() => jsonResponse(fixture));
    dom.window.Date = fakeDate('2026-10-16T15:47:00');
    dom.window.setTimeout = (fn, ms) => {
      captured = ms;
      return 0;
    };
    const card = dom.window.document.createElement('haze-pm25-card');
    card.setConfig({ region: 'north' });
    await card._refresh();
    check('schedules 4 min to 15:51 (next 5-minute slot)', captured === 4 * 60 * 1000, captured);
  }

  console.log('bad config');
  {
    const dom = makeDom(() => jsonResponse(fixture));
    const card = dom.window.document.createElement('haze-pm25-card');
    let threw = false;
    try {
      card.setConfig({ region: 'atlantis' });
    } catch (err) {
      threw = /unknown region/.test(err.message);
    }
    check('unknown region throws', threw);

    threw = false;
    try {
      card.setConfig({ region: 'north', hours: 99 });
    } catch (err) {
      threw = /hours/.test(err.message);
    }
    check('bad hours throws', threw);
  }

  console.log('fetch failure + fallback');
  {
    const dom = makeDom(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    const card = dom.window.document.createElement('haze-pm25-card');
    card.setConfig({ region: 'north' });
    dom.window.document.body.appendChild(card);
    await card._refresh();
    check('error state shown', card.shadowRoot.innerHTML.includes('Unavailable'));
    check('retry button shown', !!card.shadowRoot.querySelector('.retry'));
  }

  {
    // First hour 404s, second hour succeeds: the card should walk back.
    let calls = 0;
    const dom = makeDom(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve({ ok: false, status: 404 }) : jsonResponse(fixture);
    });
    const card = dom.window.document.createElement('haze-pm25-card');
    card.setConfig({ region: 'north' });
    dom.window.document.body.appendChild(card);
    await card._refresh();
    check('fell back to earlier hour', calls === 2, `calls=${calls}`);
    check('no error after fallback', !card.shadowRoot.innerHTML.includes('Unavailable'));
  }

  console.log('missing series');
  {
    const dom = makeDom(() => jsonResponse({ ChartAsOfDate: '3pm on 16 Oct 2026' }));
    const card = dom.window.document.createElement('haze-pm25-card');
    card.setConfig({ region: 'north' });
    dom.window.document.body.appendChild(card);
    await card._refresh();
    check('error state shown for missing series', card.shadowRoot.innerHTML.includes('Unavailable'));
  }

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
