// Obnove avtocest: filtri, zemljevid in podrobnosti pogodb DARS iz portala javnih naročil.

import { renderTimeline } from './timeline.js';

const CAT_COLORS = {
  light: {
    gradnja: '#6b5bd6', vozisce: '#c8401a', objekti: '#2a78d6', predori: '#4d4b44', hrup: '#1baf7a',
    ograje: '#d99500', odvodnjavanje: '#0f9fb3', brezine: '#8a5a2b', oprema: '#e06f9b', stavbe: '#9a958a', drugo: '#b8b2a4',
  },
  dark: {
    gradnja: '#8d7ff0', vozisce: '#f0743f', objekti: '#3f8fec', predori: '#bcbab0', hrup: '#22c08a',
    ograje: '#e3a514', odvodnjavanje: '#23b5c9', brezine: '#b07a45', oprema: '#e889b0', stavbe: '#8f8e85', drugo: '#6b6a64',
  },
};
const YEAR_RAMP = { light: ['#2a78d6', '#eda100', '#c8401a'], dark: ['#3f8fec', '#e3a514', '#f0743f'] };
const PAINT = { light: { ring: '#fbf9f4', ink: '#191814' }, dark: { ring: '#14181d', ink: '#eceae3' } };
const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};
const SLOVENIA = [[13.37, 45.42], [16.61, 46.88]];
// 3D plasti: vsaka pogodba je kvader nad osjo ceste, najstarejša spodaj. Tri ravni podrobnosti:
// lo (pregled): koši po 1 km, obe smeri skupaj; mid: po 200 m; hi: po 200 m, vsaka smer na svoji strani osi.
const LODS = ['lo', 'mid', 'hi'];
const LOD = {
  lo: { min: 0, max: 10, half: 520, units: [5, 1500, 7, 650, 8.5, 260, 10, 110] },
  mid: { min: 10, max: 13, half: 120, units: [10, 110, 11.5, 45, 13, 18] },
  hi: { min: 13, max: 24, side: [6, 44], units: [13, 18, 15, 6.5, 17, 2.4] },
};
const LON_M = 111320 * Math.cos((46.1 * Math.PI) / 180);
const LAT_M = 110540;
const SKY = {
  light: { 'sky-color': '#d9e5f1', 'horizon-color': '#efeadf', 'fog-color': '#efeadf', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.8, 'atmosphere-blend': 0 },
  dark: { 'sky-color': '#0b0e12', 'horizon-color': '#1c2127', 'fog-color': '#0d1014', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.8, 'atmosphere-blend': 0 },
};
const PRECISION = {
  km: 'odsek in kilometri (približno)',
  odsek: 'cel odsek (dela so lahko le na delu odseka)',
  objekt: 'objekt po imenu',
  kraj: 'okolica priključka, objekta ali naselja (približno)',
};
const PHASE = {
  oddaja: 'oddaja', neposredna: 'neposredna oddaja', sprememba: 'le objava spremembe',
  aneksi: 'aneksi brez povezane prvotne oddaje',
};
// Oznake nekonsistentnosti pri paru del na istem mestu (pipeline/forensics.py).
const FLAGS = {
  g: ['v garanciji', 'poznejše delo je naročeno v garancijski dobi prejšnjega'],
  i: ['isti izvajalec', 'isti izvajalec je znova plačan za isto mesto v svoji garancijski dobi'],
  r: ['po rekonstrukciji', 'ista dela manj kot 8 let po rekonstrukciji ali novogradnji'],
  p: ['drugo ime', 'ista vrsta dela pod drugim imenom pogodbe'],
};
const FLAG_ORDER = ['i', 'g', 'r', 'p'];
const VIEWS = ['map', 'timeline', 'network', 'forensics'];

const $ = (sel) => document.querySelector(sel);
const num = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 1 });

