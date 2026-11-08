// Mreža: izvajalci, partnerji v skupnih ponudbah, podizvajalci in naročniki (d3-force, risanje na canvas).
// Vir: data/forenzika.json → network {nodes, edges}; kazalniki v profilu iz forensics.firms (ujemanje po k === id).

const BUYER = 'DARS';
const KIND_ORDER = ['gradnje', 'storitve', 'blago', 'drugo'];
const ROLE = { izvajalec: 'samostojni izvajalec', partner: 'partner v skupni ponudbi', podizvajalec: 'podizvajalec' };
const MIN_OPTS = [1, 2, 3, 5];
const GROUPS = 8; // barvne skupine (največje); ostale so sive, ker barv ne ponavljamo
const R_MAX = 26; // polmer največjega izvajalca pri povečavi 1
const LIST_MAX = 40;
const NO_REG = 'Podatki iz registra pogodb še niso na voljo.';
const FALLBACK = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

const num = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 1 });
const num3 = new Intl.NumberFormat('sl-SI', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function plural(n, forms) {
  const m = Math.abs(n) % 100;
  return forms[m === 1 ? 0 : m === 2 ? 1 : m === 3 || m === 4 ? 2 : 3];
}
const count = (n, forms) => `${num.format(n)} ${plural(n, forms)}`;
const POG = ['pogodba', 'pogodbi', 'pogodbe', 'pogodb'];
const POV = ['povezava', 'povezavi', 'povezave', 'povezav'];
const POD = ['podjetje', 'podjetji', 'podjetja', 'podjetij'];
const NAR = ['naročnik', 'naročnika', 'naročniki', 'naročnikov'];
function signedPct(x) {
  if (!isNum(x)) return '–';
  const v = Math.round(x * 1000) / 10;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${num1.format(Math.abs(v))} %`;
}
const other = (e, n) => (e.a === n ? e.b : e.a);

let N = null; // stanje pogleda

function money(v) {
  if (N?.api?.money) return N.api.money(v);
  return v == null ? '–' : `${num.format(v)} €`;
}

// --- vstop -------------------------------------------------------------------------------

export function render(el, data, api) {
  if (N) teardown();
  const model = buildModel(data?.network, data?.forensics);
  const kinds = model.kindList.includes('gradnje') ? ['gradnje'] : model.kindList;
  N = {
    el, api, d3: window.d3, ...model,
    state: {
      kinds: new Set(kinds), min: 1, connected: true, dars: false, sel: null, hover: null,
      forced: new Set(), legend: (el.clientWidth || 1000) >= 700,
    },
    vis: new Set(), visEdges: [], drawNodes: [], w: 0, h: 0, dpr: 1, raf: 0, fitted: false, dragging: null,
  };
  el.classList.add('view-network');
  el.innerHTML = shell();
  N.$ = (sel) => el.querySelector(sel);
  N.onKey = (e) => { if (e.key === 'Escape' && N.state.sel) select(null); };
  el.addEventListener('keydown', N.onKey);
  N.$('.net-panel').addEventListener('click', onPanelClick);

  if (!N.d3) return showEmpty('Knjižnica d3 ni naložena.');
  if (!N.nodes.length) {
    renderPanel();
    return showEmpty('Podatki o mreži še niso na voljo.');
  }
  readColors();
  bindControls();
  setupCanvas();
  setupSim();
  applyFilters(true);
}

// Ob menjavi teme preberemo barve iz CSS in narišemo znova.
export function update(api) {
  if (!N) return;
  if (api) N.api = api;
  if (!N.d3 || !N.nodes.length) return;
  readColors();
  schedule();
}

function teardown() {
  N.sim?.stop();
  N.ro?.disconnect();
  cancelAnimationFrame(N.raf);
  N.el.removeEventListener('keydown', N.onKey);
  N = null;
}

// --- model ---------------------------------------------------------------------------------
// Pozor: d3-force na vozlišča zapiše x, y, vx, vy, fx, fy in index; vloge so zato v »roles«, leta v »years«, r je polmer.

function buildModel(net, F) {
  const nodes = (net?.nodes || []).filter((n) => n && n.id != null).map((n) => ({
    id: String(n.id), n: n.n || String(n.id), f: n.f || n.n || String(n.id), t: n.t === 'buyer' ? 'buyer' : 'firm',
    v: +n.v || 0, c: +n.c || 0, k: n.k || [], roles: n.r || [], years: n.y || null, g: +n.g || 0, links: [], sc: 0,
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  for (const row of net?.edges || []) {
    const a = byId.get(String(row[0]));
    const b = byId.get(String(row[1]));
    if (!a || !b || a === b) continue;
    const e = { source: a, target: b, a, b, type: row[2], count: +row[3] || 1, value: +row[4] || 0, dars: a.id === BUYER || b.id === BUYER };
    edges.push(e);
    a.links.push(e);
    b.links.push(e);
    if (e.type === 'podizvajalec') b.sc += e.count;
  }
  let maxV = 1;
  for (const n of nodes) if (n.t === 'firm' && n.v > maxV) maxV = n.v;
  const groups = new Map();
  const kinds = new Map();
  for (const n of nodes) {
    n.cc = n.c + n.sc; // za filter »min. pogodb« štejejo tudi nastopi kot podizvajalec
    n.r = n.t === 'buyer' ? (n.id === BUYER ? 9 : 5.5) : Math.max(3, R_MAX * Math.sqrt(n.v / maxV));
    if (n.t !== 'firm') continue;
    for (const k of n.k) kinds.set(k, (kinds.get(k) || 0) + 1);
    if (n.g > 0) {
      const x = groups.get(n.g) || { g: n.g, size: 0, top: null };
      x.size += 1;
      if (!x.top || n.v > x.top.v) x.top = n;
      groups.set(n.g, x);
    }
  }
  const rank = (k) => (KIND_ORDER.includes(k) ? KIND_ORDER.indexOf(k) : 99);
  const kindList = [...kinds.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const firms = F?.firms || [];
  const hasSubs = edges.some((e) => e.type === 'podizvajalec');
  const names = new Set();
  for (const n of nodes) { names.add(n.n.toLowerCase()); names.add(n.f.toLowerCase()); }
  return {
    nodes, byId, edges, groups, kinds, kindList, names, hasSubs,
    firmsByK: new Map(firms.map((f) => [String(f.k), f])),
    hasReg: hasSubs || (F?.reg_growth?.length > 0) || firms.some((f) => f.subs > 0),
  };
}

function passes(n) {
  const s = N.state;
  if (n.t === 'buyer') return n.id === BUYER ? s.dars : true;
  return (!n.k.length || n.k.some((k) => s.kinds.has(k))) && n.cc >= s.min;
}

function applyFilters(first = false) {
  const s = N.state;
  const keep = (n) => s.forced.has(n.id) || n === s.sel;
  const vis = new Set();
  for (const n of N.nodes) if (n.t === 'firm' && (passes(n) || keep(n))) vis.add(n);
  // sonaročniki: le če so povezani s prikazanim podjetjem
  for (const n of N.nodes) {
    if (n.t === 'buyer' && n.id !== BUYER && (keep(n) || n.links.some((e) => vis.has(other(e, n))))) vis.add(n);
  }
  if (s.connected) {
    for (const n of [...vis]) {
      if (!keep(n) && !n.links.some((e) => !e.dars && vis.has(other(e, n)))) vis.delete(n);
    }
  }
  const dars = N.byId.get(BUYER);
  if (dars && (s.dars || keep(dars))) {
    vis.add(dars);
    dars.fx = 0;
    dars.fy = 0;
  }
  if (s.hover && !vis.has(s.hover)) setHover(null);
  N.vis = vis;
  N.visEdges = N.edges.filter((e) => vis.has(e.a) && vis.has(e.b));
  N.drawNodes = [...vis].sort((a, b) => b.r - a.r); // veliki spodaj, majhni zgoraj

  const simEdges = N.visEdges.filter((e) => !e.dars); // DARS je pritrjen v središču in le narisan
  for (const n of vis) n.sd = 0;
  for (const e of simEdges) { e.a.sd += 1; e.b.sd += 1; }
  seed(vis);
  N.sim.nodes(N.drawNodes);
  N.link.links(simEdges);
  if (first) {
    N.sim.alpha(1);
    if (vis.size > 300) N.sim.tick(Math.min(100, Math.round(vis.size / 8))); // predhodno umirjanje velikih mrež
    fit(false);
    N.sim.restart();
  } else {
    N.sim.alpha(Math.max(N.sim.alpha(), 0.5)).restart();
  }
  syncControls();
  renderLegend();
  renderCount();
  if (!s.sel) renderPanel();
  const anyFirm = [...vis].some((n) => n.t === 'firm');
  showEmpty(anyFirm ? '' : s.kinds.size ? 'Ni podjetij za izbrane filtre.' : 'Izberite vsaj eno vrsto naročil.');
  schedule();
}

// Začetne lege: ob že postavljenem sosedu, sicer po skupinah okoli središča.
function seed(vis) {
  const rnd = N.rnd;
  for (const n of vis) {
    if (Number.isFinite(n.x)) continue;
    if (n.id === BUYER) { n.x = 0; n.y = 0; continue; }
    const nb = n.links.map((e) => other(e, n)).find((o) => o.id !== BUYER && vis.has(o) && Number.isFinite(o.x));
    if (nb) {
      n.x = nb.x + (rnd() - 0.5) * 30;
      n.y = nb.y + (rnd() - 0.5) * 30;
      continue;
    }
    const g = n.t === 'firm' ? n.g : 0;
    const a = g > 0 ? g * 2.39996 : rnd() * Math.PI * 2;
    const rad = g > 0 ? 60 + 30 * Math.sqrt(g) : 200 + rnd() * 140;
    n.x = Math.cos(a) * rad + (rnd() - 0.5) * 40;
    n.y = Math.sin(a) * rad + (rnd() - 0.5) * 40;
  }
}

// --- simulacija ------------------------------------------------------------------------------

function setupSim() {
  const d3 = N.d3;
  N.rnd = d3.randomLcg(7);
  const base = { partner: 1, podizvajalec: 0.6, narocnik: 0.35 };
  const dist = { partner: 24, podizvajalec: 38, narocnik: 50 };
  N.link = d3.forceLink()
    .distance((e) => (dist[e.type] ?? 40) + e.a.r + e.b.r)
    .strength((e) => (base[e.type] ?? 0.5) / Math.max(1, Math.min(e.a.sd, e.b.sd)));
  N.sim = d3.forceSimulation()
    .force('link', N.link)
    .force('charge', d3.forceManyBody().strength((d) => (d.id === BUYER ? 0 : -28 - d.r * 3.2)).distanceMax(380).theta(0.9))
    .force('collide', d3.forceCollide((d) => d.r + 2).iterations(1))
    .force('x', d3.forceX(0).strength(0.05))
    .force('y', d3.forceY(0).strength(0.05))
    .alphaDecay(0.04)
    .velocityDecay(0.42)
    .on('tick', schedule)
    .on('end', () => {
      if (!N || N.fitted) return;
      N.fitted = true;
      fit(true);
    })
    .stop();
}

// --- platno, povečava, vlečenje ------------------------------------------------------------

function setupCanvas() {
  const d3 = N.d3;
  N.stage = N.$('.net-stage');
  N.canvas = N.$('canvas');
  N.ctx = N.canvas.getContext('2d');
  N.tip = N.$('.net-tip');
  N.t = d3.zoomIdentity;
  N.zoom = d3.zoom().scaleExtent([0.04, 8]).on('zoom', (ev) => {
    N.t = ev.transform;
    if (ev.sourceEvent) hideTip();
    schedule();
  });
  const drag = d3.drag().container(N.canvas)
    .subject((ev) => {
      const [x, y] = N.t.invert([ev.x, ev.y]);
      const n = pick(x, y);
      // zaslonske koordinate, da je premik pravilen pri vsaki povečavi
      return n ? { n, x: N.t.applyX(n.x), y: N.t.applyY(n.y) } : null;
    })
    // »start« sproži že pritisk; simulacijo pogrejemo šele ob dejanskem premiku, da klik ne premakne mreže
    .on('drag', (ev) => {
      const n = ev.subject.n;
      if (!N.dragging) {
        N.dragging = n;
        N.sim.alphaTarget(0.2).restart();
        hideTip();
      }
      const [x, y] = N.t.invert([ev.x, ev.y]);
      n.fx = x;
      n.fy = y;
      schedule();
    })
    .on('end', (ev) => {
      const n = ev.subject.n;
      if (N.dragging !== n) return;
      N.sim.alphaTarget(0);
      if (n.id !== BUYER) { n.fx = null; n.fy = null; }
      N.dragging = null;
    });
  d3.select(N.canvas).call(drag).call(N.zoom).on('dblclick.zoom', null);
  N.canvas.addEventListener('pointermove', onHover);
  N.canvas.addEventListener('pointerleave', () => setHover(null));
  N.canvas.addEventListener('click', (e) => {
    const [x, y] = N.t.invert(d3.pointer(e, N.canvas));
    select(pick(x, y));
  });
  N.canvas.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') zoomBy(1.4);
    else if (e.key === '-') zoomBy(1 / 1.4);
    else if (e.key === '0') fit(true);
  });
  N.ro = new ResizeObserver(resize);
  N.ro.observe(N.stage);
  resize();
}

function resize() {
  if (!N) return;
  const r = N.stage.getBoundingClientRect();
  const w = Math.round(r.width);
  const h = Math.round(r.height);
  if (!w || !h) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (w === N.w && h === N.h && dpr === N.dpr) return;
  const first = !N.w;
  const [ow, oh] = [N.w, N.h];
  N.w = w; N.h = h; N.dpr = dpr;
  N.canvas.width = Math.round(w * dpr);
  N.canvas.height = Math.round(h * dpr);
  const sel = N.d3.select(N.canvas);
  if (first) {
    sel.call(N.zoom.transform, N.d3.zoomIdentity.translate(w / 2, h / 2).scale(0.8));
    if (N.vis.size) fit(false);
  } else {
    // ohrani središče pogleda
    sel.call(N.zoom.transform, N.d3.zoomIdentity.translate(N.t.x + (w - ow) / 2, N.t.y + (h - oh) / 2).scale(N.t.k));
  }
  schedule();
}

function fit(animate) {
  if (!N.w || !N.h || !N.vis.size) return;
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of N.vis) {
    if (!Number.isFinite(n.x)) continue;
    x0 = Math.min(x0, n.x - n.r); x1 = Math.max(x1, n.x + n.r);
    y0 = Math.min(y0, n.y - n.r); y1 = Math.max(y1, n.y + n.r + 14);
  }
  if (!Number.isFinite(x0)) return;
  const pad = 28;
  const k = Math.max(0.04, Math.min(2.2, (N.w - pad * 2) / (x1 - x0 || 1), (N.h - pad * 2) / (y1 - y0 || 1)));
  const t = N.d3.zoomIdentity.translate(N.w / 2, N.h / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  const sel = N.d3.select(N.canvas);
  (animate ? sel.transition().duration(500) : sel).call(N.zoom.transform, t);
}

function zoomBy(f) {
  N.d3.select(N.canvas).transition().duration(250).call(N.zoom.scaleBy, f);
}

function centerOn(n) {
  if (!N.w || !Number.isFinite(n.x)) return;
  const k = Math.max(N.t.k, 1.3);
  const t = N.d3.zoomIdentity.translate(N.w / 2, N.h / 2).scale(k).translate(-n.x, -n.y);
  N.d3.select(N.canvas).transition().duration(600).call(N.zoom.transform, t);
}

// Vozlišče pod kazalcem: najprej najmanjše, ki vsebuje točko, sicer najbližje v nekaj px.
function pick(x, y) {
  const tol = 4 / N.t.k;
  let best = null;
  let bd = Infinity;
  for (let i = N.drawNodes.length - 1; i >= 0; i--) {
    const n = N.drawNodes[i];
    const d = Math.hypot(n.x - x, n.y - y) - n.r;
    if (d <= 0) return n;
    if (d < tol && d < bd) { best = n; bd = d; }
  }
  return best;
}

// --- risanje -------------------------------------------------------------------------------

function readColors() {
  const cs = getComputedStyle(N.el);
  const v = (name, fb) => cs.getPropertyValue(name).trim() || fb;
  N.C = {
    ink: v('--ink', '#191814'), ink2: v('--ink-2', '#4d4b44'), paper: v('--paper', '#efeadf'),
    edge: v('--net-edge', '#7c796f'), none: v('--net-none', '#b8b2a4'), buyer: v('--net-buyer', '#191814'),
    sans: v('--sans', 'system-ui, sans-serif'), g: FALLBACK.map((c, i) => v(`--net-g${i + 1}`, c)),
  };
}

const fillOf = (n) => (n.t === 'buyer' ? N.C.buyer : n.g > 0 && n.g <= GROUPS ? N.C.g[n.g - 1] : N.C.none);
const cssFill = (n) => (n.t === 'buyer' ? 'var(--net-buyer)' : n.g > 0 && n.g <= GROUPS ? `var(--net-g${n.g})` : 'var(--net-none)');

function edgeWidth(e) {
  if (e.type === 'partner') return 0.8 + Math.min(3.2, Math.sqrt(e.count) * 0.9);
  if (e.type === 'podizvajalec') return 1.1;
  return e.dars ? 0.5 : 0.9;
}

function schedule() {
  if (N && !N.raf) N.raf = requestAnimationFrame(draw);
}

function draw() {
  if (!N) return;
  N.raf = 0;
  const { ctx, w, h, dpr, t, C } = N;
  if (!w || !h) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!N.vis.size) return;
  ctx.setTransform(dpr * t.k, 0, 0, dpr * t.k, dpr * t.x, dpr * t.y);
  const k = t.k;
  const sel = N.state.sel && N.vis.has(N.state.sel) ? N.state.sel : null;
  const hl = sel ? new Set([sel, ...sel.links.map((e) => other(e, sel)).filter((o) => N.vis.has(o))]) : null;

  // povezave: najprej zatemnjene, nato povezave izbranega
  ctx.lineCap = 'round';
  for (const pass of sel ? [false, true] : [null]) {
    for (const type of ['narocnik', 'partner', 'podizvajalec']) {
      const dash = type === 'podizvajalec' ? [4 / k, 3 / k] : [];
      ctx.setLineDash(dash);
      for (const e of N.visEdges) {
        if (e.type !== type) continue;
        const on = !sel || e.a === sel || e.b === sel;
        if (pass !== null && on !== pass) continue;
        const base = type === 'narocnik' ? (e.dars ? 0.13 : 0.35) : type === 'partner' ? 0.5 : 0.75;
        ctx.globalAlpha = sel ? (on ? Math.min(1, base * 1.7) : base * 0.15) : base;
        ctx.strokeStyle = sel && on && type !== 'narocnik' ? C.ink2 : C.edge;
        ctx.lineWidth = edgeWidth(e) / k;
        ctx.beginPath();
        ctx.moveTo(e.a.x, e.a.y);
        ctx.lineTo(e.b.x, e.b.y);
        ctx.stroke();
        if (type === 'podizvajalec') arrow(ctx, e, k, dash);
      }
    }
  }
  ctx.setLineDash([]);

  // vozlišča s tankim obročem v barvi podlage
  for (const n of N.drawNodes) {
    ctx.globalAlpha = hl && !hl.has(n) ? 0.16 : 1;
    ctx.fillStyle = fillOf(n);
    shape(ctx, n, 0);
    ctx.fill();
    ctx.lineWidth = 1.5 / k;
    ctx.strokeStyle = C.paper;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const hov = N.state.hover && N.vis.has(N.state.hover) ? N.state.hover : null;
  if (hov && hov !== sel) {
    shape(ctx, hov, 2.5 / k);
    ctx.lineWidth = 1.5 / k;
    ctx.strokeStyle = C.ink2;
    ctx.stroke();
  }
  if (sel) {
    shape(ctx, sel, 3 / k);
    ctx.lineWidth = 2.5 / k;
    ctx.strokeStyle = C.ink;
    ctx.stroke();
  }
  drawLabels(ctx, k, sel, hl, hov);
}

function shape(ctx, n, grow) {
  const r = n.r + grow;
  ctx.beginPath();
  if (n.t === 'buyer') ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
  else ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
}

function arrow(ctx, e, k, dash) {
  const dx = e.b.x - e.a.x;
  const dy = e.b.y - e.a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tx = e.b.x - ux * (e.b.r + 2 / k);
  const ty = e.b.y - uy * (e.b.r + 2 / k);
  const s = 6 / k;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - ux * s - uy * s * 0.55, ty - uy * s + ux * s * 0.55);
  ctx.lineTo(tx - ux * s + uy * s * 0.55, ty - uy * s - ux * s * 0.55);
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
  ctx.setLineDash(dash);
}

// Imena: izbrani in sosedje, sicer večja vozlišča; preskočimo imena, ki bi se prekrivala.
function drawLabels(ctx, k, sel, hl, hov) {
  const C = N.C;
  const fs = 11 / k;
  const list = [];
  if (sel) list.push(sel);
  if (hov) list.push(hov);
  if (hl) for (const n of N.drawNodes) { if (hl.has(n)) list.push(n); }
  else for (const n of N.drawNodes) { if (n.r * k >= 7.5) list.push(n); if (list.length > 90) break; }
  ctx.font = `500 ${fs}px ${C.sans}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3 / k;
  ctx.strokeStyle = C.paper;
  ctx.fillStyle = C.ink;
  const placed = [];
  const seen = new Set();
  for (const n of list) {
    if (seen.has(n)) continue;
    seen.add(n);
    const text = n.n.length > 26 ? `${n.n.slice(0, 25)}…` : n.n;
    const tw = ctx.measureText(text).width;
    const box = [n.x - tw / 2 - 2 / k, n.y + n.r + 1 / k, n.x + tw / 2 + 2 / k, n.y + n.r + 2 / k + fs * 1.2];
    const must = n === sel || n === hov;
    if (!must && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    ctx.strokeText(text, n.x, box[1] + 1 / k);
    ctx.fillText(text, n.x, box[1] + 1 / k);
  }
}

// --- lebdeči opis ------------------------------------------------------------------------------

function onHover(e) {
  if (N.dragging || e.buttons) return;
  const [x, y] = N.t.invert(N.d3.pointer(e, N.canvas));
  setHover(pick(x, y), e);
}

function setHover(n, e) {
  const changed = n !== N.state.hover;
  N.state.hover = n;
  N.canvas?.classList.toggle('is-pointer', !!n);
  if (!n) {
    hideTip();
    if (changed) schedule();
    return;
  }
  if (changed) {
    N.tip.innerHTML = tipHtml(n);
    N.tip.hidden = false;
    schedule();
  }
  if (e) {
    const r = N.stage.getBoundingClientRect();
    let x = e.clientX - r.left + 14;
    let y = e.clientY - r.top + 14;
    if (x + N.tip.offsetWidth > r.width - 6) x = e.clientX - r.left - N.tip.offsetWidth - 14;
    if (y + N.tip.offsetHeight > r.height - 6) y = e.clientY - r.top - N.tip.offsetHeight - 14;
    N.tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }
}

function hideTip() {
  if (N?.tip) N.tip.hidden = true;
}

const rolesOf = (n) => n.roles.map((r) => ROLE[r] || r).join(', ') || '–'; // n.r je polmer

function tipHtml(n) {
  if (n.t === 'buyer') {
    const firms = new Set(n.links.filter((e) => e.type === 'narocnik').map((e) => other(e, n))).size;
    return `<b>${esc(n.f)}</b><span>naročnik · ${count(firms, POD)}</span>`;
  }
  return `<b>${esc(n.n)}</b>${n.f !== n.n ? `<span>${esc(n.f)}</span>` : ''}
    <span class="v-mono">${esc(money(n.v))} · ${count(n.c, POG)}${n.sc ? ` · ${num.format(n.sc)}× podizvajalec` : ''}</span>
    <span>${esc(rolesOf(n))}</span>`;
}

// --- izbira in profil ----------------------------------------------------------------------------

function select(n, { center = false } = {}) {
  const s = N.state;
  const prev = s.sel;
  s.sel = n || null;
  if (n && !N.vis.has(n)) {
    s.forced.add(n.id);
    applyFilters();
  } else if (prev && !n && !passes(prev) && !s.forced.has(prev.id)) {
    applyFilters(); // izbrano, a sicer izločeno podjetje skrijemo
  }
  renderPanel();
  schedule();
  if (n && center) centerOn(n);
}

function neighbours(n, pred) {
  const m = new Map();
  for (const e of n.links) {
    if (!pred(e)) continue;
    const o = other(e, n);
    const x = m.get(o) || { n: o, count: 0, value: 0 };
    x.count += e.count;
    x.value += e.value;
    m.set(o, x);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.value - a.value);
}

function list(items) {
  const rows = items.slice(0, LIST_MAX).map(({ n, count: c, value, meta }) => {
    const hidden = !N.vis.has(n);
    return `<li><button type="button" class="net-item${hidden ? ' is-hidden' : ''}" data-node="${esc(n.id)}"${hidden ? ' title="Skrito s filtri; klik ga prikaže"' : ''}>
      <i class="sw${n.t === 'buyer' ? ' sq' : ''}" style="background:${cssFill(n)}"></i><span class="t">${esc(n.n)}</span>
      <span class="v">${meta ?? `${num.format(c)}×${value ? ` · ${esc(money(value))}` : ''}`}</span></button></li>`;
  }).join('');
  return `<ul class="net-list">${rows}</ul>${items.length > LIST_MAX ? `<p class="net-more">in še ${num.format(items.length - LIST_MAX)}</p>` : ''}`;
}

const yearsOf = (y) => (y ? (y[0] === y[1] ? String(y[0]) : `${y[0]}–${y[1]}`) : '–');
const regVal = (v) => (!N.hasReg && !v ? '–' : num.format(v || 0));

function indicators(f) {
  const warnS = f.bids >= 3 && f.single / f.bids >= 0.4;
  const warnR = isNum(f.ratio) && f.ratio >= 0.97 && f.ratio <= 1.03;
  const warnG = isNum(f.growth) && f.growth > 0.15;
  return `<dl class="v-facts">
      <dt>Ena ponudba</dt><dd class="num${warnS ? ' warn' : ''}">${f.bids ? `${num.format(f.single || 0)} od ${num.format(f.bids)}` : '–'}</dd>
      <dt>Razmerje do ocene (mediana)</dt><dd class="num${warnR ? ' warn' : ''}">${isNum(f.ratio) ? num3.format(f.ratio) : '–'}</dd>
      <dt>Rast z aneksi (mediana)</dt><dd class="num${warnG ? ' warn' : ''}">${signedPct(f.growth)}</dd>
      <dt title="Kolikokrat je bilo njegovo delo ponovljeno, ko je še veljala garancija">Ponovljeno v garanciji</dt><dd class="num${f.redone ? ' warn' : ''}">${regVal(f.redone)}</dd>
      <dt title="Kolikokrat je dobil posel na mestu, kjer je še veljala garancija drugega izvajalca">Delo v tuji garanciji</dt><dd class="num">${regVal(f.redid)}</dd>
      <dt title="Kolikokrat je bil znova plačan za isto mesto v svoji garancijski dobi">Svoje delo v garanciji</dt><dd class="num${f.own ? ' warn' : ''}">${regVal(f.own)}</dd>
      <dt>Razdrobljena naročila</dt><dd class="num${f.split >= 2 ? ' warn' : ''}">${num.format(f.split || 0)}</dd>
      <dt>Partnerji / podizvajalci</dt><dd class="num">${num.format(f.partners || 0)} / ${N.hasReg ? num.format(f.subs || 0) : '–'}</dd>
    </dl>
    ${f.flags?.length ? `<div class="v-tags">${f.flags.map((x) => `<span class="v-tag warn">${esc(x)}</span>`).join('')}</div>` : '<p class="v-empty" style="margin-top:6px">Brez zastavic.</p>'}
    <p class="net-cap">Kazalniki so rdeče zastavice za podrobnejši pregled, ne dokaz nepravilnosti.</p>`;
}

function firmPanel(n) {
  const grp = n.g > 0 ? N.groups.get(n.g) : null;
  const partners = neighbours(n, (e) => e.type === 'partner');
  const subs = neighbours(n, (e) => e.type === 'podizvajalec' && e.a === n);
  const subOf = neighbours(n, (e) => e.type === 'podizvajalec' && e.b === n);
  const buyers = neighbours(n, (e) => e.type === 'narocnik');
  const row = N.firmsByK.get(n.id);
  return `<button type="button" class="v-link net-back" data-back>← Pregled mreže</button>
    <p class="net-kicker"><i class="sw" style="background:${cssFill(n)}"></i>${grp
      ? `skupina ${n.g}: ${esc(grp.top.n)}${grp.size > 1 ? ` in še ${num.format(grp.size - 1)}` : ''}`
      : 'brez skupine'}</p>
    <h2>${esc(n.f)}</h2>
    ${n.f !== n.n ? `<p class="net-sub">${esc(n.n)}</p>` : ''}
    <dl class="v-facts">
      <dt>Leta</dt><dd class="num">${yearsOf(n.years)}</dd>
      <dt>Vrednost pogodb</dt><dd class="num">${esc(money(n.v))}</dd>
      <dt>Pogodbe</dt><dd class="num">${num.format(n.c)}${n.sc ? ` · ${num.format(n.sc)}× podizvajalec` : ''}</dd>
      <dt>Vloge</dt><dd>${esc(rolesOf(n))}</dd>
      <dt>Vrste naročil</dt><dd>${esc(n.k.join(', ') || '–')}</dd>
    </dl>
    <p class="net-cap">Vrednost skupnih ponudb je razdeljena med partnerje.</p>
    <button type="button" class="v-btn wide" data-map="${esc(n.n)}">Prikaži pogodbe na zemljevidu</button>
    <h3>Kazalniki</h3>
    ${row ? indicators(row) : '<p class="v-empty">Kazalniki so izračunani le za izvajalce z vsaj dvema pogodbama gradenj.</p>'}
    <h3>Partnerji v skupnih ponudbah · ${partners.length}</h3>
    ${partners.length ? list(partners) : '<p class="v-empty">Brez skupnih ponudb.</p>'}
    <h3>Podizvajalci · ${subs.length}</h3>
    ${subs.length ? list(subs) : `<p class="v-empty">${N.hasSubs ? 'V pogodbah ni navedenih podizvajalcev.' : NO_REG}</p>`}
    ${subOf.length ? `<h3>Podizvajalec pri · ${subOf.length}</h3>${list(subOf)}` : ''}
    <h3>Naročniki · ${buyers.length}</h3>
    ${buyers.length ? list(buyers) : '<p class="v-empty">–</p>'}`;
}

function buyerPanel(n) {
  const firms = neighbours(n, (e) => e.type === 'narocnik').sort((a, b) => b.value - a.value || b.count - a.count);
  return `<button type="button" class="v-link net-back" data-back>← Pregled mreže</button>
    <p class="net-kicker"><i class="sw sq" style="background:var(--net-buyer)"></i>naročnik</p>
    <h2>${esc(n.f)}</h2>
    <p class="net-sub">${n.id === BUYER
      ? 'DARS je naročnik vseh pogodb v zbirki, zato je privzeto skrit: povezan je z vsemi.'
      : 'Sonaročnik v skupnem javnem naročilu z DARS.'}</p>
    <h3>Izvajalci · ${firms.length}</h3>
    ${firms.length ? list(firms) : '<p class="v-empty">–</p>'}`;
}

function overviewPanel() {
  const top = [...N.vis].filter((n) => n.t === 'firm')
    .map((n) => [n, new Set(n.links.filter((e) => !e.dars && e.type !== 'narocnik' && N.vis.has(other(e, n))).map((e) => other(e, n))).size])
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1] || b[0].v - a[0].v)
    .slice(0, 10);
  return `<h2>Mreža izvajalcev</h2>
    <p class="net-sub">${N.nodes.length ? countText() : 'Ni podatkov.'}</p>
    <p class="net-cap">Povezave so skupne ponudbe (partnerji v konzorciju) in podizvajalci, navedeni v pogodbah. Barvne skupine so podjetja, ki večkrat delajo skupaj; določene so samodejno iz povezav.</p>
    <p class="net-cap">Povezava ni dokaz dogovarjanja: skupne ponudbe in podizvajanje so zakoniti in pri velikih delih običajni. Lastniške povezave med podjetji niso vključene, ker jih ni v uporabljenih odprtih podatkih.</p>
    ${N.hasSubs ? '' : `<p class="v-note" style="margin-top:10px">Podizvajalci: ${NO_REG}</p>`}
    ${N.nodes.length ? `<h3>Največ povezav</h3>
    ${top.length ? list(top.map(([n, d]) => ({ n, meta: count(d, POV) }))) : '<p class="v-empty">Med prikazanimi podjetji ni povezav.</p>'}
    <p class="net-cap">Kliknite krog za profil podjetja, povlecite ga, da ga premaknete. Velikost kroga je sorazmerna s korenom vrednosti pogodb; kvadrat je naročnik.</p>` : ''}`;
}

