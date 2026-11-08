// Obnove avtocest: filtri, zemljevid in podrobnosti pogodb DARS iz portala javnih naročil.

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
  const s = num1.format(g);
  if (g < 1) return `${s} leta`;
  const whole = Math.round(g);
  return `${s} ${whole === 1 ? 'leto' : whole === 2 ? 'leti' : whole <= 4 ? 'leta' : 'let'}`;
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

function defaults() {
  return {
    cats: new Set(CATS.map((c) => c.key)), y0: YMIN, y1: YMAX, roads: null, q: '', firm: '',
    rep: 'all', gap: 10, same: true, approx: true, annex: false, color: 'cat', sel: null, at: null,
  };
}

// --- URL ----------------------------------------------------------------------------------

function writeHash() {
  const d = defaults();
  const h = new URLSearchParams();
  if (state.cats.size !== d.cats.size) h.set('vrsta', [...state.cats].join(','));
  if (state.y0 !== d.y0 || state.y1 !== d.y1) h.set('leta', `${state.y0}-${state.y1}`);
  if (state.roads) h.set('cesta', [...state.roads].join(','));
  if (state.q) h.set('q', state.q);
  if (state.firm) h.set('izvajalec', state.firm);
  if (state.rep !== 'all') h.set('ponovitve', '1');
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
  s.rep = h.get('ponovitve') ? 'only' : 'all';
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
function pairOk(pair) {
  if (pair.gap > state.gap || (state.same && !pair.same)) return false;
  if (!state.approx) {
    const a = byId.get(pair.self);
    const b = byId.get(pair.other);
    if (!PRECISE.has(a?.p) || !PRECISE.has(b?.p)) return false;
  }
  return true;
}

function applyFilters() {
  const base = P.filter(baseMatch);
  const ids = new Set(base.map((p) => p.i));
  repeated = new Set();
  for (const p of base) {
    if ((pairsOf.get(p.i) || []).some((pair) => pairOk(pair) && ids.has(pair.other))) repeated.add(p.i);
  }
  visible = state.rep === 'only' ? base.filter((p) => repeated.has(p.i)) : base;
}

function update({ fit = false } = {}) {
  applyFilters();
  syncControls();
  updateMap();
  renderRail();
  writeHash();
  if (fit && state.sel) focus(byId.get(state.sel));
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
        properties: { i: p.i, c: p.cat, y: p.y || YMIN, p: p.p },
        geometry: { type: 'MultiLineString', coordinates: p.g },
      })),
  };
}

function highlighted() {
  if (state.sel) return [state.sel, ...(pairsOf.get(state.sel) || []).map((x) => x.other)];
  return state.at || [];
}

function addLayers() {
  const t = theme();
  map.addSource('works', { type: 'geojson', data: features() });
  const width = ['interpolate', ['linear'], ['zoom'], 6, 1.8, 9, 3, 12, 5, 15, 8];
  const wider = (n) => ['interpolate', ['linear'], ['zoom'], 6, 1.8 + n, 9, 3 + n, 12, 5 + n, 15, 8 + n];
  map.addLayer({
    id: 'works-case', type: 'line', source: 'works',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': PAINT[t].ring, 'line-width': wider(2.5), 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: 'works-hl', type: 'line', source: 'works', filter: ['in', ['get', 'i'], ['literal', []]],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': PAINT[t].ink, 'line-width': wider(5) },
  });
  map.addLayer({
    id: 'works', type: 'line', source: 'works',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': colorExpr(), 'line-width': width,
      'line-opacity': ['match', ['get', 'p'], ['odsek', 'kraj'], 0.7, 0.95],
    },
  });
}

function updateMap() {
  if (!map || !map.getSource('works')) return;
  map.getSource('works').setData(features());
  map.setPaintProperty('works', 'line-color', colorExpr());
  map.setFilter('works-hl', ['in', ['get', 'i'], ['literal', highlighted()]]);
}

function initMap() {
  map = new maplibregl.Map({
    container: 'map', style: STYLES[theme()], bounds: SLOVENIA, fitBoundsOptions: { padding: 20 },
    attributionControl: { compact: true }, maxZoom: 17,
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
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
      `<div class="tip-title">${esc(p.t)}</div><div class="tip-meta">${p.y ?? ''} · ${money(p.vf ?? p.v)} · ${esc(catLabel[p.cat])}</div>${more}`,
    ).addTo(map);
  });
  map.on('mouseleave', 'works', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
  map.on('click', (e) => {
    const box = [[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]];
    const ids = [...new Set(map.queryRenderedFeatures(box, { layers: ['works'] }).map((f) => f.properties.i))];
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
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 80, maxZoom: 13.5, duration: 600 });
}