function money(v) {
  if (v == null) return '–';
  if (v >= 1e9) return `${num1.format(v / 1e9)} mrd €`;
  if (v >= 1e6) return `${(v >= 1e8 ? num : num1).format(v / 1e6)} mio €`;
  if (v >= 1e3) return `${num.format(v / 1e3)} tisoč €`;
  return `${num.format(v)} €`;
}
const moneyFull = (v) => (v == null ? '–' : `${num.format(v)} €`);
function dateSl(iso) {
  if (!iso) return '–';
  const [y, m, d] = iso.split('-');
  return `${+d}. ${+m}. ${y}`;
}
function years(g) {
  const r = Math.round(g * 10) / 10;
  const s = num1.format(r);
  if (!Number.isInteger(r)) return `${s} leta`;
  const n = r % 100;
  return `${s} ${n === 1 ? 'leto' : n === 2 ? 'leti' : n === 3 || n === 4 ? 'leta' : 'let'}`;
}
// »po 1 letu«, »po 3 letih«, »po 2,5 leta«
function after(g) {
  const r = Math.round(g * 10) / 10;
  if (!Number.isInteger(r)) return `po ${num1.format(r)} leta`;
  return `po ${num1.format(r)} ${r === 1 ? 'letu' : 'letih'}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const theme = () => document.documentElement.dataset.theme
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const colorOf = (cat) => CAT_COLORS[theme()][cat] || CAT_COLORS[theme()].drugo;

let DATA;
let P = [];
const byId = new Map();
const pairsOf = new Map();
let CATS = [];
let catLabel = {};
let YMIN = 2009;
let YMAX = 2026;
let state;
let visible = [];
let repeated = new Set();
let map;
let popup;
let showUnlocated = false;
let EXTRA = null;          // forenzika.json (mreža in kazalniki), naloži se ob prvem odprtju pogleda
let AXES = null;           // osi.json (os vsake ceste po 200 m) za 3D plasti, naloži se ob prvem vklopu
let axesLoading = null;
let stackIndex = new Map(); // ključ kupa → id-ji pogodb od najstarejše
let stackSig = '';
let topStacks = [];
let threeOn = false;
const views = {};          // naloženi moduli pogledov Mreža in Forenzika

function defaults() {
  return {
    cats: new Set(CATS.map((c) => c.key)), y0: YMIN, y1: YMAX, roads: null, q: '', firm: '',
    rep: 'all', gap: 10, same: true, approx: true, annex: false, color: 'cat', sel: null, at: null,
    flags: new Set(FLAG_ORDER), heat: false, view: 'map', road: null, zoomKm: null, tlScroll: null,
    three: false, atTitle: null,
  };
}

const flagOk = (pair) => [...(pair.flags || '')].some((f) => state.flags.has(f));
const flagText = (flags) => FLAG_ORDER.filter((f) => flags.includes(f)).map((f) => FLAGS[f][1]).join('; ');

// --- URL ----------------------------------------------------------------------------------

function writeHash() {
  const d = defaults();
  const h = new URLSearchParams();
  if (state.cats.size !== d.cats.size) h.set('vrsta', [...state.cats].join(','));
  if (state.y0 !== d.y0 || state.y1 !== d.y1) h.set('leta', `${state.y0}-${state.y1}`);
  if (state.roads) h.set('cesta', [...state.roads].join(','));
  if (state.q) h.set('q', state.q);
  if (state.firm) h.set('izvajalec', state.firm);
  if (state.view !== 'map') h.set('pogled', state.view);
  if (state.view === 'timeline' && state.road) h.set('os', state.road);
  if (state.rep !== 'all') h.set('ponovitve', state.rep === 'flag' ? 'n' : '1');
  if (state.flags.size !== FLAG_ORDER.length) h.set('zastavice', [...state.flags].join('') || '-');
  if (state.heat) h.set('toplota', '1');
  if (state.three) h.set('3d', '1');
  if (state.gap !== d.gap) h.set('razmik', state.gap);
  if (!state.same) h.set('vse', '1');
  if (!state.approx) h.set('natancno', '1');
  if (state.annex) h.set('aneksi', '1');
  if (state.color !== 'cat') h.set('barva', 'leto');
  if (state.sel) h.set('p', state.sel);
  const s = h.toString();
  history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search);
}

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const s = defaults();
  if (h.get('vrsta')) s.cats = new Set(h.get('vrsta').split(',').filter((k) => catLabel[k]));
  if (h.get('leta')) {
    const [a, b] = h.get('leta').split('-').map(Number);
    if (a && b) { s.y0 = Math.max(YMIN, a); s.y1 = Math.min(YMAX, b); }
  }
  if (h.get('cesta')) s.roads = new Set(h.get('cesta').split(','));
  s.q = h.get('q') || '';
  s.firm = h.get('izvajalec') || '';
  s.rep = h.get('ponovitve') === 'n' ? 'flag' : h.get('ponovitve') ? 'only' : 'all';
  if (h.get('zastavice')) s.flags = new Set([...h.get('zastavice')].filter((f) => FLAGS[f]));
  s.heat = !!h.get('toplota');
  s.three = !!h.get('3d');
  s.view = VIEWS.includes(h.get('pogled')) ? h.get('pogled') : 'map';
  s.road = h.get('os') || null;
  if (h.get('razmik')) s.gap = Number(h.get('razmik')) || s.gap;
  s.same = !h.get('vse');
  s.approx = !h.get('natancno');
  s.annex = !!h.get('aneksi');
  s.color = h.get('barva') === 'leto' ? 'year' : 'cat';
  const sel = Number(h.get('p'));
  s.sel = byId.has(sel) ? sel : null;
  return s;
}

// --- filtri ---------------------------------------------------------------------------------

function baseMatch(p) {
  if (!state.cats.has(p.cat)) return false;
  if (p.y != null && (p.y < state.y0 || p.y > state.y1)) return false;
  if (p.y == null && (state.y0 !== YMIN || state.y1 !== YMAX)) return false;
  if (state.roads && !(p.r || []).some((r) => state.roads.has(r))) return false;
  if (state.annex && !p.m?.length) return false;
  if (state.q && !p.search.includes(state.q.toLowerCase())) return false;
  if (state.firm && !p.firms.includes(state.firm.toLowerCase())) return false;
  return true;
}

const PRECISE = new Set(['km', 'objekt']);
function preciseOk(pair) {
  return state.approx || (PRECISE.has(byId.get(pair.self)?.p) && PRECISE.has(byId.get(pair.other)?.p));
}

function pairOk(pair) {
  if (state.rep === 'flag') {
    if (!flagOk(pair)) return false;
  } else if (pair.gap > state.gap || (state.same && !pair.same)) return false;
  return preciseOk(pair);
}

function applyFilters() {
  const base = P.filter(baseMatch);
  const ids = new Set(base.map((p) => p.i));
  repeated = new Set();
  for (const p of base) {
    if ((pairsOf.get(p.i) || []).some((pair) => pairOk(pair) && ids.has(pair.other))) repeated.add(p.i);
  }
  visible = state.rep !== 'all' ? base.filter((p) => repeated.has(p.i)) : base;
}

function update({ fit = false } = {}) {
  applyFilters();
  syncControls();
  updateMap();
  renderRail();
  renderView();
  writeHash();
  if (fit && state.sel && state.view === 'map') focus(byId.get(state.sel));
}

// --- pogledi --------------------------------------------------------------------------------

function flaggedLater() {
  // Poznejša dela v označenih parih (za obrobo v časovnici).
  const out = new Map();
  const ids = new Set(visible.map((p) => p.i));
  for (const p of visible) {
    for (const pair of pairsOf.get(p.i) || []) {
      if (!pair.later || !pair.flags || !flagOk(pair) || !preciseOk(pair) || !ids.has(pair.other)) continue;
      const prev = out.get(p.i) || '';
      const merged = FLAG_ORDER.filter((f) => prev.includes(f) || pair.flags.includes(f)).join('');
      out.set(p.i, merged);
    }
  }
  return out;
}

function renderView() {
  document.body.dataset.view = state.view;
  $('#timeline').hidden = state.view !== 'timeline';
  $('#wide').hidden = !['network', 'forensics'].includes(state.view);
  $('#view-network').hidden = state.view !== 'network';
  $('#view-forensics').hidden = state.view !== 'forensics';
  if (state.view === 'timeline') {
    renderTimeline($('#timeline'), {
      roads: DATA.roads, list: visible.filter((p) => p.lr && (state.approx || PRECISE.has(p.p))), YMIN, YMAX, state,
      project: (id) => byId.get(id), colorOf, money, years, flagText,
      flaggedLater: flaggedLater(), highlight: highlighted(),
      onSelect: (id) => { state.sel = id; state.at = null; update(); showTab('rail'); },
      rerender: () => { renderView(); writeHash(); },
    });
  } else if (state.view === 'network' || state.view === 'forensics') {
    openWide(state.view);
  }
}

const viewApi = {
  project: (id) => byId.get(id),
  get catLabel() { return catLabel; },
  colorOf,
  money,
  theme,
  projects: () => P,
  pairs: () => DATA.repeats || [],
  splits: () => DATA.splits || [],
  openProject: (id) => { state.view = 'map'; state.sel = id; state.at = null; update({ fit: true }); showTab('rail'); },
  filterFirm: (name) => { state.view = 'map'; state.firm = name; state.sel = null; state.at = null; update(); showTab('map'); },
  // Seznam pogodb iz forenzike na zemljevidu: označene črte in seznam v desnem stolpcu.
  showOnMap: (ids, title) => {
    state.view = 'map';
    state.sel = null;
    state.at = sortIds(ids);
    state.atTitle = title || null;
    update();
    showTab('rail');
    fitIds(state.at);
  },
  showFlag: (flag) => {
    state.view = 'map';
    state.rep = 'flag';
    state.flags = new Set([flag]);
    state.sel = null;
    state.at = null;
    update();
    showTab('map');
    fitIds(visible.map((p) => p.i));
  },
  fly3d: (ll, ids, title) => {
    state.view = 'map';
    state.three = true;
    state.sel = null;
    state.at = ids?.length ? sortIds(ids) : null;
    state.atTitle = ids?.length ? title || null : null;
    update();
    showTab(ids?.length ? 'rail' : 'map');
    if (ll) setTimeout(() => map?.flyTo({ center: ll, zoom: 12.6, pitch: 62, bearing: -28, duration: 1800 }), 80);
  },
};

const byDate = (a, b) => (a.d || '').localeCompare(b.d || '') || a.i - b.i;
function sortIds(ids) {
  return [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean).sort(byDate).map((p) => p.i);
}

function fitIds(ids) {
  if (!map) return;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const id of ids) {
    for (const line of byId.get(id)?.g || []) {
      for (const [x, y] of line) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!Number.isFinite(x0)) return;
  setTimeout(() => map.fitBounds([[x0, y0], [x1, y1]], { padding: 70, maxZoom: 13, duration: 700, bearing: map.getBearing(), pitch: map.getPitch() }), 80);
}

async function openWide(view) {
  const el = $(view === 'network' ? '#view-network' : '#view-forensics');
  if (views[view]) return;
  views[view] = 'loading';
  el.innerHTML = '<p class="wide-loading">Nalagam …</p>';
  try {
    if (!EXTRA) {
      EXTRA = await fetch('data/forenzika.json').then((r) => {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      });
    }
    const mod = await import(view === 'network' ? './network.js' : './forensics.js');
    el.innerHTML = '';
    mod.render(el, EXTRA, viewApi);
    views[view] = mod;
  } catch (error) {
    views[view] = null;
    el.innerHTML = `<p class="wide-loading">Pogleda ni bilo mogoče naložiti (${esc(error.message)}).</p>`;
  }
}

function buildFilters() {
  const counts = {};
  for (const p of P) counts[p.cat] = (counts[p.cat] || 0) + 1;
  $('#f-cats').innerHTML = CATS.filter((c) => counts[c.key]).map((c) => (
    `<button class="chip" type="button" data-cat="${c.key}"><i style="background:${colorOf(c.key)}"></i>${esc(c.label)} <small>${counts[c.key]}</small></button>`
  )).join('');
  $('#f-cats').onclick = (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    const key = b.dataset.cat;
    if (e.altKey || e.metaKey || e.ctrlKey) state.cats = new Set([key]);
    else if (state.cats.has(key)) state.cats.delete(key);
    else state.cats.add(key);
    update();
  };

  const roads = [...new Set(P.flatMap((p) => p.r || []))].sort();
  $('#f-roads').innerHTML = roads.map((r) => `<button class="chip" type="button" data-road="${r}">${r}</button>`).join('');
  $('#f-roads').onclick = (e) => {
    const b = e.target.closest('[data-road]');
    if (!b) return;
    const r = b.dataset.road;
    const set = new Set(state.roads || []);
    if (set.has(r)) set.delete(r); else set.add(r);
    state.roads = set.size ? set : null;
    update();
  };

  for (const id of ['y0', 'y1']) {
    const el = $(`#${id}`);
    el.min = YMIN; el.max = YMAX;
    el.oninput = () => {
      let a = Number($('#y0').value);
      let b = Number($('#y1').value);
      if (a > b) { if (id === 'y0') b = a; else a = b; }
      state.y0 = a; state.y1 = b;
      update();
    };
  }
  const marks = [];
  for (let y = YMIN; y <= YMAX; y += Math.ceil((YMAX - YMIN) / 4)) marks.push(y);
  if (marks.at(-1) !== YMAX) marks.push(YMAX);
  $('#year-marks').innerHTML = marks.map((y) => `<span>${y}</span>`).join('');

  const firms = new Map();
  for (const p of P) for (const w of p.ws || []) firms.set(w, (firms.get(w) || 0) + 1);
  $('#firm-list').innerHTML = [...firms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400)
    .map(([w]) => `<option value="${esc(w)}"></option>`).join('');

  let t;
  $('#f-q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim(); update(); }, 200); };
  $('#f-firm').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { state.firm = e.target.value.trim(); update(); }, 200); };
  segment('#f-rep', (v) => { state.rep = v; update(); });
  segment('#f-color', (v) => { state.color = v; update(); });
  $('#f-gap').onchange = (e) => { state.gap = Number(e.target.value); update(); };
  $('#f-same').onchange = (e) => { state.same = e.target.checked; update(); };
  $('#f-approx').onchange = (e) => { state.approx = e.target.checked; update(); };
  $('#f-annex').onchange = (e) => { state.annex = e.target.checked; update(); };
  $('#f-heat').onchange = (e) => { state.heat = e.target.checked; update(); };
  $('#f-flags').onchange = (e) => {
    const f = e.target.value;
    if (e.target.checked) state.flags.add(f); else state.flags.delete(f);
    update();
  };
  $('#reset').onclick = () => { state = defaults(); update(); map?.fitBounds(SLOVENIA, { padding: 20 }); };
  $('#download').onclick = downloadCsv;
}