function renderPanel() {
  const n = N.state.sel;
  N.$('.net-panel').innerHTML = n ? (n.t === 'buyer' ? buyerPanel(n) : firmPanel(n)) : overviewPanel();
}

function onPanelClick(e) {
  const t = e.target.closest('[data-node],[data-back],[data-map]');
  if (!t || !N) return;
  if (t.dataset.node) {
    const n = N.byId.get(t.dataset.node);
    if (n) select(n, { center: true });
    N.$('.net-panel').scrollTop = 0;
  } else if ('back' in t.dataset) {
    select(null);
  } else if (t.dataset.map) {
    N.api?.filterFirm?.(t.dataset.map);
  }
}

// --- nadzor --------------------------------------------------------------------------------------

function shell() {
  const names = N.nodes.filter((n) => n.id !== BUYER).sort((a, b) => b.v - a.v)
    .map((n) => `<option value="${esc(n.n)}"></option>`).join('');
  return `<div class="net">
    <div class="net-bar" role="toolbar" aria-label="Nastavitve mreže">
      <div class="net-ctl"><span class="net-lbl" id="net-kinds-l">Vrsta</span>
        <div class="net-chips" id="net-kinds" role="group" aria-labelledby="net-kinds-l">${N.kindList.map((k) => (
          `<button type="button" class="v-chip" data-kind="${esc(k)}" aria-pressed="false">${esc(k)} <small>${num.format(N.kinds.get(k))}</small></button>`)).join('')}</div>
      </div>
      <div class="net-ctl"><span class="net-lbl" id="net-min-l">Min. pogodb</span>
        <div class="v-seg" id="net-min" role="group" aria-labelledby="net-min-l">${MIN_OPTS.map((m) => `<button type="button" data-min="${m}" aria-pressed="false">${m}</button>`).join('')}</div>
      </div>
      <div class="net-ctl net-search">
        <input type="search" id="net-q" list="net-names" placeholder="Poišči podjetje" autocomplete="off" aria-label="Poišči podjetje v mreži">
        <datalist id="net-names">${names}</datalist>
        <output id="net-q-msg" aria-live="polite"></output>
      </div>
      <label class="v-check"><input type="checkbox" id="net-connected"> Le povezani</label>
      <label class="v-check"><input type="checkbox" id="net-dars"> Prikaži DARS</label>
      <button type="button" class="v-btn" id="net-legend-btn" aria-controls="net-legend" aria-expanded="false">Legenda</button>
      <span class="net-count" id="net-count"></span>
    </div>
    <div class="net-body">
      <div class="net-stage">
        <canvas tabindex="0" role="img" aria-label="Graf povezav med izvajalci: skupne ponudbe, podizvajalci in naročniki. Seznami povezav so v stolpcu s podrobnostmi."></canvas>
        <div class="net-tip" hidden></div>
        <div class="net-zoom">
          <button type="button" data-zoom="in" aria-label="Povečaj" title="Povečaj">+</button>
          <button type="button" data-zoom="out" aria-label="Pomanjšaj" title="Pomanjšaj">−</button>
          <button type="button" data-zoom="fit" aria-label="Prikaži celo mrežo" title="Prikaži celo mrežo"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>
        </div>
        <div class="net-legend" id="net-legend" hidden></div>
        <p class="net-empty" hidden></p>
      </div>
      <aside class="net-panel" aria-label="Podrobnosti" aria-live="polite"></aside>
    </div>
  </div>`;
}

