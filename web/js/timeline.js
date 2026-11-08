// Časovnica: dela na izbrani cesti po kilometrih (vodoravno) in letih (navpično).
// Senca pod delom je njegov garancijski rok; delo, ki pade v senco na istem mestu, je v garancijski dobi.

const LANE = 11;      // višina enega pasu (px)
const BAR = 8;
const PAD_YEAR = 6;
const TOP = 132;      // prostor za imena priključkov
const LEFT = 46;
const STRIP = 16;     // pas pogostosti del nad grafom
const LEVELS = [3, 6, 12, 24, 48, 96];   // px na kilometer

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function lanesFor(items) {
  // Pogodbe istega leta razporedimo v pasove, da se ne prekrivajo.
  const lanes = [];
  for (const it of items.sort((a, b) => a.m0 - b.m0 || b.m1 - a.m1)) {
    let k = lanes.findIndex((end) => end < it.m0 - 0.15);
    if (k === -1) { k = lanes.length; lanes.push(0); }
    lanes[k] = it.m1;
    it.lane = k;
  }
  return Math.max(1, lanes.length);
}

export function renderTimeline(el, ctx) {
  const { roads, list, YMIN, YMAX, state } = ctx;
  const counts = {};
  for (const p of list) for (const [ref] of p.lr || []) counts[ref] = (counts[ref] || 0) + 1;
  const refs = Object.keys(roads).filter((r) => counts[r]).sort();
  let road = state.road && roads[state.road] ? state.road : null;
  const sel = state.sel ? ctx.project(state.sel) : null;
  if (sel?.lr?.length && !(sel.lr.some(([r]) => r === road))) road = sel.lr[0][0];
  if (!road) road = refs.sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0] || Object.keys(roads)[0];
  state.road = road;
  const info = roads[road];
  // Brez izbrane povečave cesta zapolni širino (kratke ceste, npr. H3, se raztegnejo).
  const fit = LEVELS.filter((l) => info.length * l <= Math.max(200, el.clientWidth - LEFT - 60));
  const px = state.zoomKm || fit[fit.length - 1] || LEVELS[0];
  const width = Math.ceil(info.length * px) + 24;

  // Dela na tej cesti.
  const items = [];
  for (const p of list) {
    for (const [ref, a, b] of p.lr || []) {
      if (ref !== road || p.y == null) continue;
      items.push({ p, m0: a, m1: Math.max(b, a + 0.2), year: p.y });
    }
  }
  const byYear = new Map();
  for (const it of items) {
    if (!byYear.has(it.year)) byYear.set(it.year, []);
    byYear.get(it.year).push(it);
  }
  const yearTop = new Map();
  let y = TOP + STRIP + 10;
  for (let yr = YMIN; yr <= YMAX; yr++) {
    yearTop.set(yr, y);
    const n = byYear.has(yr) ? lanesFor(byYear.get(yr)) : 1;
    y += n * LANE + PAD_YEAR;
  }
  yearTop.set(YMAX + 1, y);
  const height = y + 8;
  const X = (km) => 12 + km * px;
  const yOf = (it) => yearTop.get(it.year) + it.lane * LANE;
  const yAtYear = (fy) => {
    const yr = Math.floor(fy);
    if (yr > YMAX) return yearTop.get(YMAX + 1);
    const a = yearTop.get(yr) ?? TOP;
    const b = yearTop.get(yr + 1) ?? a;
    return a + (b - a) * (fy - yr);
  };

  const flagged = ctx.flaggedLater;   // Map id → niz oznak
  const hl = new Set(ctx.highlight);
  const itemOf = new Map(items.map((it) => [it.p.i, it]));

  // Pogostost del po kilometrih (pasovi po 0,5 km).
  const bins = new Array(Math.ceil(info.length / 0.5) + 1).fill(0);
  for (const it of items) for (let k = Math.floor(it.m0 / 0.5); k <= Math.floor(it.m1 / 0.5); k++) bins[k] = (bins[k] || 0) + 1;
  const maxBin = Math.max(1, ...bins);
  const strip = bins.map((n, k) => (n ? `<rect x="${X(k * 0.5)}" y="${TOP}" width="${Math.max(1, 0.5 * px)}" height="${STRIP}" fill="var(--heat)" fill-opacity="${(0.15 + 0.85 * n / maxBin).toFixed(2)}"><title>km ${(k * 0.5).toFixed(1)}–${(k * 0.5 + 0.5).toFixed(1)}: ${n} pogodb</title></rect>` : '')).join('');

  // Os: kilometri in priključki.
  const step = px >= 24 ? 1 : px >= 12 ? 2 : px >= 6 ? 5 : 10;
  let axis = '';
  for (let km = 0; km <= info.length; km += step) {
    axis += `<line class="tl-grid" x1="${X(km)}" x2="${X(km)}" y1="${TOP - 4}" y2="${height}"/><text class="tl-km" x="${X(km)}" y="${TOP - 8}">${km}</text>`;
  }
  let lastX = -1e9;
  for (const [km, name] of info.ticks) {
    const x = X(km);
    if (x - lastX < 13) continue;
    lastX = x;
    axis += `<line class="tl-junction" x1="${x}" x2="${x}" y1="${TOP - 22}" y2="${height}"/><text class="tl-name" transform="translate(${x + 3},${TOP - 24}) rotate(-55)">${esc(name)}</text>`;
  }
  let rows = '';
  for (let yr = YMIN; yr <= YMAX; yr++) {
    if ((yr - YMIN) % 2 === 0) rows += `<rect class="tl-band" x="0" y="${yearTop.get(yr) - PAD_YEAR / 2}" width="${width}" height="${yearTop.get(yr + 1) - yearTop.get(yr)}"/>`;
  }

  // Garancijske sence.
  const shadows = items.filter((it) => it.p.wy).map((it) => {
    const y0 = yOf(it) + BAR;
    const fy = it.year + (it.p.d ? (Number(it.p.d.slice(5, 7)) - 1) / 12 : 0) + it.p.wy;
    const y1 = Math.max(y0 + 2, yAtYear(fy));
    return `<rect class="tl-warranty" x="${X(it.m0)}" y="${y0}" width="${Math.max(2, (it.m1 - it.m0) * px)}" height="${y1 - y0}" fill="${ctx.colorOf(it.p.cat)}"><title>Garancija ${esc(ctx.years(it.p.wy))}: ${esc(it.p.t)}</title></rect>`;
  }).join('');

  // Povezave izbrane pogodbe z deli na istem mestu.
  let links = '';
  if (sel && itemOf.has(sel.i)) {
    const a = itemOf.get(sel.i);
    for (const id of ctx.highlight) {
      const b = itemOf.get(id);
      if (!b || b === a) continue;
      links += `<line class="tl-link" x1="${X((a.m0 + a.m1) / 2)}" y1="${yOf(a) + BAR / 2}" x2="${X((b.m0 + b.m1) / 2)}" y2="${yOf(b) + BAR / 2}"/>`;
    }
  }

  const bars = items.map((it) => {
    const f = flagged.get(it.p.i);
    const cls = ['tl-bar', it.p.i === state.sel ? 'is-sel' : hl.has(it.p.i) ? 'is-hl' : '', f ? `flag-${f[0]}` : '', it.p.p === 'odsek' || it.p.p === 'kraj' ? 'approx' : ''].filter(Boolean).join(' ');
    const tip = `${it.p.t}\n${it.p.d || it.year} · ${ctx.money(it.p.vf ?? it.p.v)} · km ${it.m0.toFixed(1)}–${it.m1.toFixed(1)}${f ? `\n${ctx.flagText(f)}` : ''}`;
    return `<rect class="${cls}" data-id="${it.p.i}" x="${X(it.m0)}" y="${yOf(it)}" width="${Math.max(3, (it.m1 - it.m0) * px)}" height="${BAR}" rx="2" fill="${ctx.colorOf(it.p.cat)}"><title>${esc(tip)}</title></rect>`;
  }).join('');

  const years = [];
  for (let yr = YMIN; yr <= YMAX; yr++) years.push(`<text class="tl-year" x="${LEFT - 8}" y="${yearTop.get(yr) + 8}">${yr}</text>`);

  el.innerHTML = `
    <div class="tl-bar-top">
      <div class="chips small" role="group" aria-label="Cesta">${refs.map((r) => `<button class="chip${r === road ? ' is-on' : ''}" type="button" data-road="${r}">${r} <small>${counts[r]}</small></button>`).join('')}</div>
      <div class="tl-zoom" role="group" aria-label="Povečava">
        <button class="ghost icon" type="button" data-zoom="-1" aria-label="Pomanjšaj">−</button>
        <button class="ghost icon" type="button" data-zoom="1" aria-label="Povečaj">+</button>
      </div>
    </div>
    <p class="tl-sub">${esc(road)} ${esc(info.from || '')} – ${esc(info.to || '')} · ${String(info.length).replace('.', ',')} km · ${items.length} pogodb.
      Pas nad grafom kaže, kolikokrat so bila dela na posameznem kilometru. Senca pod delom je garancijski rok iz pogodbe; obroba pomeni nekonsistentnost.</p>
    <div class="tl-wrap">
      <svg class="tl-years" width="${LEFT}" height="${height}" aria-hidden="true">${years.join('')}</svg>
      <div class="tl-scroll" id="tl-scroll">
        <svg class="tl-chart" width="${width}" height="${height}" role="img" aria-label="Dela na cesti ${esc(road)} po kilometrih in letih">
          ${rows}${axis}
          ${strip}${shadows}${links}${bars}
        </svg>
      </div>
    </div>`;

  const scroller = el.querySelector('#tl-scroll');
  if (sel && itemOf.has(sel.i)) {
    const it = itemOf.get(sel.i);
    scroller.scrollLeft = Math.max(0, X((it.m0 + it.m1) / 2) - scroller.clientWidth / 2);
  } else if (state.tlScroll != null) {
    scroller.scrollLeft = state.tlScroll;
  }
  scroller.addEventListener('scroll', () => { state.tlScroll = scroller.scrollLeft; }, { passive: true });
  el.onclick = (e) => {
    const b = e.target.closest('[data-road],[data-zoom],[data-id]');
    if (!b) return;
    if (b.dataset.road) { state.road = b.dataset.road; state.tlScroll = 0; state.zoomKm = null; ctx.rerender(); }
    else if (b.dataset.zoom) {
      const k = Math.max(0, Math.min(LEVELS.length - 1, LEVELS.indexOf(px) + Number(b.dataset.zoom)));
      const center = (scroller.scrollLeft + scroller.clientWidth / 2) / px;
      state.zoomKm = LEVELS[k];
      state.tlScroll = Math.max(0, center * state.zoomKm - scroller.clientWidth / 2);
      ctx.rerender();
    } else if (b.dataset.id) ctx.onSelect(Number(b.dataset.id));
  };
}