function segment(sel, onPick) {
  $(sel).onclick = (e) => {
    const b = e.target.closest('button[data-v]');
    if (b) onPick(b.dataset.v);
  };
}

function syncControls() {
  document.querySelectorAll('#f-cats [data-cat]').forEach((b) => b.classList.toggle('is-on', state.cats.has(b.dataset.cat)));
  document.querySelectorAll('#f-roads [data-road]').forEach((b) => b.classList.toggle('is-on', !!state.roads?.has(b.dataset.road)));
  document.querySelectorAll('#f-rep button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === state.rep));
  document.querySelectorAll('#f-color button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === state.color));
  $('#y0').value = state.y0;
  $('#y1').value = state.y1;
  const span = YMAX - YMIN || 1;
  const fill = $('#year-range .range-fill');
  fill.style.left = `${((state.y0 - YMIN) / span) * 100}%`;
  fill.style.right = `${100 - ((state.y1 - YMIN) / span) * 100}%`;
  $('#year-label').textContent = state.y0 === state.y1 ? state.y0 : `${state.y0}–${state.y1}`;
  $('#f-gap').value = state.gap;
  $('#f-same').checked = state.same;
  $('#f-approx').checked = state.approx;
  $('#f-annex').checked = state.annex;
  $('#f-heat').checked = state.heat;
  document.querySelectorAll('#f-flags input').forEach((i) => { i.checked = state.flags.has(i.value); });
  document.querySelectorAll('#views [data-view]').forEach((b) => b.classList.toggle('is-on', b.dataset.view === state.view));
  document.querySelectorAll('#mode [data-mode]').forEach((b) => {
    const on = (b.dataset.mode === '3d') === state.three;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on);
  });
  if (document.activeElement !== $('#f-q')) $('#f-q').value = state.q;
  if (document.activeElement !== $('#f-firm')) $('#f-firm').value = state.firm;
  renderLegend();
}

// --- zemljevid ------------------------------------------------------------------------------

function colorExpr() {
  const t = theme();
  if (state.color === 'year') {
    const [a, b, c] = YEAR_RAMP[t];
    return ['interpolate', ['linear'], ['get', 'y'], YMIN, a, Math.round((YMIN + YMAX) / 2), b, YMAX, c];
  }
  const pairs = Object.entries(CAT_COLORS[t]).flat();
  return ['match', ['get', 'c'], ...pairs, CAT_COLORS[t].drugo];
}

function features() {
  return {
    type: 'FeatureCollection',
    features: visible
      .filter((p) => p.g && (state.approx || PRECISE.has(p.p)))
      .sort((a, b) => (a.d || '').localeCompare(b.d || ''))
      .map((p) => ({
        type: 'Feature',
        properties: { i: p.i, c: p.cat, y: p.y || YMIN, p: p.p, dir: p.dir || 0 },
        geometry: { type: 'MultiLineString', coordinates: p.g },
      })),
  };
}

// Toplotna karta: točke vsakih ~150 m vzdolž del, ki imajo ponovitev (ali nekonsistentnost) po filtrih;
// teža je število takih parov.
function heatPoints() {
  const ids = new Set(visible.map((p) => p.i));
  const feats = [];
  for (const p of visible) {
    if (!p.g || !(state.approx || PRECISE.has(p.p))) continue;
    const n = (pairsOf.get(p.i) || []).filter((pair) => pairOk(pair) && ids.has(pair.other)).length;
    if (!n) continue;
    for (const line of p.g) {
      for (let k = 0; k < line.length - 1; k++) {
        const [x0, y0] = line[k];
        const [x1, y1] = line[k + 1];
        const meters = Math.hypot((x1 - x0) * 77000, (y1 - y0) * 111000);
        const steps = Math.max(1, Math.round(meters / 150));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          feats.push({ type: 'Feature', properties: { w: n }, geometry: { type: 'Point', coordinates: [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t] } });
        }
      }
    }
  }
  return { type: 'FeatureCollection', features: feats };
}

// Smeri vožnje (šifri 00xx in 06xx) zamaknemo levo in desno od osi; črte so usmerjene v smer naraščajočih km.
const OFFSET = ['interpolate', ['linear'], ['zoom'],
  10, 0,
  13, ['match', ['get', 'dir'], 1, 4, 2, -4, 0],
  16, ['match', ['get', 'dir'], 1, 9, 2, -9, 0]];

function highlighted() {
  if (state.sel) return [state.sel, ...(pairsOf.get(state.sel) || []).map((x) => x.other)];
  return state.at || [];
}