function bindControls() {
  const s = N.state;
  const refilter = () => { s.forced.clear(); N.fitted = false; applyFilters(); };
  N.$('#net-kinds').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    const k = b.dataset.kind;
    if (s.kinds.has(k)) s.kinds.delete(k); else s.kinds.add(k);
    refilter();
  });
  N.$('#net-min').addEventListener('click', (e) => {
    const b = e.target.closest('[data-min]');
    if (!b) return;
    s.min = Number(b.dataset.min);
    refilter();
  });
  N.$('#net-connected').addEventListener('change', (e) => { s.connected = e.target.checked; refilter(); });
  N.$('#net-dars').addEventListener('change', (e) => { s.dars = e.target.checked; applyFilters(); });
  N.$('#net-legend-btn').addEventListener('click', () => { s.legend = !s.legend; renderLegend(); });
  N.$('.net-zoom').addEventListener('click', (e) => {
    const b = e.target.closest('[data-zoom]');
    if (!b) return;
    if (b.dataset.zoom === 'fit') fit(true); else zoomBy(b.dataset.zoom === 'in' ? 1.4 : 1 / 1.4);
  });
  const input = N.$('#net-q');
  const msg = N.$('#net-q-msg');
  const go = () => {
    const q = input.value.trim();
    msg.textContent = '';
    if (!q) return;
    const n = findNode(q);
    if (n) select(n, { center: true });
    else msg.textContent = 'Ni zadetka';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  input.addEventListener('input', () => {
    msg.textContent = '';
    if (N.names.has(input.value.trim().toLowerCase())) go(); // izbira s seznama
  });
}

