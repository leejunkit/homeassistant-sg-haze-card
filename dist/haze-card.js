/**
 * haze-pm25-card
 *
 * A self-contained Lovelace card that shows the Singapore government's 1-hour
 * PM2.5 reading for one region, with a prominent current value and a 24-hour
 * sparkline.
 *
 * Data source (public, CORS-enabled):
 *   GET https://www.haze.gov.sg/api/airquality/jsondata/<unix timestamp>
 * where <unix timestamp> is the current local time floored to the nearest 5 minutes
 * (matching haze.gov.sg's own /api/UnixTime/GetTime endpoint).
 *
 * The card needs no Home Assistant integration, no sensors and no recorder
 * history: each API response already contains the last 24 hourly readings.
 *
 * Version: 1.0.0
 */

const CARD_TAG = 'haze-pm25-card';
const CARD_VERSION = '1.1.0';
const API_BASE = 'https://www.haze.gov.sg/api/airquality/jsondata/';

/**
 * How often the API timestamp advances. haze.gov.sg's own /api/UnixTime/GetTime
 * endpoint floors the time to 5 minutes, so the card matches that.
 * Must divide an hour evenly.
 */
const SLOT_SECONDS = 5 * 60;

/** Region keys are what the user writes in YAML; values are the API's keys. */
const REGIONS = {
  north: 'North',
  south: 'South',
  east: 'East',
  west: 'West',
  central: 'Central',
};

/** NEA 1-hour PM2.5 bands. The API ships the band, we only need the labels. */
const BANDS = {
  1: { label: 'Band 1', descriptor: 'Normal', color: '#479b02' },
  2: { label: 'Band 2', descriptor: 'Elevated', color: '#e0a800' },
  3: { label: 'Band 3', descriptor: 'High', color: '#f58220' },
  4: { label: 'Band 4', descriptor: 'Very High', color: '#e60000' },
};

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };

const FALLBACK_COLOR = 'var(--primary-color, #03a9f4)';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** "III" | 3 | "3" -> 3 */
function bandNumber(band) {
  if (band == null || band === '') return null;
  const s = String(band).trim().toLowerCase();
  if (ROMAN[s] != null) return ROMAN[s];
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/** Current local time floored to the nearest slot (SLOT_SECONDS), as unix seconds. */
function currentSlotSeconds(date) {
  const d = date ? new Date(date) : new Date();
  const stepMinutes = SLOT_SECONDS / 60;
  d.setMinutes(d.getMinutes() - (d.getMinutes() % stepMinutes), 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** "16 Oct 2026 03PM" -> "3pm" */
function clockLabel(dateTime) {
  if (!dateTime) return '';
  const part = String(dateTime).trim().split(/\s+/).pop(); // "03PM"
  const m = /^(\d{1,2})(AM|PM)$/i.exec(part);
  if (!m) return part;
  return `${parseInt(m[1], 10)}${m[2].toLowerCase()}`;
}

/** "3pm on 16 Oct 2026" -> { ms, text: "3pm, 16 Oct 2026" } */
function parseAsOf(asOf) {
  if (!asOf) return null;
  const m = /^(\d{1,2})(am|pm) on (\d{1,2}) (\w{3}) (\d{4})$/i.exec(String(asOf).trim());
  if (!m) return null;
  const hour = (parseInt(m[1], 10) % 12) + (m[2].toLowerCase() === 'pm' ? 12 : 0);
  const parsed = new Date(`${m[3]} ${m[4]} ${m[5]} ${hour}:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return { ms: parsed.getTime(), text: `${parseInt(m[1], 10)}${m[2].toLowerCase()}, ${m[3]} ${m[4]} ${m[5]}` };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** API series -> finite, trimmed list of points. */
function normalizeSeries(data, hours) {
  const points = (Array.isArray(data) ? data : [])
    .map((d) => ({ value: Number(d && d.value), dateTime: d && d.dateTime, band: d && d.band }))
    .filter((p) => Number.isFinite(p.value));
  return hours > 0 ? points.slice(-hours) : points;
}

/** Build everything the renderer needs from one API payload. */
function buildModel(json, regionKey, hours) {
  const regionName = REGIONS[regionKey];
  const series = json && json.Chart1HRPM25 && json.Chart1HRPM25[regionName];
  const points = normalizeSeries(series && series.Data, hours);
  if (!points.length) {
    throw new Error(`No 1-hr PM2.5 readings returned for ${regionName}`);
  }

  const values = points.map((p) => p.value);
  const last = points[points.length - 1];
  const previous = points.length > 1 ? points[points.length - 2] : null;
  const bn = bandNumber(last.band);
  const asOf = parseAsOf(json.ChartAsOfDate);

  return {
    region: regionKey,
    regionName,
    points,
    value: last.value,
    band: bn,
    bandMeta: bn ? BANDS[bn] : null,
    latestTime: last.dateTime,
    delta: previous ? last.value - previous.value : null,
    deltaFrom: previous ? clockLabel(previous.dateTime) : null,
    min: Math.min.apply(null, values),
    max: Math.max.apply(null, values),
    asOfText: asOf ? asOf.text : json.ChartAsOfDate || last.dateTime,
    asOfMs: asOf ? asOf.ms : null,
    fetchedAt: Date.now(),
  };
}

/** Sparkline markup. Colours come from the caller so bands can tint the line. */
function sparkline(points, color) {
  const W = 100;
  const H = 40;
  const PAD = 5;
  const values = points.map((p) => p.value);
  let min = Math.min.apply(null, values);
  let max = Math.max.apply(null, values);
  if (min === max) {
    min -= 1;
    max += 1;
  }

  const n = points.length;
  const xAt = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const yAt = (v) => PAD + (1 - (v - min) / (max - min)) * (H - PAD * 2);

  const coords = points.map((p, i) => [xAt(i), yAt(p.value)]);
  const line = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `0,${H} ${line} ${W},${H}`;
  const [lastX, lastY] = coords[coords.length - 1];

  const hitAreas = points
    .map((p, i) => {
      const [x, y] = coords[i];
      return (
        `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.5" fill="transparent">` +
        `<title>${escapeHtml(`${p.value} \u00b5g/m\u00b3 \u00b7 ${p.dateTime}`)}</title>` +
        `</circle>`
      );
    })
    .join('');

  return (
    `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
    `<polygon points="${area}" fill="${color}" opacity="0.16"></polygon>` +
    `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6" ` +
    `stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>` +
    hitAreas +
    `</svg>` +
    // The dot lives in HTML so it stays circular despite the stretched SVG.
    `<span class="spark-dot" style="left:${((lastX / W) * 100).toFixed(2)}%;top:${((lastY / H) * 100).toFixed(2)}%;background:${color}"></span>`
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                               */
/* ------------------------------------------------------------------ */

class HazePm25Card extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._model = null;
    this._error = null;
    this._loading = true;
    this._usedTimestamp = null;
    this._timer = null;
    this._onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) this._maybeFetch();
    };
  }

  static get version() {
    return CARD_VERSION;
  }

  static getStubConfig() {
    return { region: 'north' };
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new Error(`${CARD_TAG}: configuration is required`);
    }

    const region = String(config.region == null ? 'north' : config.region).toLowerCase();
    if (!REGIONS[region]) {
      throw new Error(
        `${CARD_TAG}: unknown region "${config.region}". Use one of: ${Object.keys(REGIONS).join(', ')}`
      );
    }

    const hours = config.hours == null ? 24 : Number(config.hours);
    if (!Number.isInteger(hours) || hours < 2 || hours > 24) {
      throw new Error(`${CARD_TAG}: "hours" must be an integer between 2 and 24`);
    }

    this._config = {
      region,
      regionLabel: config.title || config.name || REGIONS[region],
      hours,
      showGraph: config.show_graph !== false,
    };
    this._render();
  }

  getCardSize() {
    return this._config && this._config.showGraph ? 3 : 2;
  }

  set hass(hass) {
    this._hass = hass;
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
    }
    this._maybeFetch();
  }

  disconnectedCallback() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /** Fetch only if the current slot isn't loaded yet. */
  _maybeFetch() {
    const slot = currentSlotSeconds();
    if (this._usedTimestamp === slot && !this._error) return;
    this._refresh();
  }

  /** Always fetch (used by tests and the retry button). Overlapping calls share one request. */
  async _refresh() {
    if (!this._config) return undefined;
    if (this._inflight) return this._inflight;
    this._inflight = this._doRefresh().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  async _doRefresh() {
    this._loading = true;
    this._error = null;
    this._render();

    const baseTs = currentSlotSeconds();
    let lastError = null;

    // The newest hour can lag slightly; walk back a few hours before giving up.
    for (let back = 0; back < 3; back += 1) {
      const ts = baseTs - back * 3600;
      try {
        const response = await fetch(`${API_BASE}${ts}`, { cache: 'no-store' });
        if (!response.ok) {
          lastError = new Error(`Haze API returned HTTP ${response.status}`);
          continue;
        }
        const json = await response.json();
        const model = buildModel(json, this._config.region, this._config.hours);
        this._model = model;
        this._usedTimestamp = baseTs;
        this._error = null;
        this._loading = false;
        this._render();
        this._schedule(baseTs);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    this._loading = false;
    this._error = lastError || new Error('Unable to load haze data');
    this._render();
    this._schedule(baseTs);
  }

  /** Re-fetch shortly after the next slot begins. */
  _schedule(baseTs) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const nextSlotMs = (baseTs + SLOT_SECONDS) * 1000 + 60 * 1000; // one minute past the slot
    const delay = Math.max(30000, nextSlotMs - Date.now());
    this._timer = setTimeout(() => {
      this._timer = null;
      this._refresh();
    }, delay);
  }

  _color() {
    return (this._model && this._model.bandMeta && this._model.bandMeta.color) || FALLBACK_COLOR;
  }

  _isStale() {
    if (!this._model || this._model.asOfMs == null) return false;
    return Date.now() - this._model.asOfMs > 3 * 3600 * 1000;
  }

  _render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>${HazePm25Card.styles}</style>
      <ha-card>
        ${this._config ? this._body() : '<div class="empty">Set a <code>region</code> for this card.</div>'}
      </ha-card>
    `;
    const retry = this.shadowRoot.querySelector('.retry');
    if (retry) retry.addEventListener('click', () => this._refresh());
  }

  _body() {
    const region = escapeHtml(this._config.regionLabel);

    if (this._error) {
      return `
        <div class="inner">
          <div class="head"><div class="region">${region}</div></div>
          <div class="state state--error">
            <div class="state-title">Unavailable</div>
            <div class="state-text">${escapeHtml(this._error.message || 'Haze data could not be loaded.')}</div>
            <button class="retry" type="button">Retry</button>
          </div>
        </div>`;
    }

    if (this._loading || !this._model) {
      return `
        <div class="inner">
          <div class="head"><div class="region">${region}</div></div>
          <div class="state"><span class="spinner"></span> Loading haze data&hellip;</div>
        </div>`;
    }

    const m = this._model;
    const color = this._color();
    const band = m.bandMeta;
    const bandChip = band
      ? `<span class="chip" style="--band:${band.color}">${band.label} \u00b7 ${band.descriptor}</span>`
      : '';

    const delta =
      m.delta == null
        ? ''
        : `<span class="delta">${m.delta === 0 ? '\u2192' : m.delta > 0 ? '\u2191' : '\u2193'} ` +
          `${m.delta === 0 ? 'no change' : `${Math.abs(m.delta)} since ${escapeHtml(m.deltaFrom)}`}</span>`;

    const graph = this._config.showGraph
      ? `
        <div class="graph" style="--band:${color}">
          <div class="graph-plot">${sparkline(m.points, color)}</div>
          <div class="axis">
            <span>${escapeHtml(clockLabel(m.points[0].dateTime))}</span>
            <span>${escapeHtml(clockLabel(m.latestTime))}</span>
          </div>
        </div>
        <div class="footer">
          <span>${m.points.length}-hr low ${m.min}</span>
          <span class="footer-sep">&middot;</span>
          <span>high ${m.max} \u00b5g/m\u00b3</span>
        </div>`
      : '';

    return `
      <div class="inner ${this._isStale() ? 'is-stale' : ''}">
        <div class="head">
          <div class="region">${region}</div>
          ${bandChip}
        </div>
        <div class="value-row">
          <span class="value" style="--band:${color}">${Math.round(m.value)}</span>
          <span class="unit">\u00b5g/m\u00b3</span>
        </div>
        <div class="caption">
          <span class="caption-main">1-hr PM2.5 \u00b7 as of ${escapeHtml(m.asOfText)}</span>
          ${delta}
        </div>
        ${graph}
      </div>`;
  }
}

HazePm25Card.styles = `
  :host { display: block; }
  ha-card { display: block; overflow: hidden; }
  .inner {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px;
    color: var(--primary-text-color);
    font-family: var(--paper-font-body1_-_font-family, inherit);
  }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .region {
    font-size: 1rem;
    font-weight: 500;
    letter-spacing: 0.01em;
    color: var(--primary-text-color);
  }
  .chip {
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1;
    padding: 5px 8px;
    border-radius: 999px;
    white-space: nowrap;
    color: var(--band, var(--primary-color));
    background: color-mix(in srgb, var(--band, var(--primary-color)) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--band, var(--primary-color)) 45%, transparent);
  }
  .value-row { display: flex; align-items: baseline; gap: 6px; margin-top: 2px; }
  .value {
    font-size: 2.75rem;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--band, var(--primary-text-color));
    font-variant-numeric: tabular-nums;
  }
  .unit { font-size: 0.85rem; color: var(--secondary-text-color); }
  .caption {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    font-size: 0.78rem;
    color: var(--secondary-text-color);
  }
  .delta { color: var(--secondary-text-color); white-space: nowrap; }
  .is-stale .value { opacity: 0.55; }
  .is-stale .caption-main::after { content: " (stale)"; font-style: italic; }
  .graph { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
  .graph-plot { position: relative; height: 52px; }
  .spark { display: block; width: 100%; height: 100%; }
  .spark-dot {
    position: absolute;
    width: 7px;
    height: 7px;
    margin: -3.5px 0 0 -3.5px;
    border-radius: 50%;
    box-shadow: 0 0 0 2px var(--ha-card-background, var(--card-background-color, #fff));
  }
  .axis {
    display: flex;
    justify-content: space-between;
    font-size: 0.68rem;
    color: var(--secondary-text-color);
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.7rem;
    color: var(--secondary-text-color);
  }
  .footer-sep { opacity: 0.6; }
  .state {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 72px;
    font-size: 0.85rem;
    color: var(--secondary-text-color);
  }
  .state--error { flex-direction: column; align-items: flex-start; gap: 4px; }
  .state-title { font-weight: 600; color: var(--error-color, #db4437); }
  .state-text { font-size: 0.8rem; }
  .empty { padding: 16px; color: var(--secondary-text-color); }
  .retry {
    margin-top: 4px;
    padding: 4px 10px;
    border-radius: 6px;
    border: 1px solid var(--divider-color, #e0e0e0);
    background: transparent;
    color: var(--primary-text-color);
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .spinner {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--divider-color, #e0e0e0);
    border-top-color: var(--primary-color);
    animation: haze-spin 0.8s linear infinite;
  }
  @keyframes haze-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
`;

if (!customElements.get(CARD_TAG)) {
  customElements.define(CARD_TAG, HazePm25Card);
}

if (typeof window !== 'undefined') {
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c && c.type === CARD_TAG)) {
    window.customCards.push({
      type: CARD_TAG,
      name: 'Haze 1-hr PM2.5 Card',
      description: "Singapore NEA 1-hour PM2.5 by region, with a 24-hour trend line.",
      preview: false,
      documentationURL: 'https://www.haze.gov.sg/',
    });
  }
  // Handy for browser-console debugging.
  window.HazePm25Card = HazePm25Card;
}