function addLayers() {
  const t = theme();
  map.addSource('works', { type: 'geojson', data: features() });
  map.addSource('heat', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const width = ['interpolate', ['linear'], ['zoom'], 6, 1.8, 9, 3, 12, 5, 15, 8];
  const wider = (n) => ['interpolate', ['linear'], ['zoom'], 6, 1.8 + n, 9, 3 + n, 12, 5 + n, 15, 8 + n];
  map.addLayer({
    id: 'heat', type: 'heatmap', source: 'heat', layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 1, 0.35, 6, 1],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 6, 0.7, 13, 2.2],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 10, 16, 14, 34],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(255,240,200,0)', 0.15, 'rgba(253,215,140,0.55)', 0.4, '#f6a04d', 0.7, '#e0532a', 1, '#a3001b'],
      'heatmap-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'works-case', type: 'line', source: 'works',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': PAINT[t].ring, 'line-width': wider(2.5), 'line-opacity': 0.85, 'line-offset': OFFSET },
  });
  map.addLayer({
    id: 'works-hl', type: 'line', source: 'works', filter: ['in', ['get', 'i'], ['literal', []]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': PAINT[t].ink, 'line-width': wider(5), 'line-offset': OFFSET },
  });
  map.addLayer({
    id: 'works', type: 'line', source: 'works',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': colorExpr(), 'line-width': width, 'line-offset': OFFSET,
      'line-opacity': ['match', ['get', 'p'], ['odsek', 'kraj'], 0.7, 0.95],
    },
  });
  for (const lod of LODS) {
    map.addSource(`stack-${lod}`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: `stack-${lod}`, type: 'fill-extrusion', source: `stack-${lod}`, minzoom: LOD[lod].min, maxzoom: LOD[lod].max,
      layout: { visibility: 'none' },
      paint: {
        'fill-extrusion-color': stackColor(),
        'fill-extrusion-height': stackHeight(LOD[lod].units, 0.8),
        'fill-extrusion-base': stackHeight(LOD[lod].units, 0),
        'fill-extrusion-opacity': 0.93,
      },
    });
  }
  stackSig = '';
  threeOn = false;
}

// Višina plasti k: od k do k + 0,8 enote, enota se z bližanjem manjša (zoom je lahko le na vrhu izraza).
function stackHeight(units, top) {
  const out = ['interpolate', ['exponential', 1.6], ['zoom']];
  for (let i = 0; i < units.length; i += 2) out.push(units[i], ['*', ['+', ['get', 'k'], top], units[i + 1]]);
  return out;
}

// V 3D je temno le izbrana pogodba; pri seznamu (klik na kup, izbor iz forenzike) so druge plasti sive.
function stackColor() {
  const t = theme();
  if (state.sel) return ['case', ['==', ['get', 'i'], state.sel], PAINT[t].ink, colorExpr()];
  if (state.at?.length) return ['case', ['in', ['get', 'i'], ['literal', state.at]], colorExpr(), t === 'dark' ? '#2a3038' : '#d8d3c6'];
  return colorExpr();
}

function setSky() {
  try { map.setSky(SKY[theme()]); } catch { /* starejši brskalniki */ }
}

// Trak ob osi: točke osi, zamaknjene za o0 in o1 metrov desno od smeri naraščajočih km.
function ribbon(pts, o0, o1) {
  const n = pts.length;
  const normals = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const ex = (b[0] - a[0]) * LON_M;
    const ey = (b[1] - a[1]) * LAT_M;
    const len = Math.hypot(ex, ey) || 1;
    return [ey / len, -ex / len];
  });
  const at = (i, o) => [pts[i][0] + (normals[i][0] * o) / LON_M, pts[i][1] + (normals[i][1] * o) / LAT_M];
  const left = pts.map((_, i) => at(i, o0));
  const right = pts.map((_, i) => at(i, o1)).reverse();
  return [...left, ...right, left[0]];
}

function axisPts(road, from, to) {
  const pts = AXES.roads[road] || [];
  const out = [];
  for (let k = from; k <= to && k < pts.length; k++) if (pts[k]) out.push(pts[k]);
  return out.length >= 2 ? out : null;
}

function stackFeatures() {
  const step = AXES.step;
  const per = Math.round(1 / step); // finih košev v km
  const list = visible.filter((p) => p.lr && (state.approx || PRECISE.has(p.p))).sort(byDate);
  const bins = { lo: new Map(), mid: new Map(), hi: new Map() };
  const add = (m, key, p) => {
    const arr = m.get(key);
    if (!arr) m.set(key, [p]);
    else if (arr[arr.length - 1] !== p) arr.push(p);
  };
  for (const p of list) {
    const sides = p.dir === 1 ? ['R'] : p.dir === 2 ? ['L'] : ['L', 'R'];
    for (const [r, a, b] of p.lr) {
      if (!AXES.roads[r]) continue;
      let k0 = Math.ceil(a / step - 0.5);
      let k1 = Math.floor(b / step - 0.5);
      if (k1 < k0) { k0 = Math.floor((a + b) / 2 / step); k1 = k0; }
      for (let k = k0; k <= k1; k++) {
        add(bins.mid, `${r}|${k}`, p);
        add(bins.lo, `${r}|${Math.floor(k / per)}`, p);
        for (const s of sides) add(bins.hi, `${r}|${k}|${s}`, p);
      }
    }
  }
  stackIndex = new Map();
  const out = { lo: [], mid: [], hi: [] };
  const push = (lod, key, arr, ring) => {
    stackIndex.set(`${lod}|${key}`, arr.map((p) => p.i));
    arr.forEach((p, k) => out[lod].push({
      type: 'Feature',
      properties: { i: p.i, c: p.cat, y: p.y || YMIN, k, n: arr.length, sk: `${lod}|${key}` },
      geometry: { type: 'Polygon', coordinates: [ring] },
    }));
  };
  for (const [key, arr] of bins.lo) {
    const [r, K] = key.split('|');
    const pts = axisPts(r, Number(K) * per, (Number(K) + 1) * per);
    if (pts) push('lo', key, arr, ribbon(pts, -LOD.lo.half, LOD.lo.half));
  }
  for (const [key, arr] of bins.mid) {
    const [r, k] = key.split('|');
    const pts = axisPts(r, Number(k), Number(k) + 1);
    if (pts) push('mid', key, arr, ribbon(pts, -LOD.mid.half, LOD.mid.half));
  }
  for (const [key, arr] of bins.hi) {
    const [r, k, s] = key.split('|');
    const pts = axisPts(r, Number(k), Number(k) + 1);
    const [o0, o1] = LOD.hi.side;
    if (pts) push('hi', key, arr, s === 'R' ? ribbon(pts, o0, o1) : ribbon(pts, -o1, -o0));
  }
  // Najvišji kupi (po 1 km) za seznam v desnem stolpcu; sosednji kilometri istega kupa le enkrat.
  const ranked = [...bins.lo.entries()].sort((a, b) => b[1].length - a[1].length);
  topStacks = [];
  for (const [key, arr] of ranked) {
    if (topStacks.length >= 8 || arr.length < 3) break;
    const [r, K] = key.split('|');
    if (topStacks.some((t) => t.road === r && Math.abs(t.km - Number(K)) <= 2)) continue;
    const pts = axisPts(r, Number(K) * per, (Number(K) + 1) * per);
    if (pts) topStacks.push({ key: `lo|${key}`, road: r, km: Number(K), n: arr.length, ll: pts[Math.floor(pts.length / 2)] });
  }
  return out;
}

function stackTitle(sk) {
  const [lod, r, k] = sk.split('|');
  const step = lod === 'lo' ? 1 : AXES.step;
  return `${r} km ${num1.format(Number(k) * step)}–${num1.format((Number(k) + 1) * step)}`;
}