function findNode(q) {
  const s = q.toLowerCase();
  let best = null;
  let score = 0;
  for (const n of N.nodes) {
    const a = n.n.toLowerCase();
    const b = n.f.toLowerCase();
    const sc = a === s || b === s ? 3 : a.startsWith(s) || b.startsWith(s) ? 2 : a.includes(s) || b.includes(s) ? 1 : 0;
    if (sc > score || (sc && sc === score && n.v > best.v)) { best = n; score = sc; }
  }
  return best;
}

function syncControls() {
  const s = N.state;
  N.el.querySelectorAll('[data-kind]').forEach((b) => {
    const on = s.kinds.has(b.dataset.kind);
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on);
  });
  N.el.querySelectorAll('[data-min]').forEach((b) => {
    const on = Number(b.dataset.min) === s.min;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', on);
  });
  N.$('#net-connected').checked = s.connected;
  N.$('#net-dars').checked = s.dars;
  N.$('#net-dars').disabled = !N.byId.has(BUYER);
}

function countText() {
  let firms = 0;
  let buyers = 0;
  for (const n of N.vis) { if (n.t === 'firm') firms += 1; else buyers += 1; }
  return `${count(firms, POD)}${buyers ? `, ${count(buyers, NAR)}` : ''} · ${count(N.visEdges.length, POV)}`;
}