function renderLegend() {
  const t = theme();
  if (state.color === 'year') {
    const [a, b, c] = YEAR_RAMP[t];
    $('#legend').innerHTML = `<span>${YMIN}</span><span class="ramp" style="background:linear-gradient(90deg,${a},${b},${c})"></span><span>${YMAX}</span><span>prosojno: cel odsek</span>`;
    return;
  }
  const shown = CATS.filter((c) => state.cats.has(c.key) && visible.some((p) => p.cat === c.key));
  $('#legend').innerHTML = shown.map((c) => `<span><i style="background:${colorOf(c.key)}"></i>${esc(c.label)}</span>`).join('')
    || '<span>Ni pogodb za izbrane filtre</span>';
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
    <h3>Ponovitve na istem mestu · ${num.format(pairs.length)}</h3>
    ${pairs.length ? `<ul class="list">${pairs.slice(0, 12).map((x) => item(x.later,
      ` <span class="tag warn">po ${years(x.gap)}</span><span>prej ${x.earlier.y}: ${money(x.earlier.vf ?? x.earlier.v)}</span>`)).join('')}</ul>`
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
        <dt>Izvajalec</dt><dd>${(p.w || []).map(esc).join('<br>') || '–'}</dd>
        <dt>Ponudbe</dt><dd>${p.b ?? '–'}${bidTag}</dd>
        <dt>Lokacija</dt><dd>${(p.s || []).map(sectionText).join('<br>') || 'ni navedena ali ni prepoznana'}</dd>
        ${p.p ? `<dt>Natančnost</dt><dd>${PRECISION[p.p]}</dd>` : ''}
        <dt>Garancija</dt><dd>ni v objavi; določena je v pogodbi${p.doc ? ` (<a href="${esc(p.doc)}" target="_blank" rel="noopener">razpisna dokumentacija</a>)` : ''}</dd>
      </dl>
      ${p.x ? `<p class="note">${esc(p.x)}</p>` : ''}
      ${p.m?.length ? `<h3>Aneksi in spremembe · ${p.m.length}</h3><ul class="mods">${p.m.map((m) => `
        <li><div class="head"><a href="${esc(m.u)}" target="_blank" rel="noopener">${dateSl(m.d)}</a><span>${m.a ? `+${money(m.a)}` : ''}${m.v0 ? money(m.v0) : ''}${m.v1 ? ` → ${money(m.v1)}` : ''}</span></div>${m.x ? `<p>${esc(m.x)}</p>` : ''}</li>`).join('')}</ul>` : ''}
      <h3>Na istem mestu · ${partners.length}</h3>
      ${partners.length ? `<ul class="list">${partners.map((x) => item(x.p,
        ` <span class="tag${pairOk(x) ? ' warn' : ''}">${x.later ? 'prej' : 'pozneje'} za ${years(x.gap)}</span><span>${num1.format(x.overlap / 1000)} km skupaj</span>`)).join('')}</ul>`
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
    <h2>Na tem mestu · ${list.length} pogodb</h2>
    <p class="sub">Razvrščeno po datumu pogodbe. Izberite pogodbo za podrobnosti.</p>
    <ul class="list" style="margin-top:10px">${list.map((p) => item(p)).join('')}</ul>
  `;
}

function renderRail() {
  const rail = $('#rail');
  const sel = state.sel ? byId.get(state.sel) : null;
  rail.innerHTML = sel ? detail(sel) : state.at ? atList() : summary();
}

function bindRail() {
  $('#rail').addEventListener('click', (e) => {
    const target = e.target.closest('[data-id],[data-back],[data-firm],[data-unlocated],[data-rep-only]');
    if (!target) return;
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
    }
  });
}

// --- CSV ------------------------------------------------------------------------------------

function downloadCsv() {
  const cols = ['id', 'datum', 'vrsta', 'naslov', 'ceste', 'odseki', 'natancnost', 'vrednost_oddaja_eur', 'vrednost_po_aneksih_eur',
    'aneksi', 'izvajalci', 'ponudbe', 'ponovitve', 'povezava'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = visible.map((p) => [
    p.i, p.d, catLabel[p.cat], p.t, (p.r || []).join(' '),
    (p.s || []).map((s) => sectionText(s).replace(/&[a-z#0-9]+;/g, '')).join(' | '), p.p || '',
    p.v ?? '', p.vf ?? '', p.m?.length || 0, (p.w || []).join(' | '), p.b ?? '',
    (pairsOf.get(p.i) || []).filter(pairOk).length, (p.src?.[0] || [])[1] || '',
  ].map(q).join(';'));
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
  for (const [a, b, gap, overlap, same] of data.repeats) {
    if (!byId.has(a) || !byId.has(b)) continue;
    if (!pairsOf.has(a)) pairsOf.set(a, []);
    if (!pairsOf.has(b)) pairsOf.set(b, []);
    pairsOf.get(a).push({ self: a, other: b, gap, overlap, same: !!same, later: false });
    pairsOf.get(b).push({ self: b, other: a, gap, overlap, same: !!same, later: true });
  }
  const m = data.meta;
  $('#stamp').textContent = `zadnja objava ${dateSl(m.newest)} · ${num.format(m.projects)} pogodb`;
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
  document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  $('#toggle-theme').onclick = () => {
    const next = theme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch { /* storage may be blocked */ }
    map.setStyle(STYLES[next]);
    buildFilters();
    update();
  };
  window.addEventListener('hashchange', () => {
    const next = readHash();
    if (next.sel !== state.sel) { state = next; update({ fit: true }); }
  });
}

main().catch((error) => {
  $('#loading').textContent = `Podatkov ni bilo mogoče naložiti (${error.message}).`;
});