function updateStacks() {
  if (!state.three || !map?.getSource('stack-lo')) return;
  if (!AXES) { loadAxes(); return; }
  const sig = `${state.approx}|${visible.map((p) => p.i).join(',')}`;
  if (sig !== stackSig) {
    stackSig = sig;
    const f = stackFeatures();
    for (const lod of LODS) map.getSource(`stack-${lod}`).setData({ type: 'FeatureCollection', features: f[lod] });
  }
  const color = stackColor();
  for (const lod of LODS) map.setPaintProperty(`stack-${lod}`, 'fill-extrusion-color', color);
}

function loadAxes() {
  if (axesLoading) return;
  axesLoading = fetch('data/osi.json').then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then((d) => {
    AXES = d;
    updateStacks();
    renderRail();
  }).catch((error) => {
    axesLoading = null;
    console.error('Osi cest ni bilo mogoče naložiti', error);
  });
}

function applyThree() {
  if (!map?.getLayer('stack-lo')) return;
  const vis = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  for (const id of ['works', 'works-case', 'works-hl']) vis(id, !state.three);
  vis('heat', !state.three && state.heat);
  for (const lod of LODS) vis(`stack-${lod}`, state.three);
  if (state.three === threeOn) return;
  threeOn = state.three;
  if (state.three) {
    setSky();
    // Ob odprtju strani z #3d=1 brez animacije (v skritem zavihku animacija ne teče).
    const cam = { pitch: 58, bearing: map.getBearing() || -17 };
    if (map.getPitch() < 20) {
      if (document.hidden || !map.loaded()) map.jumpTo(cam);
      else map.easeTo({ ...cam, duration: 900 });
    }
  } else if (map.getPitch() > 0 || map.getBearing()) {
    map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
  }
}

function updateMap() {
  if (!map || !map.getSource('works')) return;
  map.getSource('works').setData(features());
  map.setPaintProperty('works', 'line-color', colorExpr());
  map.setFilter('works-hl', ['in', ['get', 'i'], ['literal', highlighted()]]);
  applyThree();
  updateStacks();
  if (state.heat && !state.three) map.getSource('heat').setData(heatPoints());
  const dim = state.heat ? 0.4 : 1;
  map.setPaintProperty('works', 'line-opacity', ['match', ['get', 'p'], ['odsek', 'kraj'], 0.7 * dim, 0.95 * dim]);
  map.setPaintProperty('works-case', 'line-opacity', 0.85 * dim);
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map', style: STYLES[theme()], bounds: SLOVENIA, fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true }, maxZoom: 17, maxPitch: 72,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right');
  if (new URLSearchParams(location.search).has('debug')) window.__map = map;
  new ResizeObserver(() => map.resize()).observe($('#map'));
  popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
  map.on('style.load', () => { addLayers(); updateMap(); });

  map.on('mousemove', 'works', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const ids = [...new Set(e.features.map((f) => f.properties.i))];
    const p = byId.get(ids[ids.length - 1]);
    if (!p) return;
    const more = ids.length > 1 ? `<div class="tip-meta">na tem mestu ${ids.length} pogodb, kliknite za seznam</div>` : '';
    popup.setLngLat(e.lngLat).setHTML(
      `<div class="tip-title">${esc(p.t)}</div><div class="tip-meta">${p.y ?? ''} · ${money(p.vf ?? p.v)} · ${esc(catLabel[p.cat])}</div>`
      + `${p.lr ? `<div class="tip-meta">${esc(lrText(p))}${p.dir ? ` · smer ${p.dir}` : ''}</div>` : ''}${more}`,
    ).addTo(map);
  });
  map.on('mouseleave', 'works', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
  for (const lod of LODS) {
    map.on('mousemove', `stack-${lod}`, (e) => {
      map.getCanvas().style.cursor = 'pointer';
      const f = e.features[0];
      const p = byId.get(f?.properties.i);
      if (!p) return;
      const { k, n, sk } = f.properties;
      popup.setLngLat(e.lngLat).setHTML(
        `<div class="tip-title">${esc(p.t)}</div><div class="tip-meta">${p.y ?? ''} · ${money(p.vf ?? p.v)} · ${esc(catLabel[p.cat])}</div>`
        + `<div class="tip-meta"><b>plast ${k + 1} od ${n}</b> · ${esc(stackTitle(sk))}${PRECISE.has(p.p) ? '' : ' · približno umeščena'}</div>`
        + '<div class="tip-meta">kliknite za vse pogodbe na tem mestu</div>',
      ).addTo(map);
    });
    map.on('mouseleave', `stack-${lod}`, () => { map.getCanvas().style.cursor = ''; popup.remove(); });
  }
  map.on('click', (e) => {
    const box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    if (state.three) {
      const f = map.queryRenderedFeatures(e.point, { layers: LODS.map((l) => `stack-${l}`) })[0];
      if (f) {
        state.at = stackIndex.get(f.properties.sk) || [f.properties.i];
        state.atTitle = stackTitle(f.properties.sk);
        state.sel = f.properties.i;
        update();
        showTab('rail');
      } else {
        state.sel = null;
        state.at = null;
        update();
      }
      return;
    }
    const ids = [...new Set(map.queryRenderedFeatures(box, { layers: ['works'] }).map((f) => f.properties.i))];
    state.atTitle = null;
    if (ids.length === 1) { state.sel = ids[0]; state.at = null; }
    else if (ids.length > 1) {
      state.sel = null;
      state.at = ids.sort((a, b) => (byId.get(a).d || '').localeCompare(byId.get(b).d || ''));
    } else { state.sel = null; state.at = null; }
    update();
    if (ids.length) showTab('rail');
  });
}

function focus(p) {
  if (!map || !p?.g) return;
  const pts = p.g.flat();
  const lons = pts.map((c) => c[0]);
  const lats = pts.map((c) => c[1]);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
    padding: 80, maxZoom: 13.5, duration: 600, bearing: map.getBearing(), pitch: map.getPitch(),
  });
}

const THREE_NOTE = '<span class="legend-3d"><svg viewBox="0 0 14 16" width="12" height="14" aria-hidden="true"><rect x="2" y="10" width="10" height="4" rx="1"/><rect x="2" y="5.5" width="10" height="3.5" rx="1" opacity=".7"/><rect x="2" y="1" width="10" height="3.5" rx="1" opacity=".45"/></svg>višina: pogodbe na istem mestu, najstarejša spodaj · desni gumb ali Ctrl + vleka: vrtenje in nagib</span>';

function renderLegend() {
  const t = theme();
  if (state.color === 'year') {
    const [a, b, c] = YEAR_RAMP[t];
    $('#legend').innerHTML = `<span>${YMIN}</span><span class="ramp" style="background:linear-gradient(90deg,${a},${b},${c})"></span><span>${YMAX}</span>${state.three ? THREE_NOTE : '<span>prosojno: cel odsek</span>'}`;
    return;
  }
  const shown = CATS.filter((c) => state.cats.has(c.key) && visible.some((p) => p.cat === c.key));
  $('#legend').innerHTML = (shown.map((c) => `<span><i style="background:${colorOf(c.key)}"></i>${esc(c.label)}</span>`).join('')
    || '<span>Ni pogodb za izbrane filtre</span>') + (state.three ? THREE_NOTE : '');
}

// --- desni stolpec -------------------------------------------------------------------------

function item(p, extra = '') {
  const annex = p.m?.length ? `<span class="tag${p.v && p.vf > p.v * 1.1 ? ' warn' : ''}">aneksi ${p.m.length}</span>` : '';
  const loc = p.g ? '' : '<span class="tag">brez lokacije</span>';
  return `<li><button class="item" type="button" data-id="${p.i}">
    <span class="t">${esc(p.t)}</span><span class="v">${money(p.vf ?? p.v)}</span>
    <span class="m"><i class="dot" style="background:${colorOf(p.cat)}"></i>${p.d ? dateSl(p.d) : '–'}${p.ws?.length ? ` · ${esc(p.ws[0])}${p.ws.length > 1 ? ` +${p.ws.length - 1}` : ''}` : ''} ${annex}${loc}${extra}</span>
  </button></li>`;
}