function renderCount() {
  N.$('#net-count').textContent = countText();
}

function lineKey(kind) {
  const line = kind === 'sub'
    ? '<line x1="1" y1="5" x2="16" y2="5" style="stroke:var(--net-edge);stroke-width:1.2;stroke-dasharray:3 2"/><path d="M16 1.8 22 5 16 8.2z" style="fill:var(--net-edge)"/>'
    : kind === 'buyer'
      ? '<line x1="1" y1="5" x2="21" y2="5" style="stroke:var(--net-edge);stroke-width:1;stroke-opacity:.45"/>'
      : '<line x1="1" y1="5" x2="21" y2="5" style="stroke:var(--net-edge);stroke-width:2.4;stroke-linecap:round"/>';
  return `<svg width="22" height="10" aria-hidden="true">${line}</svg>`;
}

function renderLegend() {
  const s = N.state;
  const box = N.$('#net-legend');
  const btn = N.$('#net-legend-btn');
  box.hidden = !s.legend;
  btn.setAttribute('aria-expanded', s.legend);
  btn.classList.toggle('is-on', s.legend);
  if (!s.legend) return;
  const present = new Set();
  let misc = false;
  let buyer = false;
  for (const n of N.vis) {
    if (n.t === 'buyer') buyer = true;
    else if (n.g > 0 && n.g <= GROUPS) present.add(n.g);
    else misc = true;
  }
  const groups = [...present].sort((a, b) => a - b).map((g) => N.groups.get(g)).filter(Boolean);
  const items = groups.map((x) => `<li><i class="sw" style="background:var(--net-g${x.g})"></i><span>${esc(x.top.n)}${x.size > 1 ? ` in še ${num.format(x.size - 1)}` : ''}</span></li>`);
  if (misc) items.push(`<li><i class="sw" style="background:var(--net-none)"></i><span>brez skupine${N.groups.size > GROUPS ? ' ali manjša skupina' : ''}</span></li>`);
  if (buyer) items.push('<li><i class="sw sq" style="background:var(--net-buyer)"></i><span>naročnik</span></li>');
  box.innerHTML = `${items.length ? `<h4>Skupine</h4><ul>${items.join('')}</ul>` : ''}
    <h4>Povezave</h4><ul>
      <li>${lineKey('partner')}<span>skupna ponudba (debelina: število)</span></li>
      <li>${lineKey('sub')}<span>podizvajalec${N.hasSubs ? '' : ' (še ni podatkov)'}</span></li>
      <li>${lineKey('buyer')}<span>naročnik in izvajalec</span></li>
    </ul>
    <h4>Velikost</h4><ul><li><span>ploščina kroga: vrednost pogodb</span></li></ul>`;
}

function showEmpty(text) {
  const p = N.$('.net-empty');
  p.textContent = text;
  p.hidden = !text;
}