function bars(list) {
  const sums = new Map();
  for (let y = state.y0; y <= state.y1; y++) sums.set(y, 0);
  for (const p of list) if (p.y != null && sums.has(p.y)) sums.set(p.y, sums.get(p.y) + (p.vf ?? p.v ?? 0));
  const entries = [...sums.entries()];
  const max = Math.max(1, ...entries.map((e) => e[1]));
  const w = 400; const h = 120; const pad = 16;
  const bw = (w - 8) / Math.max(1, entries.length);
  const rects = entries.map(([y, v], i) => {
    const bh = (v / max) * (h - pad - 14);
    const x = 4 + i * bw;
    const label = entries.length <= 12 || i % 3 === 0 || i === entries.length - 1 ? `<text x="${x + bw / 2}" y="${h - 3}" text-anchor="middle">${String(y).slice(2)}</text>` : '';
    return `<rect class="bar" x="${x + 1}" y="${h - pad - bh}" width="${Math.max(1, bw - 2)}" height="${bh}"><title>${y}: ${moneyFull(Math.round(v))}</title></rect>${label}`;
  }).join('');
  return `<svg class="bars" viewBox="0 0 ${w} ${h}" role="img" aria-label="Vrednost pogodb po letih">${rects}<text x="4" y="10">${money(max)}</text></svg>`;
}

function flagTags(flags) {
  return FLAG_ORDER.filter((f) => (flags || '').includes(f))
    .map((f) => `<span class="tag flag flag-${f}" title="${esc(FLAGS[f][1])}">${FLAGS[f][0]}</span>`).join('');
}
const lrText = (p) => (p.lr || []).map(([r, a, b]) => `${r} km ${num1.format(a)}–${num1.format(b)}`).join(', ');
function addYears(iso, y) {
  const d = new Date(`${iso}T00:00:00`);
  d.setMonth(d.getMonth() + Math.round(y * 12));
  return `${d.getMonth() + 1}. ${d.getFullYear()}`;
}

function warrantyBlock(p) {
  const pdf = (p.src || []).find(([label]) => label.startsWith('Pogodba'));
  const link = pdf ? ` <a href="${esc(pdf[1])}" target="_blank" rel="noopener">pogodba (PDF)</a>` : '';
  if (p.gw?.length) {
    const ocr = (p.rg || []).some((r) => r.src === 'ocr');
    return `<ul class="warranty">${p.gw.map(([s, y]) => `<li><b>${years(y)}</b><span>${esc(s)}</span></li>`).join('')}</ul>
      <p class="hint">Iz člena o garancijskem roku v pogodbi${ocr ? ', prebrano z OCR' : ''};${link}.
      ${p.wy && p.d ? `Za glavno vrsto dela velja ${years(p.wy)}, torej vsaj do ${addYears(p.d, p.wy)} (rok teče od prevzema del).` : ''}</p>`;
  }
  if (p.rg?.length) return `<p class="hint">Pogodba je v registru pogodb, garancijskega roka v besedilu ni bilo mogoče prebrati.${link}</p>`;
  if ((p.y || 0) >= 2015) return '<p class="hint">Pogodba ni bila najdena v registru pogodb.</p>';
  return '<p class="hint">Register pogodb na portalu vsebuje pogodbe od leta 2015.</p>';
}

function registerText(p) {
  return (p.rg || []).map((r) => {
    const annexSum = (r.a || []).reduce((s, a) => s + (a[1] || 0), 0);
    return `${r.no ? `št. ${esc(r.no)}, ` : ''}sklenjena ${dateSl(r.d)}${r.to ? `, do ${dateSl(r.to)}` : ''}${r.v ? `, ${moneyFull(r.v)}` : ''}`
      + `${r.a?.length ? `<br><span class="hint">${r.a.length} ${r.a.length === 1 ? 'dodatek' : r.a.length === 2 ? 'dodatka' : r.a.length < 5 ? 'dodatki' : 'dodatkov'} v registru${annexSum ? `, skupaj ${moneyFull(annexSum)}` : ''}</span>` : ''}`;
  }).join('<br>');
}

function flaggedPairs() {
  const ids = new Set(visible.map((p) => p.i));
  const out = [];
  for (const p of visible) {
    for (const pair of pairsOf.get(p.i) || []) {
      if (!pair.later || !pair.flags || !flagOk(pair) || !preciseOk(pair) || !ids.has(pair.other)) continue;
      out.push({ later: p, earlier: byId.get(pair.other), pair });
    }
  }
  const rank = (f) => Math.min(...[...f].map((c) => FLAG_ORDER.indexOf(c)));
  return out.sort((a, b) => rank(a.pair.flags) - rank(b.pair.flags) || a.pair.gap - b.pair.gap);
}

function summary() {
  const located = visible.filter((p) => p.g).length;
  const v = visible.reduce((s, p) => s + (p.v || 0), 0);
  const vf = visible.reduce((s, p) => s + (p.vf ?? p.v ?? 0), 0);
  const withMods = visible.filter((p) => p.m?.length).length;
  const ids = new Set(visible.map((p) => p.i));
  const pairs = [];
  const seen = new Set();
  for (const p of visible) {
    for (const pair of pairsOf.get(p.i) || []) {
      if (!pairOk(pair) || !ids.has(pair.other) || !pair.later) continue;
      const key = `${pair.other}-${p.i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ later: p, earlier: byId.get(pair.other), gap: pair.gap, overlap: pair.overlap });
    }
  }
  pairs.sort((a, b) => a.gap - b.gap || b.overlap - a.overlap);

  const firms = new Map();
  for (const p of visible) for (const w of p.ws || []) firms.set(w, (firms.get(w) || 0) + (p.vf ?? p.v ?? 0) / (p.ws.length || 1));
  const topFirms = [...firms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const unlocated = visible.filter((p) => !p.g).sort((a, b) => (b.vf ?? b.v ?? 0) - (a.vf ?? a.v ?? 0));
  const biggest = [...visible].sort((a, b) => (b.vf ?? b.v ?? 0) - (a.vf ?? a.v ?? 0)).slice(0, 8);
  const flagged = flaggedPairs();
  const withWarranty = visible.filter((p) => p.gw?.length).length;

  return `
    <h2>Pregled izbora</h2>
    <p class="sub">${num.format(visible.length)} pogodb, od tega ${num.format(located)} na zemljevidu. Kliknite črto za podrobnosti.</p>
    <div class="kpis">
      <div class="kpi"><b>${money(v)}</b><span>ob oddaji</span></div>
      <div class="kpi"><b>${money(vf)}</b><span>po aneksih</span></div>
      <div class="kpi"><b>${num.format(withMods)}</b><span>z aneksi</span></div>
    </div>
    <h3>Vrednost po letih (po aneksih)</h3>
    ${bars(visible)}
    ${state.three ? stacksBlock() : ''}
    <h3>Nekonsistentnosti · ${num.format(flagged.length)}</h3>
    <p class="sub">Pari na istem mestu, ki jih je težje pojasniti: ${FLAG_ORDER.filter((f) => state.flags.has(f)).map((f) => FLAGS[f][0]).join(', ') || 'nobena oznaka ni izbrana'}. Garancijski rok je znan za ${num.format(withWarranty)} pogodb v izboru.</p>
    ${flagged.length ? `<ul class="list">${flagged.slice(0, 10).map((x) => item(x.later,
      ` ${flagTags(x.pair.flags)}<span>${after(x.pair.gap)} (prej ${x.earlier.y}${x.pair.wy ? `, garancija ${years(x.pair.wy)}` : ''})</span>`)).join('')}</ul>`
      : '<p class="empty">V izboru ni označenih parov.</p>'}
    ${flagged.length > 10 && state.rep !== 'flag' ? `<button class="link more" type="button" data-flag-only>Prikaži le nekonsistentna dela</button>` : ''}
    <h3>Ponovitve na istem mestu · ${num.format(pairs.length)}</h3>
    ${pairs.length ? `<ul class="list">${pairs.slice(0, 12).map((x) => item(x.later,
      ` <span class="tag warn">${after(x.gap)}</span><span>prej ${x.earlier.y}: ${money(x.earlier.vf ?? x.earlier.v)}</span>`)).join('')}</ul>`
      : `<p class="empty">V izboru ni del, ki bi se prekrivala v manj kot ${years(state.gap)}${state.same ? ' z isto vrsto dela' : ''}.</p>`}
    ${pairs.length > 12 ? `<button class="link more" type="button" data-rep-only>Prikaži le ponovljena dela (${num.format(repeated.size)})</button>` : ''}
    <h3>Največji izvajalci</h3>
    ${topFirms.map(([w, s]) => `<div class="firm-row"><button type="button" data-firm="${esc(w)}">${esc(w)}</button><span>${money(s)}</span></div>`).join('') || '<p class="empty">–</p>'}
    <h3>Največje pogodbe</h3>
    <ul class="list">${biggest.map((p) => item(p)).join('')}</ul>
    <h3>Brez lokacije · ${num.format(unlocated.length)}</h3>
    <p class="empty">Teh pogodb ni bilo mogoče umestiti na zemljevid, ker objava ne navaja odseka ali ga ni bilo mogoče prepoznati.</p>
    ${showUnlocated ? `<ul class="list">${unlocated.slice(0, 60).map((p) => item(p)).join('')}</ul>` : ''}
    ${unlocated.length ? `<button class="link more" type="button" data-unlocated>${showUnlocated ? 'Skrij seznam' : 'Prikaži seznam'}</button>` : ''}
  `;
}

function stacksBlock() {
  if (!AXES) return '<h3>Najvišji kupi</h3><p class="empty">Nalagam osi cest …</p>';
  if (!topStacks.length) return '<h3>Najvišji kupi</h3><p class="empty">V izboru ni mest z vsaj tremi pogodbami.</p>';
  return `<h3>Najvišji kupi · 3D</h3>
    <p class="sub">Kilometri osi z največ pogodbami v izboru. Kliknite za pogled od blizu.</p>
    <ul class="list stacks">${topStacks.map((t) => `<li><button class="item" type="button" data-stack="${esc(t.key)}">
      <span class="t">${esc(t.road)} km ${t.km}–${t.km + 1}${stackPlace(t) ? ` · ${esc(stackPlace(t))}` : ''}</span><span class="v">${t.n} plasti</span>
    </button></li>`).join('')}</ul>`;
}

function stackPlace(t) {
  const ticks = DATA.roads?.[t.road]?.ticks || [];
  const near = ticks.filter(([km]) => km >= t.km - 0.5 && km <= t.km + 1.5);
  if (near.length) return near[0][1];
  const before = ticks.filter(([km]) => km < t.km).at(-1);
  const after = ticks.find(([km]) => km > t.km + 1);
  return [before?.[1], after?.[1]].filter(Boolean).join(' – ');
}

function sectionText(s) {
  const codes = s.codes?.length ? `${s.codes.map((c) => String(c).padStart(4, '0')).join('/')} ` : '';
  const span = s.b ? `${s.a} – ${s.b}` : s.a;
  const km = s.km ? `, km ${num1.format(s.km[0])}–${num1.format(s.km[1])}` : '';
  return `${s.road ? `${s.road} ` : ''}${codes}${esc(span)}${km}`;
}

function detail(p) {
  const growth = p.v && p.vf && p.vf !== p.v ? (p.vf / p.v - 1) * 100 : null;
  const partners = (pairsOf.get(p.i) || []).map((x) => ({ ...x, p: byId.get(x.other) }))
    .filter((x) => x.p).sort((a, b) => (a.p.d || '').localeCompare(b.p.d || ''));
  const bidTag = p.b === 1 ? ' <span class="tag warn">ena ponudba</span>' : '';
  return `
    <button class="link back" type="button" data-back>← Nazaj na pregled</button>
    <div class="detail">
      <p class="sub"><i class="dot" style="background:${colorOf(p.cat)}"></i> ${esc((p.c || []).map((c) => catLabel[c]).join(', '))}</p>
      <h2>${esc(p.t)}</h2>
      <dl class="facts">
        <dt>${p.k === 'aneksi' ? 'Prvi aneks' : 'Datum pogodbe'}</dt><dd>${dateSl(p.d)}${p.k !== 'oddaja' ? ` <span class="tag">${PHASE[p.k] || p.k}</span>` : ''}</dd>
        ${p.n ? `<dt>Pogodba DARS</dt><dd class="num">št. ${esc(p.n)}</dd>` : ''}
        ${p.k === 'aneksi' ? `<dt>Skupaj aneksi</dt><dd class="num">${moneyFull(p.vf)}</dd>` : `<dt>Vrednost ob oddaji</dt><dd class="num">${moneyFull(p.v)}</dd>`}
        ${p.e ? `<dt>Ocenjena vrednost</dt><dd class="num">${moneyFull(p.e)}</dd>` : ''}
        ${p.m?.length && p.k !== 'aneksi' ? `<dt>Po aneksih</dt><dd class="num">${moneyFull(p.vf)}${growth != null ? ` <span class="${growth > 0 ? 'up' : ''}">(${growth > 0 ? '+' : ''}${num1.format(growth)} %)</span>` : ''}</dd>` : ''}
        <dt>Izvajalec</dt><dd>${(p.w || []).map(esc).join('<br>') || '–'}${(p.w || []).length > 1 ? '<br><span class="hint">skupna ponudba</span>' : ''}</dd>
        ${p.sub?.length ? `<dt>Podizvajalci</dt><dd>${p.sub.map(esc).join('<br>')}</dd>` : p.rg?.length ? '<dt>Podizvajalci</dt><dd class="hint">v pogodbi niso navedeni ali jih ni bilo mogoče prebrati</dd>' : ''}
        <dt>Ponudbe</dt><dd>${p.b ?? '–'}${bidTag}</dd>
        ${p.rg?.length ? `<dt>Register pogodb</dt><dd>${registerText(p)}</dd>` : ''}
        <dt>Lokacija</dt><dd>${(p.s || []).map(sectionText).join('<br>') || 'ni navedena ali ni prepoznana'}</dd>
        ${p.lr ? `<dt>Na osi ceste</dt><dd>${esc(lrText(p))}${p.dir ? `, smer ${p.dir === 1 ? '00xx' : '06xx'}` : ''} <button class="link inline-link" type="button" data-timeline>na časovnici</button></dd>` : ''}
        ${p.p ? `<dt>Natančnost</dt><dd>${PRECISION[p.p]}</dd>` : ''}
      </dl>
      <h3>Garancija</h3>
      ${warrantyBlock(p)}
      ${p.x ? `<p class="note">${esc(p.x)}</p>` : ''}
      ${p.m?.length ? `<h3>Aneksi in spremembe · ${p.m.length}</h3><ul class="mods">${p.m.map((m) => `
        <li><div class="head"><a href="${esc(m.u)}" target="_blank" rel="noopener">${dateSl(m.d)}</a><span>${m.a ? `+${money(m.a)}` : ''}${m.v0 ? money(m.v0) : ''}${m.v1 ? ` → ${money(m.v1)}` : ''}</span></div>${m.x ? `<p>${esc(m.x)}</p>` : ''}</li>`).join('')}</ul>` : ''}
      <h3>Na istem mestu · ${partners.length}</h3>
      ${partners.length ? `<ul class="list">${partners.map((x) => item(x.p,
        ` <span class="tag${pairOk(x) ? ' warn' : ''}">${x.later ? 'prej' : 'pozneje'} za ${years(x.gap)}</span>${flagTags(x.flags)}<span>${num1.format(x.overlap / 1000)} km skupaj${x.wy ? ` · garancija prejšnjega ${years(x.wy)}` : ''}</span>`)).join('')}</ul>`
        : `<p class="empty">${p.g ? 'V 15 letih pred ali po tej pogodbi ni drugih umeščenih del, ki bi se prekrivala s tem mestom.' : 'Pogodba ni umeščena, zato prekrivanj ni mogoče preveriti.'}</p>`}
      <h3>Viri</h3>
      <div class="sources">${(p.src || []).map(([label, url]) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`).join('')}</div>
    </div>
  `;
}

function atList() {
  const list = state.at.map((id) => byId.get(id)).filter(Boolean);
  return `
    <button class="link back" type="button" data-back>← Nazaj na pregled</button>
    <h2>${esc(state.atTitle || 'Na tem mestu')} · ${list.length} ${list.length === 1 ? 'pogodba' : list.length === 2 ? 'pogodbi' : list.length < 5 ? 'pogodbe' : 'pogodb'}</h2>
    <p class="sub">Razvrščeno po datumu pogodbe${state.three ? ', najstarejša je spodnja plast' : ''}. Izberite pogodbo za podrobnosti.</p>
    <ul class="list" style="margin-top:10px">${list.map((p, k) => item(p, state.three ? ` <span class="tag">plast ${k + 1}</span>` : '')).join('')}</ul>
  `;
}

function renderRail() {
  const rail = $('#rail');
  const sel = state.sel ? byId.get(state.sel) : null;
  rail.innerHTML = sel ? detail(sel) : state.at ? atList() : summary();
}

function bindRail() {
  $('#rail').addEventListener('click', (e) => {
    const target = e.target.closest('[data-id],[data-back],[data-firm],[data-unlocated],[data-rep-only],[data-flag-only],[data-timeline],[data-stack]');
    if (!target) return;
    if (target.dataset.stack) {
      const t = topStacks.find((x) => x.key === target.dataset.stack);
      state.at = stackIndex.get(target.dataset.stack) || [];
      state.atTitle = t ? `${t.road} km ${t.km}–${t.km + 1}` : null;
      state.sel = null;
      update();
      if (t?.ll) map.flyTo({ center: t.ll, zoom: 12.4, pitch: 62, bearing: -28, duration: 1600 });
      return;
    }
    if (target.dataset.id) {
      state.sel = Number(target.dataset.id);
      update({ fit: true });
      $('#rail').scrollTop = 0;
    } else if ('back' in target.dataset) {
      if (state.sel && state.at) state.sel = null;
      else { state.sel = null; state.at = null; }
      update();
    } else if (target.dataset.firm) {
      state.firm = target.dataset.firm;
      update();
    } else if ('unlocated' in target.dataset) {
      showUnlocated = !showUnlocated;
      renderRail();
    } else if ('repOnly' in target.dataset) {
      state.rep = 'only';
      update();
    } else if ('flagOnly' in target.dataset) {
      state.rep = 'flag';
      update();
    } else if ('timeline' in target.dataset) {
      state.view = 'timeline';
      state.road = null;
      update();
      showTab('map');
    }
  });
}

// --- CSV ------------------------------------------------------------------------------------

function downloadCsv() {
  const cols = ['id', 'datum', 'vrsta', 'naslov', 'ceste', 'odseki', 'km_os', 'natancnost', 'vrednost_oddaja_eur', 'vrednost_po_aneksih_eur',
    'aneksi', 'izvajalci', 'podizvajalci', 'ponudbe', 'garancija', 'ponovitve', 'nekonsistentnosti', 'povezava'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = visible.map((p) => {
    const pairs = pairsOf.get(p.i) || [];
    const flags = [...new Set(pairs.filter((x) => x.later).flatMap((x) => [...x.flags]))].map((f) => FLAGS[f][0]).join(' | ');
    return [
      p.i, p.d, catLabel[p.cat], p.t, (p.r || []).join(' '),
      (p.s || []).map((s) => sectionText(s).replace(/&[a-z#0-9]+;/g, '')).join(' | '), lrText(p), p.p || '',
      p.v ?? '', p.vf ?? '', p.m?.length || 0, (p.w || []).join(' | '), (p.sub || []).join(' | '), p.b ?? '',
      (p.gw || []).map(([s, y]) => `${y} let: ${s}`).join(' | '), pairs.filter(pairOk).length, flags, (p.src?.[0] || [])[1] || '',
    ].map(q).join(';');
  });
  const blob = new Blob([`﻿${cols.join(';')}\n${rows.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'obnove-avtocest.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- zagon ----------------------------------------------------------------------------------

function showTab(tab) {
  document.body.dataset.tab = tab;
  if (tab === 'map') setTimeout(() => map?.resize(), 0);
}

function prepare(data) {
  DATA = data;
  CATS = data.meta.categories;
  catLabel = Object.fromEntries(CATS.map((c) => [c.key, c.label]));
  [YMIN, YMAX] = data.meta.years || [2009, new Date().getFullYear()];
  P = data.projects;
  for (const p of P) {
    p.cat = p.c?.[0] || 'drugo';
    p.ws = p.ws || p.w || [];
    p.firms = [...p.ws, ...(p.w || [])].join(' | ').toLowerCase();
    p.search = [p.t, p.x, ...(p.s || []).flatMap((s) => [s.a, s.b, ...(s.named || [])])].join(' ').toLowerCase();
    byId.set(p.i, p);
  }
  for (const [a, b, gap, overlap, same, wy, flags] of data.repeats) {
    if (!byId.has(a) || !byId.has(b)) continue;
    if (!pairsOf.has(a)) pairsOf.set(a, []);
    if (!pairsOf.has(b)) pairsOf.set(b, []);
    const common = { gap, overlap, same: !!same, wy: wy || null, flags: flags || '' };
    pairsOf.get(a).push({ self: a, other: b, ...common, later: false });
    pairsOf.get(b).push({ self: b, other: a, ...common, later: true });
  }
  const m = data.meta;
  $('#stamp').textContent = `zadnja objava ${dateSl(m.newest)} · ${num.format(m.projects)} pogodb${m.warranty ? ` · ${num.format(m.warranty)} z garancijo` : ''}`;
}

async function main() {
  const data = await fetch('data/obnove.json').then((r) => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
  prepare(data);
  buildFilters();
  state = readHash();
  bindRail();
  initMap();
  update({ fit: !!state.sel });
  $('#loading').hidden = true;

  $('#open-method').onclick = () => $('#method').showModal();
  $('#mode').onclick = (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    state.three = b.dataset.mode === '3d';
    update();
  };
  $('#views').onclick = (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    state.view = b.dataset.view;
    update({ fit: state.view === 'map' && !!state.sel });
    if (state.view === 'map') { showTab('map'); setTimeout(() => map?.resize(), 0); }
    if (state.view === 'timeline') showTab('map');
  };
  document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  $('#toggle-theme').onclick = () => {
    const next = theme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage may be blocked */ }
    map.setStyle(STYLES[next]);
    buildFilters();
    update();
    for (const mod of Object.values(views)) if (mod && mod !== 'loading') mod.update?.(viewApi);
  };
  window.addEventListener('hashchange', () => {
    const next = readHash();
    if (next.sel !== state.sel || next.view !== state.view) { state = next; update({ fit: true }); }
  });
}

main().catch((error) => {
  $('#loading').textContent = `Podatkov ni bilo mogoče naložiti (${error.message}).`;
});
