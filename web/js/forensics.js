// Forenzika: rdeče zastavice nad pogodbami DARS kot infografike (d3 je naložen globalno, window.d3).
// Vir podatkov: data/forenzika.json → forensics (pipeline/forensics.py). Vsak stolpec, točka, celica
// in številka odpre seznam pogodb, iz katerih je izračunana, s potjo na zemljevid in do izvirne objave.

const num = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 1 });
const num3 = new Intl.NumberFormat('sl-SI', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const NO_REG = 'Podatki iz registra pogodb še niso na voljo.';
const VERDICT = {
  tesna: 'tesna skladnost', sprejemljiva: 'sprejemljiva skladnost', mejna: 'mejna skladnost', neskladnost: 'neskladnost',
};
const FLAG_NAMES = { g: 'v garanciji', i: 'isti izvajalec', r: 'po rekonstrukciji', p: 'drugo ime' };
const MONTHS = ['januar', 'februar', 'marec', 'april', 'maj', 'junij', 'julij', 'avgust', 'september', 'oktober', 'november', 'december'];
const ROWS = 25;        // vrstic tabele izvajalcev pred »Prikaži vse«
const DRILL_MAX = 120;  // vrstic v seznamu pogodb pred »Prikaži vse«

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pct = (x, d = 0) => (isNum(x) ? `${(d ? num1 : num).format(x * 100)} %` : '–');
function signedPct(x) {
  if (!isNum(x)) return '–';
  const v = Math.round(x * 1000) / 10;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${num1.format(Math.abs(v))} %`;
}
function plural(n, forms) {
  const m = Math.abs(n) % 100;
  return forms[m === 1 ? 0 : m === 2 ? 1 : m === 3 || m === 4 ? 2 : 3];
}
const pogodb = (n) => `${num.format(n)} ${plural(n, ['pogodba', 'pogodbi', 'pogodbe', 'pogodb'])}`;
const parov = (n) => `${num.format(n)} ${plural(n, ['par', 'para', 'pari', 'parov'])}`;
const dec = (v, d = 1) => new Intl.NumberFormat('sl-SI', { maximumFractionDigits: d }).format(v);
const moneyFull = (v) => (v == null ? '–' : `${num.format(v)} €`);
function dateSl(iso) {
  if (!iso) return '–';
  const [y, m, d] = iso.split('-');
  return `${+d}. ${+m}. ${y}`;
}
function yearsTxt(g) {
  const r = Math.round(g * 10) / 10;
  const s = num1.format(r);
  if (!Number.isInteger(r)) return `${s} leta`;
  const n = r % 100;
  return `${s} ${n === 1 ? 'leto' : n === 2 ? 'leti' : n === 3 || n === 4 ? 'leta' : 'let'}`;
}
const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

let S = null; // stanje pogleda

function money(v) {
  if (S?.api?.money) return S.api.money(v);
  return v == null ? '–' : `${num.format(v)} €`;
}
const P = (id) => S?.api?.project?.(id);
const valueOf = (p) => p?.vf ?? p?.v ?? 0;
const allProjects = () => S?.api?.projects?.() || [];
const works = () => allProjects().filter((p) => p.k !== 'aneksi');
const catName = (c) => S.api?.catLabel?.[c] || c;
const color = (c) => S.api?.colorOf?.(c) || 'var(--ink-3)';

// --- vstop -------------------------------------------------------------------------------

export function render(el, data, api) {
  if (S) teardown();
  const F = data?.forensics || {};
  S = {
    el, F, api,
    hasReg: (F.reg_growth?.length > 0) || (F.firms || []).some((f) => f.subs > 0) || (F.flags?.count?.g > 0),
    sort: { key: 'flags', dir: -1 }, all: false, gridW: 0, raf: 0,
    drills: new Map(), seq: 0, drill: null, sig: null,
  };
  el.classList.add('view-forensics');
  el.innerHTML = layout(F);
  S.onClick = onClick;
  S.onKey = onKey;
  S.onResize = () => { if (S?.drill) positionDrill(); };
  el.addEventListener('click', S.onClick);
  el.addEventListener('keydown', S.onKey);
  window.addEventListener('resize', S.onResize);
  renderTable();
  drawCharts();
  const grid = el.querySelector('.fx-grid');
  S.gridW = Math.round(grid.clientWidth);
  S.ro = new ResizeObserver(() => {
    const w = Math.round(grid.clientWidth);
    if (!w || Math.abs(w - S.gridW) < 4) return;
    S.gridW = w;
    cancelAnimationFrame(S.raf);
    S.raf = requestAnimationFrame(drawCharts);
  });
  S.ro.observe(grid);
}

// Barve so v CSS spremenljivkah; ob menjavi teme grafe vseeno narišemo znova.
export function update(api) {
  if (!S) return;
  if (api) S.api = api;
  drawCharts();
  if (S.drill) positionDrill();
}

function teardown() {
  S.ro?.disconnect();
  cancelAnimationFrame(S.raf);
  S.el.removeEventListener('click', S.onClick);
  S.el.removeEventListener('keydown', S.onKey);
  window.removeEventListener('resize', S.onResize);
  S = null;
}

// --- seznami pogodb za posamezen podatek ----------------------------------------------------

// Opis seznama: { kicker, title, sub, items: [{ id, note, sv, url, urlLabel }] ali funkcija,
// pairs: [{ a, b, flags, note }] ali funkcija, order: 'v' | 'd', firm, flag, ll, html, sig }.
function reg(ns, spec) {
  const key = `${ns}${++S.seq}`;
  S.drills.set(key, { sig: key, ...spec });
  return key;
}
function clearNs(ns) {
  for (const key of [...S.drills.keys()]) if (key.startsWith(ns)) S.drills.delete(key);
}
const drillBtn = (spec, inner, cls = 'fx-stat') => `<button type="button" class="${cls}" data-drill="${reg('h', spec)}">${inner}</button>`;

function openDrill(key) {
  const spec = S.drills.get(key);
  if (!spec) return;
  const items = (typeof spec.items === 'function' ? spec.items() : spec.items) || [];
  const pairs = (typeof spec.pairs === 'function' ? spec.pairs() : spec.pairs) || [];
  S.drill = { ...spec, items, pairs, order: spec.order || 'v', limit: DRILL_MAX };
  S.sig = spec.sig;
  markSel();
  renderDrill();
  S.el.querySelector('.fx-drill h3')?.focus({ preventScroll: true });
}

function closeDrill() {
  S.drill = null;
  S.sig = null;
  markSel();
  renderDrill();
}

function markSel() {
  for (const node of S.el.querySelectorAll('[data-drill]')) {
    node.classList.toggle('is-sel', !!S.sig && S.drills.get(node.dataset.drill)?.sig === S.sig);
  }
}

function positionDrill() {
  const box = S.el.querySelector('.fx-drill');
  const wide = S.el.closest('.wide') || S.el;
  box.style.top = `${Math.max(0, Math.round(wide.getBoundingClientRect().top))}px`;
}

function drillIds(D) {
  return [...new Set([...D.items.map((it) => it.id), ...D.pairs.flatMap((x) => [x.a, x.b])])].filter((id) => P(id));
}

function srcLinks(p, extra) {
  const src = p.src || [];
  const notice = src.find(([l]) => /^(Oddaja|Neposredna|Sprememba|Aneks)/.test(l)) || src[0];
  const pdf = src.find(([l]) => l.startsWith('Pogodba'));
  const links = [];
  if (extra?.url) links.push(`<a href="${esc(extra.url)}" target="_blank" rel="noopener">${esc(extra.urlLabel || 'vir')} ↗</a>`);
  if (notice && notice[1] !== extra?.url) links.push(`<a href="${esc(notice[1])}" target="_blank" rel="noopener" title="${esc(notice[0])} na portalu javnih naročil">objava ↗</a>`);
  if (pdf) links.push(`<a href="${esc(pdf[1])}" target="_blank" rel="noopener" title="Podpisana pogodba v registru pogodb">pogodba PDF ↗</a>`);
  return links.join('');
}

function drillRow(p, it = {}, tag = '') {
  const firm = (p.ws || [])[0];
  return `<li class="fx-di">
    <button type="button" class="fx-di-main" data-open="${p.i}" title="Odpri pogodbo na zemljevidu">
      <span class="t">${tag ? `<em>${esc(tag)}</em> ` : ''}${esc(p.t)}</span><span class="v">${esc(money(valueOf(p)))}</span>
      <span class="m"><i class="dot" style="background:${color(p.cat)}"></i>${dateSl(p.d)}${firm ? ` · ${esc(firm)}${p.ws.length > 1 ? ` +${p.ws.length - 1}` : ''}` : ''}${it.note ? ` · <b>${esc(it.note)}</b>` : ''}</span>
    </button>
    <span class="fx-di-src">${srcLinks(p, it)}<button type="button" class="fx-di-map" data-open="${p.i}">na zemljevidu →</button></span>
  </li>`;
}

function flagTags(flags) {
  return ['i', 'g', 'r', 'p'].filter((f) => (flags || '').includes(f))
    .map((f) => `<span class="v-tag warn flag-${f}">${FLAG_NAMES[f]}</span>`).join('');
}

function renderDrill() {
  const box = S.el.querySelector('.fx-drill');
  const D = S.drill;
  if (!D) {
    box.hidden = true;
    box.innerHTML = '';
    S.el.classList.remove('has-drill');
    return;
  }
  positionDrill();
  const rows = D.items.map((it) => ({ it, p: P(it.id) })).filter((r) => r.p);
  const pairs = D.pairs.map((x) => ({ x, a: P(x.a), b: P(x.b) })).filter((r) => r.a && r.b);
  const byDate = (a, b) => (a.d || '').localeCompare(b.d || '') || a.i - b.i;
  if (D.order === 'd') {
    rows.sort((r, q) => byDate(r.p, q.p));
    pairs.sort((r, q) => byDate(r.b, q.b));
  } else {
    // Ključ razvrščanja: kazalnik (npr. razmerje, rast), sicer znesek zapisa, sicer vrednost pogodbe.
    const key = (r) => r.it.sort ?? r.it.amt ?? valueOf(r.p);
    rows.sort((r, q) => key(q) - key(r));
    pairs.sort((r, q) => valueOf(q.b) - valueOf(r.b));
  }
  const ids = drillIds(D);
  const hasSv = rows.length && rows.every((r) => isNum(r.it.amt));
  const bySort = rows.some((r) => isNum(r.it.sort));
  const total = hasSv ? rows.reduce((s, r) => s + r.it.amt, 0) : ids.reduce((s, id) => s + valueOf(P(id)), 0);
  const n = rows.length + pairs.length;
  const shown = Math.min(n, D.limit);
  const list = pairs.length
    ? pairs.slice(0, D.limit).map(({ x, a, b }) => `<li class="fx-dp">
        <p class="fx-dp-h">${flagTags(x.flags)}<span>${esc(x.note || '')}</span></p>
        <ul class="fx-d-list">${drillRow(a, {}, 'prej')}${drillRow(b, {}, 'pozneje')}</ul>
      </li>`).join('')
    : rows.slice(0, D.limit).map(({ it, p }) => drillRow(p, it)).join('');
  box.hidden = false;
  S.el.classList.add('has-drill');
  box.innerHTML = `<div class="fx-d-head">
      <div class="fx-d-top"><p class="fx-kicker">${esc(D.kicker || '')}</p><button type="button" class="fx-d-close" data-close aria-label="Zapri seznam">×</button></div>
      <h3 tabindex="-1">${esc(D.title)}</h3>
      ${D.sub ? `<p class="fx-d-sub">${esc(D.sub)}</p>` : ''}
      <p class="fx-d-sum">${pairs.length ? parov(pairs.length) : `${num.format(rows.length)} ${plural(rows.length, ['zapis', 'zapisa', 'zapisi', 'zapisov'])}`}${ids.length !== n ? ` · ${pogodb(ids.length)}` : ''} · ${hasSv ? 'zneski skupaj' : 'vrednost'} <b>${esc(money(total))}</b></p>
      ${typeof D.html === 'function' ? D.html() : D.html || ''}
      <div class="fx-d-actions">
        ${ids.length ? `<button type="button" class="v-btn" data-map>${D.flag ? 'Prikaži pare na zemljevidu' : `Prikaži na zemljevidu (${num.format(ids.length)})`}</button>` : ''}
        ${D.ll ? '<button type="button" class="v-btn" data-fly>Pokaži v 3D</button>' : ''}
        ${D.firm ? `<button type="button" class="v-btn" data-firm="${esc(D.firm)}">Filtriraj zemljevid po izvajalcu</button>` : ''}
        ${n ? '<button type="button" class="v-btn" data-csv>CSV z viri</button>' : ''}
        ${n > 1 ? `<span class="v-seg" role="group" aria-label="Razvrsti"><button type="button" data-dsort="v" class="${D.order === 'v' ? 'is-on' : ''}">${bySort ? 'po kazalniku' : 'po vrednosti'}</button><button type="button" data-dsort="d" class="${D.order === 'd' ? 'is-on' : ''}">po datumu</button></span>` : ''}
      </div>
    </div>
    ${n ? `<ul class="fx-d-list">${list}</ul>` : '<p class="fx-empty">Za ta podatek ni pogodb.</p>'}
    ${n > shown ? `<button type="button" class="v-btn wide fx-d-more" data-dall>Prikaži vse (${num.format(n)})</button>` : ''}
    <p class="fx-d-note">Klik na pogodbo jo odpre na zemljevidu s podrobnostmi; »objava« vodi na portal javnih naročil, »pogodba PDF« na podpisano pogodbo v registru pogodb.</p>`;
}

function drillCsv() {
  const D = S.drill;
  const base = `${location.origin}${location.pathname}`;
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const line = (p, note, extra) => {
    const src = p.src || [];
    const notice = src.find(([l]) => /^(Oddaja|Neposredna|Sprememba|Aneks)/.test(l)) || src[0];
    const pdf = src.find(([l]) => l.startsWith('Pogodba'));
    return [p.i, p.d, p.t, (p.w || []).join(' | '), p.v ?? '', p.vf ?? '', note || '', extra || '', notice?.[1] || '', pdf?.[1] || '', `${base}#p=${p.i}`]
      .map(q).join(';');
  };
  const out = [];
  for (const x of D.pairs) {
    const a = P(x.a);
    const b = P(x.b);
    if (a && b) out.push(line(a, `prej · ${x.note || ''}`, FLAG_NAMES[x.flags?.[0]] || ''), line(b, `pozneje · ${x.note || ''}`, ''));
  }
  for (const it of D.items) {
    const p = P(it.id);
    if (p) out.push(line(p, it.note, it.url));
  }
  const head = ['id', 'datum', 'naslov', 'izvajalci', 'vrednost_oddaja_eur', 'vrednost_po_aneksih_eur', 'opomba', 'dodatni_vir', 'objava', 'pogodba_pdf', 'zemljevid'];
  const blob = new Blob([`﻿${q(`${D.kicker} · ${D.title}`)}\n${head.join(';')}\n${out.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `forenzika-${(D.title || 'izbor').toLowerCase().replace(/[^a-z0-9čšž]+/g, '-').slice(0, 50)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function onClick(e) {
  const t = e.target.closest('[data-drill],[data-open],[data-close],[data-map],[data-fly],[data-csv],[data-dsort],[data-dall],[data-firm],[data-sort],[data-all],[data-three],[data-jump]');
  if (!t || !S) return;
  const D = S.drill;
  if (t.dataset.drill) openDrill(t.dataset.drill);
  else if (t.dataset.open) S.api?.openProject?.(Number(t.dataset.open));
  else if ('close' in t.dataset) closeDrill();
  else if ('map' in t.dataset && D) {
    if (D.flag) S.api?.showFlag?.(D.flag);
    else S.api?.showOnMap?.(drillIds(D), `${D.kicker} · ${D.title}`);
  } else if ('fly' in t.dataset && D?.ll) S.api?.fly3d?.(D.ll, drillIds(D), D.title);
  else if ('csv' in t.dataset && D) drillCsv();
  else if (t.dataset.dsort && D) { D.order = t.dataset.dsort; renderDrill(); }
  else if ('dall' in t.dataset && D) { D.limit = Infinity; renderDrill(); }
  else if (t.dataset.firm != null) S.api?.filterFirm?.(t.dataset.firm);
  else if ('three' in t.dataset) S.api?.fly3d?.(null, [], '');
  else if (t.dataset.jump) {
    e.preventDefault();
    S.el.querySelector(`#${t.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (t.dataset.sort) {
    const key = t.dataset.sort;
    if (S.sort.key === key) S.sort.dir *= -1;
    else S.sort = { key, dir: key === 'n' ? 1 : -1 };
    renderTable();
    S.el.querySelector(`[data-sort="${key}"]`)?.focus();
  } else if ('all' in t.dataset) {
    S.all = !S.all;
    renderTable();
  }
}

function onKey(e) {
  if (e.key === 'Escape' && S?.drill) { closeDrill(); return; }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const t = e.target.closest?.('[data-drill]');
  if (!t || t.tagName === 'BUTTON') return;
  e.preventDefault();
  openDrill(t.dataset.drill);
}

// --- razporeditev ------------------------------------------------------------------------

function card({ id, n, title, lead, body, cap, span }) {
  return `<section class="fx-card${span ? ' span' : ''}" id="fx-${id}" aria-labelledby="fx-${id}-h">
    <p class="fx-kicker">${String(n).padStart(2, '0')}</p>
    <h3 id="fx-${id}-h">${title}</h3>
    ${lead ? `<p class="fx-lead">${lead}</p>` : ''}
    ${body}
    ${cap ? `<p class="fx-cap">${cap}</p>` : ''}
  </section>`;
}
const empty = (text) => `<p class="fx-empty">${esc(text)}</p>`;
const chart = (name) => `<div class="fx-chart" data-chart="${name}"></div>`;

// Številke kartic, da se kicker v seznamu ujema s kartico.
const K = {};

function layout(F) {
  const nVals = (F.values || []).length;
  let n = 0;
  const num2 = (key, title) => { n += 1; K[key] = `${String(n).padStart(2, '0')} · ${title}`; return n; };
  const sections = [
    ['fx-s-place', 'Ponovitve in mesta', [
      card({
        id: 'flags', n: num2('flags', 'Ponovitve na istem mestu'), span: true, title: 'Ponovitve na istem mestu',
        lead: 'Pari pogodb, katerih umeščena dela se prekrivajo, po vrsti nekonsistentnosti; klik na kartico pokaže pare',
        body: kpis(F.flags),
        cap: 'Številka je število parov pogodb, znesek pa vsota vrednosti kasnejših pogodb v teh parih. Ista pogodba je lahko v več parih, zato se zneski med karticami prekrivajo in jih ni mogoče seštevati. Garancijski roki niso v objavah, ampak v pogodbah, zato sta prva dva kazalnika odvisna od registra pogodb. Ponovitev ima lahko upravičen razlog: druga smer, druga plast vozišča, nepredvidena škoda.',
      }),
      card({
        id: 'hot', n: num2('hot', 'Najpogosteje obnovljena mesta'), span: true, title: 'Najpogosteje obnovljena mesta',
        lead: 'Kilometri osi avtoceste z največ pogodbami za gradnje; vsak stolpec v traku je ena pogodba, najstarejša levo',
        body: hotBody(F.hotspots),
        cap: 'Približno umeščene pogodbe (znan je le odsek med priključkoma) so štete na vsem odseku, zato je kup na takem odseku lahko večji od dejanskega; število natančno umeščenih je v seznamu. Veliko pogodb na istem mestu samo po sebi ni napaka (vozišče, objekti, ograje in oprema se obnavljajo ločeno), je pa dober začetek pregleda. Na zemljevidu v načinu 3D je vsaka pogodba ena plast.',
      }),
    ]],
    ['fx-s-price', 'Cene in konkurenca', [
      card({
        id: 'ratios', n: num2('ratios', 'Pogodbena in ocenjena vrednost'), title: 'Pogodbena in ocenjena vrednost', lead: 'Razmerje med vrednostjo ob oddaji in ocenjeno vrednostjo naročila',
        body: ratiosBody(F.ratios),
        cap: 'Kopičenje ponudb tik pod ocenjeno vrednostjo je klasičen znak dogovarjanja ponudnikov ali uhajanja ocene: v konkurenčnem postopku bi pričakovali večjo razpršenost in več ponudb opazno pod oceno. Razmerje okoli 1 ima lahko tudi nedolžen vzrok, npr. ponovljen postopek, v katerem je nova ocena že prilagojena prejetim ponudbam.',
      }),
      card({
        id: 'comp', n: num2('comp', 'Konkurenca in cena'), title: 'Konkurenca in cena', lead: 'Razmerje do ocenjene vrednosti po številu prejetih ponudb; črtica je mediana',
        body: compBody(F.ratios),
        cap: 'Z več ponudbami cena praviloma pade pod oceno. Če so tudi postopki z več ponudbami blizu ocene ali če se cena s številom ponudb ne spreminja, je to lahko znak, da ponudniki ne tekmujejo zares (spremljevalne ponudbe). Klik na stolpec pokaže vse pogodbe s tem številom ponudb, klik na točko eno pogodbo.',
      }),
      card({
        id: 'single', n: num2('single', 'Ena ponudba'), title: 'Ena ponudba', lead: 'Delež postopkov z eno samo ponudbo med pogodbami z znanim številom ponudb',
        body: singleBody(F.single),
        cap: 'Postopek z eno ponudbo pomeni, da konkurence ni bilo; Opentender/DIGIWHIST ga uporablja kot osnovni kazalnik tveganja. Vzroki so lahko upravičeni (specializirana dela, kratki roki, majhen trg) ali pa omejujoči pogoji in dogovor med ponudniki. Število ponudb je znano le iz objav o oddaji; svetlejši stolpci temeljijo na manj kot petih pogodbah.',
      }),
      card({
        id: 'unit', n: num2('unit', 'Cena na kilometer'), title: 'Cena na kilometer', lead: 'Vrednost obnove vozišča na kilometer osi ceste, natančno umeščena dela; črtkano je mediana',
        body: unitBody(F.unit_cost),
        cap: 'Groba primerjava: pogodba lahko zajema eno ali obe smeri vožnje, različno število plasti in pasov ter poleg vozišča še objekte, odvodnjavanje ali opremo. Točke daleč nad mediano so zato kandidati za pregled popisa del, ne dokaz previsoke cene. Dolžina je izmerjena po osi v OpenStreetMap.',
      }),
      card({
        id: 'benford', n: num2('benford', 'Benfordov zakon'), title: 'Benfordov zakon', lead: 'Porazdelitev prve števke zneskov, opaženo in pričakovano',
        body: benfordBody(F.benford),
        cap: 'V naravno nastalih zneskih je prva števka 1 v približno 30 % primerov, 9 pa le v 5 %. Večje odstopanje (MAD po Nigriniju) lahko kaže na prirejene ali izmišljene zneske. Pogodbene vrednosti se ravnajo po ocenjenih vrednostih in proračunih, zato odstopajo tudi brez manipulacije; pri nekaj sto zneskih je test zelo grob.',
      }),
    ]],
    ['fx-s-proc', 'Postopki, aneksi in čas', [
      card({
        id: 'direct', n: num2('direct', 'Neposredne oddaje'), title: 'Neposredne oddaje', lead: 'Pogodbe, oddane brez predhodne objave razpisa, po letih',
        body: directBody(F.direct),
        cap: 'Postopek s pogajanji brez predhodne objave je dovoljen le izjemoma: nujnost zaradi nepredvidljivih dogodkov, dodatna dela istega izvajalca, en sam možen izvajalec. Ker konkurence ni, je vsak tak postopek vreden pogleda v utemeljitev v objavi.',
      }),
      card({
        id: 'annex', n: num2('annex', 'Aneksi'), title: 'Aneksi', lead: 'Sprememba vrednosti pogodbe po aneksih glede na vrednost ob oddaji',
        body: annexBody(F),
        cap: 'Visoka rast z aneksi je znak tveganja, ker lahko pomeni prenizko ponudbo, ki jo izvajalec pozneje nadoknadi z dodatnimi deli. Zakon spremembe pogodb omejuje (dodatna dela praviloma do 50 % prvotne vrednosti). Iz objav so znani le objavljeni aneksi; del rasti je upravičen zaradi nepredvidenih razmer na terenu. Okrogli zneski lahko kažejo na pavšalno dogovorjene, ne izračunane spremembe.',
      }),
      card({
        id: 'speed', n: num2('speed', 'Čas do prvega aneksa'), title: 'Čas do prvega aneksa', lead: 'Mesecev od pogodbe do prve objavljene spremembe',
        body: speedBody(F.annex_speed),
        cap: 'Sprememba kmalu po podpisu lahko pomeni, da je bil dodatni obseg znan že ob oddaji (in je bil iz razpisa izpuščen) ali da je bila ponudba namerno prenizka. Čas je merjen do objave spremembe na portalu, ki je lahko več mesecev za podpisom aneksa, zato so dejanski časi krajši.',
      }),
      card({
        id: 'thresholds', n: num2('thresholds', 'Pragovi'), title: 'Pragovi', lead: 'Porazdelitev vrednosti pogodb na logaritemski lestvici z zakonskimi pragovi',
        body: thresholdsBody(F),
        cap: 'Če je tik pod pragom občutno več pogodb kot tik nad njim, je to lahko znak drobljenja naročil, da bi se izognili strožjemu postopku ali objavi v Uradnem listu EU. Pri majhnem številu pogodb so naključna nihanja velika, najmanjša naročila pa na portalu sploh niso objavljena, zato je levi del porazdelitve nepopoln.',
      }),
      card({
        id: 'serial', n: num2('serial', 'Zaporedna naročila istemu izvajalcu'), title: 'Zaporedna naročila istemu izvajalcu', lead: 'Ista vrsta dela, isti izvajalec, v 90 dneh; vsaka pogodba pod pragom, skupaj nad njim',
        body: serialBody(F.serial),
        cap: 'Zakon prepoveduje delitev naročila z namenom, da bi se izognili strožjim pravilom. Vzorec ima lahko tudi upravičen razlog (ločeni objekti, nujna dela, različni viri financiranja); pogodbe istega postopka (sklopi) niso štete.',
      }),
      card({
        id: 'months', n: num2('months', 'Mesec podpisa'), title: 'Mesec podpisa', lead: 'Število pogodb po mesecu sklenitve, vsa leta skupaj',
        body: monthsBody(F.months),
        cap: 'Kopičenje pogodb ob koncu leta (»decembrska mrzlica«) je pogost znak porabe preostalih proračunskih sredstev, pri kateri je priprava naročil hitrejša in manj skrbna. Pri gradnjah je naraven vrh spomladi in poleti, ko se dela lahko izvajajo.',
      }),
    ]],
    ['fx-s-market', 'Izvajalci in trg', [
      card({
        id: 'hhi', n: num2('hhi', 'Koncentracija trga (HHI)'), title: 'Koncentracija trga (HHI)', lead: 'Herfindahl-Hirschmanov indeks deležev izvajalcev v vrednosti gradenj DARS po letih; pasovi: nizka, zmerna in visoka koncentracija',
        body: hhiBody(F.hhi),
        cap: 'HHI je vsota kvadratov tržnih deležev (od 0 do 10.000): pod 1.500 je trg nekoncentriran, med 1.500 in 2.500 zmerno, nad 2.500 visoko koncentriran. Na letnem trgu enega naročnika lahko ena velika pogodba sama dvigne indeks, zato je pomembnejši trend kot posamezno leto. Vrednost skupnih ponudb je razdeljena med partnerje enakomerno. Klik na leto pokaže deleže izvajalcev in pogodbe.',
      }),
      card({
        id: 'market', n: num2('market', 'Delitev trga po cestah'), title: 'Delitev trga po cestah', lead: 'Delež izvajalcev v vrednosti gradenj na posamezni cesti',
        body: marketBody(F.market),
        cap: 'Če na posamezni cesti večino del dobiva isti izvajalec, drugi veliki izvajalci pa tam skoraj ne nastopajo, je to lahko znak geografske delitve trga (OECD). Razlog je lahko tudi bližina asfaltne baze, kamnoloma in mehanizacije. Vrednost pogodbe na več cestah je razdeljena enakomerno.',
      }),
      card({
        id: 'rotation', n: num2('rotation', 'Rotacija zmagovalcev'), span: true, title: 'Rotacija zmagovalcev', lead: 'Število pogodb (številka) in vrednost (odtenek) po letih za največje izvajalce',
        body: rotationBody(F.rotation, F.values),
        cap: 'Redno menjavanje istih podjetij, ki si zmage razdelijo po letih, odsekih ali vrstah del, lahko kaže na delitev trga. Vzorec je smiselno brati skupaj z mrežo skupnih ponudb: podjetja, ki se na papirju potegujejo za iste posle, pogosto nastopajo tudi kot partnerji. Klik na celico pokaže pogodbe, klik na ime vse pogodbe izvajalca.',
      }),
      card({
        id: 'firms', n: num2('firms', 'Kazalniki po izvajalcih'), span: true, title: 'Kazalniki po izvajalcih',
        lead: 'Izvajalci z vsaj dvema pogodbama gradenj; razvrstite s klikom na glavo stolpca, klik na število pokaže pogodbe',
        body: (F.firms || []).length ? '<div class="fx-scroll"><table class="fx-table"></table></div><div class="fx-table-foot"></div>' : empty('Ni izvajalcev z dovolj pogodbami za izračun kazalnikov.'),
        cap: `<b>Tabela je pripomoček za izbor primerov za podrobnejši pregled, ne seznam kršitev.</b> Zastavice: ena ponudba (vsaj 40 % pogodb z eno ponudbo, vsaj tri pogodbe), tik ob oceni (mediana razmerja 0,97–1,03, vsaj tri pogodbe), aneksi (mediana rasti nad 15 %), ponovljeno v garanciji, svoje delo v garanciji, razdrobljena naročila (vsaj dva primera). Vrednost skupnih ponudb je razdeljena med partnerje.${S.hasReg ? '' : ` Stolpec »ponovljeno v garanciji« potrebuje garancijske roke iz pogodb: ${NO_REG}`}`,
      }),
    ]],
  ];
  return `<div class="fx">
    <header class="fx-head">
      <h2>Forenzični kazalniki</h2>
      <p class="fx-intro">Statistični vzorci v javnih naročilih DARS za gradnje na avtocestah in hitrih cestah: kje se dela ponavljajo, razmerje med pogodbeno in ocenjeno vrednostjo, konkurenca, aneksi, kopičenje pod zakonskimi pragovi in delitev trga med izvajalci. Izbor sledi OECD smernicam za boj proti dogovarjanju ponudnikov in kazalnikom tveganja Opentender/DIGIWHIST. <b>Vsak stolpec, točka, celica in podčrtana številka odpre seznam pogodb, iz katerih je izračunana</b>, s povezavo na zemljevid in na izvirno objavo.</p>
      <div class="fx-disclaimer" role="note">
        <p><b>Kazalniki so rdeče zastavice za podrobnejši pregled, kot jih uporabljajo revizorji javnih naročil. Noben sam po sebi ne dokazuje nepravilnosti.</b></p>
        <p>Vsak ima lahko upravičeno razlago, ki jo je treba preveriti v razpisni dokumentaciji, pogodbi in pri naročniku.${S.hasReg ? '' : ' Register pogodb (garancijski roki, podizvajalci, dodatki k pogodbam) še ni v celoti prebran, zato so nekateri kazalniki nepopolni.'}</p>
      </div>
      <p class="fx-sources">Viri metod: OECD, Smernice za boj proti dogovarjanju ponudnikov pri javnem naročanju; <a href="https://opentender.eu/" target="_blank" rel="noopener">Opentender.eu</a> (DIGIWHIST), kazalniki tveganja javnih naročil; M. Nigrini, meje MAD za Benfordov zakon. Podatki: portal javnih naročil${nVals ? `, ${pogodb(nVals)} z znano vrednostjo` : ''}.</p>
    </header>
    <nav class="fx-toc" aria-label="Poglavja">${sections.map(([id, title]) => `<a href="#${id}" class="v-chip" data-jump="${id}">${title}</a>`).join('')}</nav>
    ${sections.map(([id, title, cards]) => `<section class="fx-sec" id="${id}" aria-label="${title}">
      <h2 class="fx-sec-h">${title}</h2>
      <div class="fx-grid">${cards.join('')}</div>
    </section>`).join('')}
  </div>
  <aside class="fx-drill" hidden aria-label="Pogodbe za izbrani podatek"></aside>`;
}

// --- 1. ponovitve: KPI trak ----------------------------------------------------------------------

function pairsFor(flag) {
  return (S.api?.pairs?.() || []).filter((r) => (r[6] || '').includes(flag)).map(([a, b, gap, overlap, , wy, flags]) => ({
    a, b, flags,
    note: `${yearsTxt(gap)} narazen · ${num1.format(overlap / 1000)} km skupaj${wy ? ` · garancija prejšnjega ${yearsTxt(wy)}` : ''}`,
  }));
}
function splitPairs() {
  return (S.api?.splits?.() || []).map(([a, b, days, shared]) => ({
    a, b, flags: '', note: `${num.format(days)} ${plural(days, ['dan', 'dneva', 'dnevi', 'dni'])} narazen · ${num1.format(shared / 1000)} km skupaj`,
  }));
}

function kpis(flags) {
  if (!flags) return empty('Ni podatkov o ponovitvah.');
  const count = flags.count || {};
  const value = flags.value || {};
  const tiles = [
    { k: 'g', label: 'v garancijski dobi', hint: 'kasnejše delo na istem mestu, ko je še veljala garancija prejšnjega', reg: true },
    { k: 'i', label: 'isti izvajalec v garanciji', hint: 'isti izvajalec znova plačan za isto mesto v svoji garancijski dobi', reg: true },
    { k: 'r', label: 'ponovno po rekonstrukciji', hint: 'ista dela manj kot 8 let po rekonstrukciji ali novogradnji' },
    { k: 'p', label: 'drugače poimenovana', hint: 'ista vrsta dela na istem mestu pod drugačnim naslovom' },
    { k: 's', label: 'sočasna ločena naročila', hint: 'hkratna ločena naročila za isto delo na istem mestu' },
  ];
  return `<div class="fx-kpis">${tiles.map((t) => {
    const n = t.k === 's' ? flags.splits : count[t.k];
    const missing = t.reg && !S.hasReg && !n;
    const v = t.k === 's' ? null : value[t.k];
    const inner = `<b>${missing ? '–' : num.format(n || 0)}</b>
      <span class="lab">${t.label}</span>
      ${missing ? `<span class="hint miss">${NO_REG}</span>` : v ? `<span class="val">kasnejše pogodbe: ${money(v)}</span>` : ''}
      <span class="hint">${t.hint}</span>`;
    if (!n) return `<div class="fx-kpi ${t.k}">${inner}</div>`;
    const spec = t.k === 's'
      ? { kicker: K.flags, title: 'Sočasna ločena naročila', sub: t.hint, pairs: splitPairs, order: 'd' }
      : { kicker: K.flags, title: `Ponovitve: ${t.label}`, sub: t.hint, pairs: () => pairsFor(t.k), flag: t.k };
    return drillBtn(spec, `${inner}<span class="go">pokaži ${parov(n)} →</span>`, `fx-kpi ${t.k}`);
  }).join('')}</div>`;
}

// --- 2. najpogosteje obnovljena mesta ------------------------------------------------------------

function hotBody(H) {
  if (!H?.length) return empty('Ni mest z vsaj tremi pogodbami.');
  // Kilometri osi z vsaj 5 in 10 pogodbami (vsa umeščena dela).
  const cells = new Map();
  for (const p of allProjects()) {
    for (const [r, a, b] of p.lr || []) {
      for (let k = Math.floor(a); k < Math.max(Math.floor(a) + 1, Math.ceil(b)); k++) cells.set(`${r}|${k}`, (cells.get(`${r}|${k}`) || 0) + 1);
    }
  }
  const c5 = [...cells.values()].filter((v) => v >= 5).length;
  const c10 = [...cells.values()].filter((v) => v >= 10).length;
  const cats = new Set();
  const rows = H.map((h, i) => {
    const where = `${h.road} km ${h.km[0]}–${h.km[1]}`;
    const spec = {
      kicker: K.hot, title: `${where}${h.name ? ` · ${h.name}` : ''}`,
      sub: `${pogodb(h.n)}${h.years ? ` od ${h.years[0]} do ${h.years[1]}` : ''}, od tega ${num.format(h.precise)} natančno umeščenih (km ali objekt). Plast 1 je najstarejša pogodba.`,
      items: h.ids.map((id, k) => ({ id, note: `plast ${k + 1}${P(id)?.p ? ` · ${P(id).p === 'km' || P(id).p === 'objekt' ? 'natančno' : 'približno'}` : ''}` })),
      order: 'd', ll: h.ll,
    };
    const blocks = h.ids.map((id) => {
      const p = P(id);
      if (!p) return '';
      cats.add(p.cat);
      const approx = p.p !== 'km' && p.p !== 'objekt';
      return `<i class="${approx ? 'ap' : ''}" style="--c:${color(p.cat)}" title="${esc(`${p.y ?? ''}: ${p.t}`)}"></i>`;
    }).join('');
    return `<li>${drillBtn(spec, `<span class="rk">${i + 1}</span>
      <span class="nm"><b>${esc(where)}</b><small>${esc(h.name || '')}</small></span>
      <span class="stk">${blocks}</span>
      <span class="n">${num.format(h.n)}</span>
      <span class="v">${esc(money(h.v))}</span>
      <span class="yr">${h.years ? `${h.years[0]}–${String(h.years[1]).slice(2)}` : ''}</span>`, 'fx-hot-row')}</li>`;
  }).join('');
  return `<div class="fx-stats">
      <span>kilometrov osi z vsaj 5 pogodbami: <b>${num.format(c5)}</b></span>
      <span>z vsaj 10: <b>${num.format(c10)}</b></span>
      <button type="button" class="v-btn" data-three>Odpri zemljevid 3D s plastmi →</button>
    </div>
    <ol class="fx-hot">${rows}</ol>
    <div class="fx-legend">${[...cats].map((c) => `<span><i style="background:${color(c)}"></i>${esc(catName(c))}</span>`).join('')}<span><i class="ap-sw"></i>približno umeščena</span></div>`;
}

// --- 3. razmerje do ocene --------------------------------------------------------------------

function ratioValues(ratios) {
  return (ratios || []).filter((r) => isNum(r?.[1]));
}
const ratioItems = (pred) => ratioValues(S.F.ratios).filter(([, r]) => pred(r)).map(([id, r]) => {
  const p = P(id);
  return { id, note: `razmerje ${num3.format(r)}${p?.e ? ` · ocena ${money(p.e)}` : ''}${p?.b ? ` · ponudb ${p.b}` : ''}` };
});

function ratiosBody(ratios) {
  const R = ratioValues(ratios);
  if (!R.length) return empty('Ni pogodb z znano ocenjeno vrednostjo.');
  const v = R.map((r) => r[1]);
  const near = v.filter((x) => x >= 0.97 && x <= 1).length;
  const over = v.filter((x) => x > 1).length;
  const out = v.filter((x) => x < 0.4 || x >= 1.6).length;
  const med = median(v);
  const band = (title, pred) => ({ kicker: K.ratios, title, items: () => ratioItems(pred) });
  return `${chart('ratios')}
    <div class="fx-legend"><span><i class="hl"></i>pogodbe v pasu 0,97–1,00 (tik pod oceno ali enako oceni)</span><span><i class="obs-bar"></i>razredi po 0,05</span></div>
    <div class="fx-stats">
      <span class="warn">${drillBtn(band('V pasu 0,97–1,00 ocenjene vrednosti', (x) => x >= 0.97 && x <= 1), `<b>${pct(near / v.length, 1)}</b>`)} v pasu 0,97–1,00 (${num.format(near)} od ${pogodb(v.length)})</span>
      <span>${drillBtn(band('Nad ocenjeno vrednostjo', (x) => x > 1), `<b>${pct(over / v.length, 1)}</b>`)} nad oceno (${num.format(over)})</span>
      <span>mediana <b>${num3.format(med)}</b></span>
      ${out ? `<span>${drillBtn(band('Zunaj prikaza (pod 0,4 ali nad 1,6)', (x) => x < 0.4 || x >= 1.6), `zunaj prikaza: <b>${num.format(out)}</b>`)}</span>` : ''}
    </div>`;
}

function drawRatios(node, w, d3, ratios) {
  const v = ratioValues(ratios).map((r) => r[1]);
  const bins = d3.range(24).map((i) => ({ a: 0.4 + i * 0.05, b: 0.45 + i * 0.05, n: 0 }));
  let band = 0;
  for (const x of v) {
    const k = Math.round(x * 1000); // celoštevilsko, da 1,000 ne pade v napačen razred
    if (k >= 400 && k < 1600) bins[Math.floor((k - 400) / 50)].n += 1;
    if (k >= 970 && k <= 1000) band += 1;
  }
  const { g, iw, ih } = frame(d3, node, w, 200, { t: 18, r: 8, b: 24, l: 30 },
    `Histogram razmerja pogodbena proti ocenjeni vrednosti za ${pogodb(v.length)}, razredi po 0,05`);
  const x = d3.scaleLinear().domain([0.4, 1.6]).range([0, iw]);
  const y = d3.scaleLinear().domain([0, Math.max(1, band, ...bins.map((b) => b.n))]).nice().range([ih, 0]);
  yGrid(d3, g, y, iw, num.format, 4);
  bins.forEach((b, i) => {
    const lo = Math.round(b.a * 1000);
    const key = b.n ? reg('c', {
      kicker: K.ratios, title: `Razmerje ${dec(b.a, 2)}–${dec(b.b, 2)}`, sig: `ratio:${i}`,
      items: () => ratioItems((r) => { const k = Math.round(r * 1000); return k >= lo && k < lo + 50; }),
    }) : null;
    hit(g, x(b.a), 0, x(b.b) - x(b.a), ih, `${dec(b.a, 2)}–${dec(b.b, 2)} × ocene: ${pogodb(b.n)}`, key);
    const bw = Math.min(24, x(b.b) - x(b.a) - 2);
    const bx = (x(b.a) + x(b.b)) / 2 - bw / 2;
    g.append('path').attr('class', 'fx-bar').attr('d', barPath(bx, y(b.n), bw, ih - y(b.n)));
  });
  // pas 0,97–1,00 kot ožji stolpec čez razred 0,95–1,00: pokaže, koliko pogodb je tik pod oceno
  const bx0 = x(0.97) + 0.5;
  const bw0 = Math.max(2, x(1) - x(0.97) - 1);
  g.append('path').attr('class', 'fx-bar hl').attr('d', barPath(bx0, y(band), bw0, ih - y(band), 2));
  hit(g, bx0, y(band), bw0, ih - y(band), `0,97–1,00 × ocene: ${pogodb(band)}`, band ? reg('c', {
    kicker: K.ratios, title: 'V pasu 0,97–1,00 ocenjene vrednosti', sig: 'ratio:band',
    items: () => ratioItems((r) => r >= 0.97 && r <= 1),
  }) : null);
  g.append('text').attr('class', 'ref').attr('x', x(0.97) - 4).attr('y', Math.max(-6, y(band) + 4)).attr('text-anchor', 'end').text(num.format(band));
  g.append('line').attr('class', 'fx-ref-ink').attr('x1', x(1)).attr('x2', x(1)).attr('y1', -10).attr('y2', ih);
  g.append('text').attr('class', 'lbl').attr('x', x(1) + 5).attr('y', -4).text('= ocena');
  xAxis(d3, g, ih, d3.axisBottom(x).tickValues([0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6]).tickFormat((t) => dec(t)));
}

// --- 4. konkurenca in cena --------------------------------------------------------------------

const BID_COLS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'];
const bidCol = (b) => (b >= 10 ? '10+' : String(b));

function compPoints(ratios) {
  return ratioValues(ratios).map(([id, r]) => ({ id, r, b: P(id)?.b })).filter((d) => d.b >= 1);
}

function compBody(ratios) {
  const pts = compPoints(ratios);
  if (pts.length < 10) return empty('Premalo pogodb z znanim številom ponudb in ocenjeno vrednostjo.');
  const grp = (lo, hi) => pts.filter((d) => d.b >= lo && d.b <= hi);
  const stat = (lo, hi, label) => {
    const list = grp(lo, hi);
    if (!list.length) return '';
    const spec = { kicker: K.comp, title: `Razmerje do ocene: ${label}`, items: () => ratioItems((r) => true).filter((it) => { const b = P(it.id)?.b; return b >= lo && b <= hi; }) };
    return `<span>${label}: ${drillBtn(spec, `mediana <b>${num3.format(median(list.map((d) => d.r)))}</b>`)} (${pogodb(list.length)})</span>`;
  };
  return `${chart('comp')}
    <div class="fx-stats">${stat(1, 1, 'ena ponudba')}${stat(2, 3, '2–3 ponudbe')}${stat(4, 999, '4 ali več')}</div>`;
}

function hash01(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function drawComp(node, w, d3, ratios) {
  const pts = compPoints(ratios);
  const { g, iw, ih } = frame(d3, node, w, 220, { t: 12, r: 46, b: 30, l: 34 },
    `Razmerje pogodbene in ocenjene vrednosti po številu ponudb za ${pogodb(pts.length)}`);
  const x = d3.scaleBand().domain(BID_COLS).range([0, iw]).paddingInner(0.18).paddingOuter(0.05);
  const y = d3.scaleLinear().domain([0.4, 1.6]).range([ih, 0]);
  yGrid(d3, g, y, iw, (t) => dec(t), null, [0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6]);
  g.append('line').attr('class', 'fx-ref-ink').attr('x1', 0).attr('x2', iw).attr('y1', y(1)).attr('y2', y(1));
  g.append('text').attr('class', 'lbl').attr('x', iw + 6).attr('y', y(1) + 3).text('= ocena');
  for (const col of BID_COLS) {
    const list = pts.filter((d) => bidCol(d.b) === col);
    const key = list.length ? reg('c', {
      kicker: K.comp, title: `${col === '1' ? 'Ena ponudba' : `${col} ponudb${col === '2' ? 'i' : col === '3' || col === '4' ? 'e' : ''}`}`, sig: `comp:${col}`,
      items: () => ratioItems(() => true).filter((it) => bidCol(P(it.id)?.b) === col),
    }) : null;
    hit(g, x(col) - (x.step() - x.bandwidth()) / 2, 0, x.step(), ih, `${col} ${col === '1' ? 'ponudba' : 'ponudb'}: ${pogodb(list.length)}${list.length ? `, mediana ${num3.format(median(list.map((d) => d.r)))}` : ''}`, key);
    for (const d of list) {
      const cx = x(col) + x.bandwidth() * (0.15 + 0.7 * hash01(d.id));
      const cy = y(Math.max(0.4, Math.min(1.6, d.r)));
      const p = P(d.id);
      g.append('circle').attr('class', 'fx-pt').attr('cx', cx).attr('cy', cy).attr('r', 2.6);
      const k1 = reg('c', { kicker: K.comp, title: p?.t || 'Pogodba', sig: `comp-pt:${d.id}`, items: [{ id: d.id, note: `razmerje ${num3.format(d.r)} · ponudb ${d.b}` }] });
      g.append('circle').attr('class', 'fx-pt-hit').attr('cx', cx).attr('cy', cy).attr('r', 5)
        .attr('data-drill', k1).attr('tabindex', -1)
        .append('title').text(`${p?.y ?? ''} ${p?.t ?? ''}: razmerje ${num3.format(d.r)}, ponudb ${d.b}`);
    }
    if (list.length >= 3) {
      const m = median(list.map((d) => d.r));
      g.append('line').attr('class', 'fx-med').attr('x1', x(col) + 2).attr('x2', x(col) + x.bandwidth() - 2).attr('y1', y(m)).attr('y2', y(m));
    }
    g.append('text').attr('class', 'lbl').attr('x', x(col) + x.bandwidth() / 2).attr('y', ih + 24).attr('text-anchor', 'middle').text(`n ${list.length}`);
  }
  xAxis(d3, g, ih, d3.axisBottom(x));
  g.append('text').attr('class', 'lbl').attr('x', iw + 6).attr('y', ih + 14).text('ponudb');
}

// --- 5. ena ponudba -----------------------------------------------------------------------

function singleRows(single) {
  return Object.entries(single || {})
    .map(([y, r]) => ({ y: Number(y), s: r?.[0] || 0, k: r?.[1] || 0, ids: r?.[2] || [] }))
    .filter((d) => Number.isFinite(d.y))
    .sort((a, b) => a.y - b.y);
}
const singleNote = (id) => {
  const p = P(id);
  return { id, note: `ena ponudba${p?.e ? ` · ocena ${money(p.e)}` : ''}` };
};

function singleBody(single) {
  const rows = singleRows(single);
  const s = rows.reduce((a, d) => a + d.s, 0);
  const k = rows.reduce((a, d) => a + d.k, 0);
  if (!k) return empty('Število ponudb ni znano za nobeno pogodbo.');
  const top = rows.filter((d) => d.k >= 5).sort((a, b) => b.s / b.k - a.s / a.k)[0];
  const all = { kicker: K.single, title: 'Vse pogodbe z eno ponudbo', items: () => rows.flatMap((d) => d.ids.map(singleNote)) };
  return `${chart('single')}
    <div class="fx-stats">
      <span>${drillBtn(all, `<b>${pct(s / k, 1)}</b>`)} vseh (${num.format(s)} od ${pogodb(k)})</span>
      ${top ? `<span>največ ${top.y}: ${drillBtn({ kicker: K.single, title: `Ena ponudba v letu ${top.y}`, items: () => top.ids.map(singleNote) }, `<b>${pct(top.s / top.k)}</b>`)} (${num.format(top.s)} od ${num.format(top.k)})</span>` : ''}
    </div>`;
}

function drawSingle(node, w, d3, single) {
  const rows = singleRows(single);
  const S0 = rows.reduce((a, d) => a + d.s, 0);
  const K0 = rows.reduce((a, d) => a + d.k, 0);
  const { g, iw, ih } = frame(d3, node, w, 190, { t: 12, r: 46, b: 22, l: 34 },
    `Delež pogodb z eno ponudbo po letih, skupaj ${pct(S0 / K0, 1)}`);
  const x = d3.scaleBand().domain(rows.map((d) => d.y)).range([0, iw]).paddingInner(0.22).paddingOuter(0.05);
  const max = Math.max(0.4, ...rows.map((d) => (d.k ? d.s / d.k : 0)));
  const y = d3.scaleLinear().domain([0, max]).nice().range([ih, 0]);
  yGrid(d3, g, y, iw, (v) => `${num.format(v * 100)} %`, 4);
  const bw = Math.min(24, x.bandwidth());
  rows.forEach((d) => {
    const share = d.k ? d.s / d.k : null;
    const key = d.s ? reg('c', { kicker: K.single, title: `Ena ponudba v letu ${d.y}`, sub: `${num.format(d.s)} od ${pogodb(d.k)} z znanim številom ponudb`, sig: `single:${d.y}`, items: () => d.ids.map(singleNote) }) : null;
    hit(g, x(d.y) - (x.step() - x.bandwidth()) / 2, 0, x.step(), ih, share == null
      ? `${d.y}: število ponudb ni znano`
      : `${d.y}: ${num.format(d.s)} od ${pogodb(d.k)} z eno ponudbo (${pct(share)})`, key);
    if (share == null) return;
    g.append('path').attr('class', `fx-bar${d.k < 5 ? ' faint' : ''}`)
      .attr('d', barPath(x(d.y) + (x.bandwidth() - bw) / 2, y(share), bw, ih - y(share)));
  });
  const avg = S0 / K0;
  g.append('line').attr('class', 'fx-ref-soft').attr('x1', 0).attr('x2', iw).attr('y1', y(avg)).attr('y2', y(avg));
  g.append('text').attr('class', 'lbl').attr('x', iw + 6).attr('y', y(avg) - 2).text('povp.');
  g.append('text').attr('class', 'lbl-strong').attr('x', iw + 6).attr('y', y(avg) + 10).text(pct(avg));
  xAxis(d3, g, ih, d3.axisBottom(x).tickValues(thin(rows.map((d) => d.y), x.step())).tickFormat(yearFmt(x.step())));
}

// --- 6. cena na kilometer -------------------------------------------------------------------

function unitRows(U) {
  const rows = (U || []).filter((r) => r[1] > 0 && r[2] > 0).map(([id, km, v, cat, dirs]) => ({ id, km, v, cat, dirs, e: v / km }));
  const counts = {};
  for (const r of rows) counts[r.cat] = (counts[r.cat] || 0) + 1;
  return rows.filter((r) => counts[r.cat] >= 5);
}
const unitNote = (r) => `${money(r.e)}/km · ${num1.format(r.km)} km osi${r.dirs === 1 ? ' · ena smer' : ''}`;

function unitBody(U) {
  const rows = unitRows(U);
  if (!rows.length) return empty('Premalo natančno umeščenih del za primerjavo cene na kilometer.');
  const cats = [...new Set(rows.map((r) => r.cat))];
  const parts = cats.map((c) => {
    const list = rows.filter((r) => r.cat === c);
    const m = median(list.map((r) => r.e));
    const hi = list.filter((r) => r.e > 3 * m);
    return `<span>${esc(catName(c))}: mediana <b>${money(m)}/km</b> (${pogodb(list.length)})</span>
      ${hi.length ? `<span class="warn">${drillBtn({ kicker: K.unit, title: `${catName(c)}: več kot 3 × mediana na km`, items: () => hi.map((r) => ({ id: r.id, sort: r.e, note: unitNote(r) })) }, `<b>${num.format(hi.length)}</b> nad 3 × mediano`)}</span>` : ''}`;
  }).join('');
  return `${chart('unit')}<div class="fx-stats">${parts}</div>`;
}

function drawUnit(node, w, d3, U) {
  const rows = unitRows(U);
  const { g, iw, ih } = frame(d3, node, w, 230, { t: 10, r: 56, b: 26, l: 52 },
    `Cena na kilometer osi glede na dolžino za ${pogodb(rows.length)}, logaritemski osi`);
  const x = d3.scaleLog().domain([Math.min(...rows.map((r) => r.km)) * 0.8, Math.max(...rows.map((r) => r.km)) * 1.25]).range([0, iw]);
  const y = d3.scaleLog().domain([Math.min(...rows.map((r) => r.e)) / 1.4, Math.max(...rows.map((r) => r.e)) * 1.4]).range([ih, 0]);
  const yt = [1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7].filter((t) => t >= y.domain()[0] && t <= y.domain()[1]);
  yGrid(d3, g, y, iw, (t) => money(t), null, yt);
  for (const c of new Set(rows.map((r) => r.cat))) {
    const m = median(rows.filter((r) => r.cat === c).map((r) => r.e));
    g.append('line').attr('class', 'fx-med-dash').attr('x1', 0).attr('x2', iw).attr('y1', y(m)).attr('y2', y(m)).attr('stroke', color(c));
    g.append('text').attr('class', 'lbl').attr('x', iw + 4).attr('y', y(m) + 3).text('mediana');
  }
  for (const r of rows.sort((a, b) => b.km - a.km)) {
    const p = P(r.id);
    g.append('circle').attr('class', 'fx-pt cat').attr('cx', x(r.km)).attr('cy', y(r.e)).attr('r', 4).attr('fill', color(r.cat));
    const key = reg('c', { kicker: K.unit, title: p?.t || 'Pogodba', sig: `unit:${r.id}`, items: [{ id: r.id, sort: r.e, note: unitNote(r) }] });
    g.append('circle').attr('class', 'fx-pt-hit').attr('cx', x(r.km)).attr('cy', y(r.e)).attr('r', 7).attr('data-drill', key).attr('tabindex', 0).attr('role', 'button')
      .attr('aria-label', `${p?.t ?? ''}: ${unitNote(r)}`)
      .append('title').text(`${p?.y ?? ''} ${p?.t ?? ''}: ${unitNote(r)}`);
  }
  const xt = [0.3, 0.5, 1, 2, 5, 10, 20, 50].filter((t) => t >= x.domain()[0] && t <= x.domain()[1]);
  xAxis(d3, g, ih, d3.axisBottom(x).tickValues(xt).tickFormat((t) => `${dec(t)} km`));
}

// --- 7. Benford -----------------------------------------------------------------------------

const firstDigit = (v) => (v >= 10 ? Number(String(Math.floor(v))[0]) : null);
function benfordItems(kind, d) {
  if (kind === 'award') {
    return (S.F.values || []).filter(([, v]) => firstDigit(v) === d).map(([id, v]) => ({ id, amt: v, note: `vrednost ob oddaji ${moneyFull(v)}` }));
  }
  return (S.F.annex_amounts || []).filter(([, v]) => firstDigit(v) === d).map(([id, v, url]) => ({ id, amt: v, note: `sprememba ${moneyFull(v)}`, url, urlLabel: 'aneks' }));
}

function benfordBody(b) {
  const parts = [['award', 'Vrednosti ob oddaji'], ['annex', 'Zneski aneksov']].filter(([k]) => b?.[k]?.obs?.length === 9);
  if (!parts.length) return empty('Premalo zneskov za test (potrebnih je vsaj 50).');
  const legend = '<div class="fx-legend"><span><i class="obs"></i>opaženo</span><span><i class="exp"></i>pričakovano po Benfordu</span></div>';
  return legend + parts.map(([k, label]) => {
    const x = b[k];
    const warn = x.verdict === 'mejna' || x.verdict === 'neskladnost';
    return `${parts.length > 1 ? `<p class="fx-sub">${label}</p>` : ''}
      ${chart(`benford-${k}`)}
      <p class="fx-verdict"><span>MAD <b>${num3.format(x.mad)}</b></span><span class="v-tag${warn ? ' warn' : ''}">${VERDICT[x.verdict] || esc(x.verdict)}</span><span>χ² ${dec(x.chi2)} · n = ${num.format(x.n)}</span></p>`;
  }).join('') + '<p class="fx-lead" style="margin-top:6px">Meje MAD: do 0,006 tesna, do 0,012 sprejemljiva, do 0,015 mejna skladnost, nad tem neskladnost.</p>';
}

function drawBenford(node, w, d3, b, kind) {
  const { g, iw, ih } = frame(d3, node, w, 180, { t: 8, r: 4, b: 22, l: 34 },
    `Benfordov zakon: delež prve števke 1 do 9, opaženo in pričakovano, n = ${b.n}`);
  const digits = d3.range(1, 10);
  const x = d3.scaleBand().domain(digits).range([0, iw]).paddingInner(0.28).paddingOuter(0.1);
  const y = d3.scaleLinear().domain([0, Math.max(...b.obs, ...b.exp) * 1.08]).nice().range([ih, 0]);
  yGrid(d3, g, y, iw, (v) => `${num.format(v * 100)} %`, 4);
  const bw = Math.min(12, (x.bandwidth() - 2) / 2);
  digits.forEach((d, i) => {
    const key = reg('c', {
      kicker: K.benford, title: `${kind === 'award' ? 'Vrednosti ob oddaji' : 'Zneski aneksov'} s prvo števko ${d}`,
      sub: `opaženo ${pct(b.obs[i], 1)}, pričakovano ${pct(b.exp[i], 1)}`, sig: `ben:${kind}:${d}`, items: () => benfordItems(kind, d),
    });
    hit(g, x(d) - (x.step() - x.bandwidth()) / 2, 0, x.step(), ih,
      `Prva števka ${d}: opaženo ${pct(b.obs[i], 1)}, pričakovano ${pct(b.exp[i], 1)}`, key);
    const cx = x(d) + x.bandwidth() / 2;
    g.append('path').attr('class', 'fx-bar obs').attr('d', barPath(cx - bw - 1, y(b.obs[i]), bw, ih - y(b.obs[i])));
    g.append('path').attr('class', 'fx-bar exp').attr('d', barPath(cx + 1, y(b.exp[i]), bw, ih - y(b.exp[i])));
  });
  xAxis(d3, g, ih, d3.axisBottom(x));
}

// --- 8. neposredne oddaje --------------------------------------------------------------------

function directRows(D) {
  return Object.entries(D || {}).map(([y, r]) => ({ y: Number(y), n: r[0], all: r[1], v: r[2], ids: r[3] || [] }))
    .filter((d) => Number.isFinite(d.y)).sort((a, b) => a.y - b.y);
}
const directNote = (id) => ({ id, note: 'neposredna oddaja brez objave razpisa' });

function directBody(D) {
  const rows = directRows(D);
  const n = rows.reduce((s, d) => s + d.n, 0);
  const all = rows.reduce((s, d) => s + d.all, 0);
  if (!all) return empty('Ni podatkov o vrsti postopka.');
  if (!n) return `<div class="fx-stats"><span>Med ${pogodb(all)} ni neposrednih oddaj.</span></div>`;
  const v = rows.reduce((s, d) => s + d.v, 0);
  return `${chart('direct')}
    <div class="fx-stats">
      <span>${drillBtn({ kicker: K.direct, title: 'Vse neposredne oddaje', items: () => rows.flatMap((d) => d.ids.map(directNote)) }, `<b>${num.format(n)}</b>`)} od ${pogodb(all)} (${pct(n / all, 1)})</span>
      <span>vrednost <b>${money(v)}</b></span>
    </div>`;
}

function drawDirect(node, w, d3, D) {
  const rows = directRows(D);
  const { g, iw, ih } = frame(d3, node, w, 170, { t: 12, r: 8, b: 22, l: 28 }, 'Število neposrednih oddaj po letih');
  const x = d3.scaleBand().domain(rows.map((d) => d.y)).range([0, iw]).paddingInner(0.22).paddingOuter(0.05);
  const y = d3.scaleLinear().domain([0, Math.max(3, ...rows.map((d) => d.n))]).nice().range([ih, 0]);
  yGrid(d3, g, y, iw, num.format, 3);
  const bw = Math.min(24, x.bandwidth());
  for (const d of rows) {
    const key = d.n ? reg('c', { kicker: K.direct, title: `Neposredne oddaje v letu ${d.y}`, sub: `${num.format(d.n)} od ${pogodb(d.all)} v letu`, sig: `direct:${d.y}`, items: () => d.ids.map(directNote) }) : null;
    hit(g, x(d.y) - (x.step() - x.bandwidth()) / 2, 0, x.step(), ih, `${d.y}: ${num.format(d.n)} neposrednih od ${pogodb(d.all)}${d.v ? `, ${money(d.v)}` : ''}`, key);
    g.append('path').attr('class', 'fx-bar hl').attr('d', barPath(x(d.y) + (x.bandwidth() - bw) / 2, y(d.n), bw, ih - y(d.n)));
  }
  xAxis(d3, g, ih, d3.axisBottom(x).tickValues(thin(rows.map((d) => d.y), x.step())).tickFormat(yearFmt(x.step())));
}

// --- 9. aneksi -------------------------------------------------------------------------------

const growthItems = (rows, pred, reg2) => rows.filter((r) => isNum(r?.[1]) && pred(r[1])).map(([id, r, n]) => {
  const p = P(id);
  return { id, sort: r, note: reg2 ? `${signedPct(r)} · ${n} ${plural(n, ['dodatek', 'dodatka', 'dodatki', 'dodatkov'])} v registru` : `${signedPct(r)}: ${money(p?.v)} → ${money(p?.vf)}` };
});

function annexBody(F) {
  const G = (F.growth || []).filter((r) => isNum(r?.[1]));
  const RG = (F.reg_growth || []).filter((r) => isNum(r?.[1]));
  const v = G.map((r) => r[1]);
  const share = (t) => v.filter((x) => x > t).length;
  const round = F.round_annex;
  const gs = (title, pred) => ({ kicker: K.annex, title, items: () => growthItems(G, pred) });
  let html = '';
  if (G.length) {
    html += `<p class="fx-sub">Iz objav o spremembah (n = ${num.format(G.length)})</p>${chart('growth')}
      <div class="fx-stats">
        <span>nad +10 %: ${drillBtn(gs('Rast z aneksi nad +10 %', (x) => x > 0.1), `<b>${num.format(share(0.1))}</b>`)}</span>
        <span class="${share(0.3) ? 'warn' : ''}">nad +30 %: ${drillBtn(gs('Rast z aneksi nad +30 %', (x) => x > 0.3), `<b>${num.format(share(0.3))}</b>`)}</span>
        <span class="${share(0.5) ? 'warn' : ''}">nad +50 %: ${drillBtn(gs('Rast z aneksi nad +50 %', (x) => x > 0.5), `<b>${num.format(share(0.5))}</b>`)}</span>
        <span>znižanj: ${drillBtn(gs('Znižanje vrednosti z aneksi', (x) => x < 0), `<b>${num.format(v.filter((x) => x < 0).length)}</b>`)}</span>
        <span>mediana <b>${signedPct(median(v))}</b></span>
      </div>`;
  } else {
    html += empty('Ni pogodb s spremenjeno vrednostjo v objavah.');
  }
  if (RG.length) {
    const avgN = RG.reduce((a, r) => a + (r[2] || 0), 0) / RG.length;
    html += `<p class="fx-sub" style="margin-top:14px">Iz registra pogodb (n = ${num.format(RG.length)}, povprečno ${dec(avgN)} dodatka)</p>${chart('reg-growth')}`;
  } else {
    html += `<p class="fx-sub" style="margin-top:14px">Iz registra pogodb</p>${empty(NO_REG)}`;
  }
  const roundItems = () => (F.annex_amounts || []).filter(([, a]) => a % 1000 === 0).map(([id, a, url]) => ({ id, amt: a, note: `okrogel znesek ${moneyFull(a)}`, url, urlLabel: 'aneks' }));
  html += `<div class="fx-stats"><span>okrogli zneski aneksov (deljivi s 1.000 €): ${isNum(round) ? drillBtn({ kicker: K.annex, title: 'Okrogli zneski aneksov', items: roundItems }, `<b>${pct(round, 1)}</b>`) : '<b>ni podatka</b>'}</span></div>`;
  return html;
}

function drawGrowth(node, w, d3, rows, label, isReg) {
  const k = rows.filter((r) => isNum(r?.[1])).map((r) => Math.round(r[1] * 1000)); // desetinke odstotne točke
  const min = Math.min(...k) / 10;
  const max = Math.max(...k) / 10;
  const lo = Math.max(-100, Math.min(-20, Math.floor(min / 10) * 10));
  const hi = Math.min(150, Math.max(60, Math.ceil(max / 10) * 10));
  const nb = (hi - lo) / 5;
  const bins = d3.range(nb).map((i) => ({ a: lo + i * 5, b: lo + i * 5 + 5, n: 0 }));
  let over = 0;
  for (const t of k) {
    let i = Math.floor((t - lo * 10) / 50);
    if (i >= nb) { over += 1; i = nb - 1; }
    bins[Math.max(0, i)].n += 1;
  }
  const { g, iw, ih } = frame(d3, node, w, 190, { t: 16, r: 8, b: 24, l: 30 }, label);
  const x = d3.scaleLinear().domain([lo, hi]).range([0, iw]);
  const y = d3.scaleLinear().domain([0, Math.max(1, ...bins.map((b) => b.n))]).nice().range([ih, 0]);
  yGrid(d3, g, y, iw, num.format, 4);
  bins.forEach((b, i) => {
    const last = i === nb - 1 && over;
    const first = i === 0;
    const pred = (r) => {
      const t = Math.round(r * 1000);
      let j = Math.floor((t - lo * 10) / 50);
      j = Math.max(0, Math.min(nb - 1, j));
      return j === i;
    };
    const title = `${signedPct(b.a / 100)} do ${last ? 'več' : signedPct(b.b / 100)}`;
    const key = b.n ? reg('c', { kicker: K.annex, title: `${isReg ? 'Dodatki v registru' : 'Rast z aneksi'}: ${first && lo <= -100 ? 'do ' : ''}${title}`, sig: `growth:${isReg ? 'r' : 'o'}:${i}`, items: () => growthItems(rows, pred, isReg) }) : null;
    hit(g, x(b.a), 0, x(b.b) - x(b.a), ih, `${title}: ${pogodb(b.n)}`, key);
    const bw = Math.min(24, x(b.b) - x(b.a) - 2);
    g.append('path').attr('class', 'fx-bar').attr('d', barPath((x(b.a) + x(b.b)) / 2 - bw / 2, y(b.n), bw, ih - y(b.n)));
  });
  g.append('line').attr('class', 'fx-ref-soft').attr('x1', x(0)).attr('x2', x(0)).attr('y1', 0).attr('y2', ih);
  for (const t of [10, 30, 50]) {
    if (t >= hi) continue;
    g.append('line').attr('class', 'fx-ref').attr('x1', x(t)).attr('x2', x(t)).attr('y1', -6).attr('y2', ih);
    g.append('text').attr('class', 'ref').attr('x', x(t)).attr('y', -9).attr('text-anchor', 'middle').text(`+${t} %`);
  }
  xAxis(d3, g, ih, d3.axisBottom(x).ticks(Math.max(4, Math.floor(iw / 55))).tickFormat((t) => `${t > 0 ? '+' : t < 0 ? '−' : ''}${Math.abs(t)} %`));
}

// --- 10. čas do prvega aneksa ------------------------------------------------------------------

const SPEED_BINS = [[0, 6], [6, 12], [12, 18], [18, 24], [24, 36], [36, 48], [48, Infinity]];
const speedItems = (pred) => (S.F.annex_speed || []).filter(([, d]) => pred(d / 30.44)).map(([id, d]) => ({ id, sort: -d, note: `prva sprememba po ${num.format(Math.round(d / 30.44))} mes. (${num.format(d)} dni)` }));

function speedBody(A) {
  if (!A?.length) return empty('Ni pogodb z objavljeno spremembo.');
  const m = A.map(([, d]) => d / 30.44);
  const y1 = m.filter((x) => x < 12).length;
  return `${chart('speed')}
    <div class="fx-stats">
      <span>v prvem letu: ${drillBtn({ kicker: K.speed, title: 'Prva sprememba v prvem letu po pogodbi', items: () => speedItems((x) => x < 12), order: 'v' }, `<b>${num.format(y1)}</b>`)} od ${pogodb(A.length)}</span>
      <span>mediana <b>${num.format(median(m))} mes.</b></span>
    </div>`;
}

function drawSpeed(node, w, d3, A) {
  const m = A.map(([, d]) => d / 30.44);
  const bins = SPEED_BINS.map(([a, b]) => ({ a, b, n: m.filter((x) => x >= a && x < b).length }));
  const { g, iw, ih } = frame(d3, node, w, 170, { t: 10, r: 8, b: 22, l: 28 }, 'Število pogodb po času do prve objavljene spremembe');
  const labels = bins.map((b) => (b.b === Infinity ? `${b.a}+` : `${b.a}–${b.b}`));
  const x = d3.scaleBand().domain(labels).range([0, iw]).paddingInner(0.22).paddingOuter(0.05);
  const y = d3.scaleLinear().domain([0, Math.max(1, ...bins.map((b) => b.n))]).nice().range([ih, 0]);
  yGrid(d3, g, y, iw, num.format, 3);
  const bw = Math.min(40, x.bandwidth());
  bins.forEach((b, i) => {
    const key = b.n ? reg('c', { kicker: K.speed, title: `Prva sprememba ${labels[i]} mesecev po pogodbi`, sig: `speed:${i}`, items: () => speedItems((v) => v >= b.a && v < b.b) }) : null;
    hit(g, x(labels[i]) - (x.step() - x.bandwidth()) / 2, 0, x.step(), ih, `${labels[i]} mesecev: ${pogodb(b.n)}`, key);
    g.append('path').attr('class', `fx-bar${b.a < 12 ? ' hl' : ''}`).attr('d', barPath(x(labels[i]) + (x.bandwidth() - bw) / 2, y(b.n), bw, ih - y(b.n)));
  });
  xAxis(d3, g, ih, d3.axisBottom(x));
  g.append('text').attr('class', 'lbl').attr('x', iw).attr('y', ih + 20).attr('text-anchor', 'end').text('mesecev');
}

// --- 11. pragovi ------------------------------------------------------------------------------

const THRESHOLD_SHORT = (t) => (t >= 1e6 ? `${dec(t / 1e6)} mio` : `${num.format(t / 1e3)} tisoč`);
const DECADE = { 3: '1 tis.', 4: '10 tis.', 5: '100 tis.', 6: '1 mio', 7: '10 mio', 8: '100 mio', 9: '1 mrd' };
const valueItems = (pred, note) => (S.F.values || []).filter(([, v]) => pred(v)).map(([id, v]) => ({ id, amt: v, note: note ? note(v) : `vrednost ob oddaji ${moneyFull(v)}` }));

function thresholdsBody(F) {
  const V = (F.values || []).filter(([, v]) => v > 0);
  if (!V.length) return empty('Ni vrednosti pogodb.');
  const th = F.thresholds || [];
  const rows = th.map((t) => {
    const bunch = t.below >= 5 && t.below > 1.5 * t.above;
    const pctOf = (v) => `${signedPct(v / t.t - 1)} od praga`;
    const below = drillBtn({ kicker: K.thresholds, title: `10 % pod pragom ${t.name} (${moneyFull(t.t)})`, items: () => valueItems((v) => v >= 0.9 * t.t && v < t.t, pctOf) }, `<b>${num.format(t.below)}</b>`);
    const above = drillBtn({ kicker: K.thresholds, title: `10 % nad pragom ${t.name} (${moneyFull(t.t)})`, items: () => valueItems((v) => v >= t.t && v < 1.1 * t.t, pctOf) }, `<b>${num.format(t.above)}</b>`);
    return `<span class="${bunch ? 'warn' : ''}">${esc(t.name)} (${money(t.t)}): 10 % pod pragom ${below} · 10 % nad ${above}${bunch ? ' <span class="v-tag warn">več tik pod pragom</span>' : ''}</span>`;
  }).join('');
  const splits = F.flags?.splits;
  return `${chart('thresholds')}
    <div class="fx-legend"><span><i class="band"></i>±10 % okoli praga</span><span><i class="line"></i>zakonski prag</span></div>
    <div class="fx-stats" style="flex-direction:column;gap:3px">${rows}
      ${isNum(splits) ? `<span>sočasna ločena naročila za isto delo na istem mestu: ${splits ? drillBtn({ kicker: K.thresholds, title: 'Sočasna ločena naročila', pairs: splitPairs, order: 'd' }, `<b>${num.format(splits)}</b>`) : '<b>0</b>'}</span>` : ''}
    </div>`;
}

function drawThresholds(node, w, d3, F) {
  const V = (F.values || []).map(([, v]) => v).filter((v) => v > 0);
  const L = V.map((v) => Math.log10(v));
  const lo = Math.floor(Math.min(...L) * 2) / 2;
  const hi = Math.max(lo + 0.5, Math.ceil(Math.max(...L) * 2) / 2);
  const m = { t: 30, r: 10, b: 24, l: 30 };
  // razredi po 0,05 dekade, če je stolpec širok vsaj 6 px, sicer po 0,1
  const per = (w - m.l - m.r) / ((hi - lo) * 20) >= 6 ? 20 : 10;
  const nb = Math.round((hi - lo) * per);
  const bins = d3.range(nb).map((i) => ({ a: lo + i / per, b: lo + (i + 1) / per, n: 0 }));
  const binOf = (l) => Math.min(nb - 1, Math.max(0, Math.floor((l - lo) * per + 1e-9)));
  for (const l of L) bins[binOf(l)].n += 1;
  const { g, iw, ih } = frame(d3, node, w, 210, m,
    `Porazdelitev vrednosti ${pogodb(V.length)} na logaritemski lestvici s pragovi ${(F.thresholds || []).map((t) => money(t.t)).join(', ')}`);
  const x = d3.scaleLinear().domain([lo, hi]).range([0, iw]);
  const y = d3.scaleLinear().domain([0, Math.max(1, ...bins.map((b) => b.n))]).nice().range([ih, 0]);
  yGrid(d3, g, y, iw, num.format, 4);
  for (const t of F.thresholds || []) {
    const a = Math.log10(t.t * 0.9);
    const b = Math.log10(t.t * 1.1);
    if (b < lo || a > hi) continue;
    g.append('rect').attr('class', 'fx-band').attr('x', x(a)).attr('width', x(b) - x(a)).attr('y', 0).attr('height', ih);
  }
  bins.forEach((b, i) => {
    const key = b.n ? reg('c', { kicker: K.thresholds, title: `Vrednost ${money(10 ** b.a)} do ${money(10 ** b.b)}`, sig: `thr:${per}:${i}`, items: () => valueItems((v) => binOf(Math.log10(v)) === i) }) : null;
    hit(g, x(b.a), 0, x(b.b) - x(b.a), ih, `${money(10 ** b.a)} do ${money(10 ** b.b)}: ${pogodb(b.n)}`, key);
    const bw = Math.max(1, Math.min(24, x(b.b) - x(b.a) - 2));
    g.append('path').attr('class', 'fx-bar').attr('d', barPath((x(b.a) + x(b.b)) / 2 - bw / 2, y(b.n), bw, ih - y(b.n), 2));
  });
  for (const t of F.thresholds || []) {
    const l = Math.log10(t.t);
    if (l < lo || l > hi) continue;
    g.append('line').attr('class', 'fx-ref').attr('x1', x(l)).attr('x2', x(l)).attr('y1', -14).attr('y2', ih)
      .append('title').text(`${t.name}: ${money(t.t)}; 10 % pod pragom ${t.below}, 10 % nad ${t.above}`);
    g.append('text').attr('class', 'ref').attr('x', x(l)).attr('y', -18).attr('text-anchor', 'middle').text(THRESHOLD_SHORT(t.t));
  }
  const decades = d3.range(Math.ceil(lo), Math.floor(hi) + 1);
  xAxis(d3, g, ih, d3.axisBottom(x).tickValues(decades).tickFormat((e) => DECADE[e] || `10^${e}`));
}

// --- 12. zaporedna naročila ------------------------------------------------------------------

function serialBody(G) {
  if (!G?.length) return '<div class="fx-stats"><span>Ni najdenih primerov.</span></div>';
  return `<ul class="fx-serial">${G.map((g) => {
    const spec = {
      kicker: K.serial, title: `${g.firm}: ${pogodb(g.ids.length)} v ${num.format(g.days)} dneh`,
      sub: `vsaka pod pragom ${g.name} (${moneyFull(g.t)}), skupaj ${moneyFull(g.sum)}`,
      items: g.ids.map((id) => ({ id, note: `pod pragom ${g.name}` })), order: 'd', firm: g.firm,
    };
    return `<li>${drillBtn(spec, `<b>${esc(g.firm)}</b><span>${pogodb(g.ids.length)} v ${num.format(g.days)} ${plural(g.days, ['dnevu', 'dneh', 'dneh', 'dneh'])} · skupaj ${esc(money(g.sum))}</span><small>vsaka pod pragom ${esc(g.name)} (${esc(money(g.t))})</small>`, 'fx-serial-row')}</li>`;
  }).join('')}</ul>`;
}

// --- 13. mesec podpisa -------------------------------------------------------------------------

function monthsBody(M) {
  const rows = Object.entries(M || {}).map(([m, r]) => ({ m: Number(m), n: r[0], v: r[1], ids: r[2] || [] })).sort((a, b) => a.m - b.m);
  const n = rows.reduce((s, d) => s + d.n, 0);
  if (!n) return empty('Ni datumov pogodb.');
  const dec12 = rows.find((d) => d.m === 12);
  return `${chart('months')}
    <div class="fx-stats">
      <span>december: ${drillBtn({ kicker: K.months, title: 'Pogodbe, sklenjene decembra', items: () => (dec12?.ids || []).map((id) => ({ id })) }, `<b>${pct((dec12?.n || 0) / n, 1)}</b>`)} pogodb (enakomerno bi bilo 8,3 %)</span>
    </div>`;
}

function drawMonths(node, w, d3, M) {
  const rows = Object.entries(M || {}).map(([m, r]) => ({ m: Number(m), n: r[0], v: r[1], ids: r[2] || [] })).sort((a, b) => a.m - b.m);
  const n = rows.reduce((s, d) => s + d.n, 0);
  const { g, iw, ih } = frame(d3, node, w, 170, { t: 10, r: 40, b: 22, l: 28 }, 'Število pogodb po mesecu sklenitve');
  const x = d3.scaleBand().domain(rows.map((d) => d.m)).range([0, iw]).paddingInner(0.22).paddingOuter(0.05);
  const y = d3.scaleLinear().domain([0, Math.max(1, ...rows.map((d) => d.n))]).nice().range([ih, 0]);
  yGrid(d3, g, y, iw, num.format, 3);
  const bw = Math.min(28, x.bandwidth());
  for (const d of rows) {
    const key = d.n ? reg('c', { kicker: K.months, title: `Pogodbe, sklenjene v mesecu ${MONTHS[d.m - 1]}`, sig: `month:${d.m}`, items: () => d.ids.map((id) => ({ id })) }) : null;
    hit(g, x(d.m) - (x.step() - x.bandwidth()) / 2, 0, x.step(), ih, `${MONTHS[d.m - 1]}: ${pogodb(d.n)}, ${money(d.v)}`, key);
    g.append('path').attr('class', `fx-bar${d.m === 12 ? ' hl' : ''}`).attr('d', barPath(x(d.m) + (x.bandwidth() - bw) / 2, y(d.n), bw, ih - y(d.n)));
  }
  const even = n / 12;
  g.append('line').attr('class', 'fx-ref-soft').attr('x1', 0).attr('x2', iw).attr('y1', y(even)).attr('y2', y(even));
  g.append('text').attr('class', 'lbl').attr('x', iw + 4).attr('y', y(even) + 3).text('enakom.');
  xAxis(d3, g, ih, d3.axisBottom(x).tickFormat((m) => MONTHS[m - 1].slice(0, 3)));
}

// --- 14. HHI --------------------------------------------------------------------------------

const hhiZone = (v) => (v > 2500 ? 'visoko koncentriran' : v >= 1500 ? 'zmerno koncentriran' : 'nekoncentriran');

function hhiRows(hhi) {
  return Object.entries(hhi || {}).map(([y, v]) => ({ y: Number(y), v })).filter((d) => Number.isFinite(d.y) && isNum(d.v))
    .sort((a, b) => a.y - b.y);
}

function hhiSpec(year, v) {
  const top = S.F.hhi_top?.[year] || [];
  return {
    kicker: K.hhi, title: `Izvajalci v letu ${year}`, sub: `HHI ${num.format(v)}, ${hhiZone(v)}`, sig: `hhi:${year}`,
    html: () => (top.length ? `<table class="fx-shares"><tbody>${top.map(([name, share]) => `<tr>
        <th><button type="button" class="v-link" data-firm="${esc(name)}" title="Filtriraj zemljevid po izvajalcu">${esc(name)}</button></th>
        <td><span class="bar" style="width:${Math.round(share * 100)}%"></span></td><td class="num">${pct(share, 1)}</td></tr>`).join('')}</tbody></table>` : ''),
    items: () => works().filter((p) => p.y === year && p.v).map((p) => ({ id: p.i })),
  };
}

function hhiBody(hhi) {
  const rows = hhiRows(hhi);
  if (!rows.length) return empty('Ni podatkov o koncentraciji.');
  const last = rows.at(-1);
  const high = rows.filter((d) => d.v > 2500).length;
  const recent = rows.slice(-5);
  const avg = recent.reduce((a, d) => a + d.v, 0) / recent.length;
  return `${chart('hhi')}
    <div class="fx-stats">
      <span>${last.y}: ${drillBtn(hhiSpec(last.y, last.v), `<b>${num.format(last.v)}</b>`)} (${hhiZone(last.v)})</span>
      <span>povprečje zadnjih ${recent.length} let: <b>${num.format(avg)}</b></span>
      <span>visoko koncentriranih let: <b>${num.format(high)}</b> od ${num.format(rows.length)}</span>
    </div>`;
}

function drawHhi(node, w, d3, hhi) {
  const rows = hhiRows(hhi);
  const byYear = new Map(rows.map((d) => [d.y, d.v]));
  const years = d3.range(rows[0].y, rows.at(-1).y + 1);
  const { g, iw, ih } = frame(d3, node, w, 200, { t: 8, r: 52, b: 22, l: 40 },
    `Indeks HHI po letih od ${years[0]} do ${years.at(-1)}`);
  const x = d3.scalePoint().domain(years).range([0, iw]).padding(0.4);
  const top = Math.min(10000, Math.max(4000, Math.ceil((d3.max(rows, (d) => d.v) + 300) / 1000) * 1000));
  const y = d3.scaleLinear().domain([0, top]).range([ih, 0]);
  g.append('rect').attr('class', 'fx-zone').attr('fill-opacity', 0.07).attr('x', 0).attr('width', iw).attr('y', y(top)).attr('height', y(2500) - y(top));
  g.append('rect').attr('class', 'fx-zone').attr('fill-opacity', 0.035).attr('x', 0).attr('width', iw).attr('y', y(2500)).attr('height', y(1500) - y(2500));
  const ticks = [0, 1500, 2500, ...d3.range(5000, top + 1, 2500)];
  yGrid(d3, g, y, iw, num.format, null, ticks);
  const zl = (a, b, t) => g.append('text').attr('class', 'lbl').attr('x', iw + 6).attr('y', (y(a) + y(b)) / 2 + 3).text(t);
  zl(top, 2500, 'visoka');
  zl(2500, 1500, 'zmerna');
  zl(1500, 0, 'nizka');
  const line = d3.line().defined((yr) => byYear.has(yr)).x((yr) => x(yr)).y((yr) => y(byYear.get(yr)));
  g.append('path').attr('class', 'fx-line').attr('d', line(years));
  for (const d of rows) {
    const key = reg('c', hhiSpec(d.y, d.v));
    const c = g.append('circle').attr('class', 'fx-dot-hit').attr('cx', x(d.y)).attr('cy', y(d.v)).attr('r', 10)
      .attr('data-drill', key).attr('tabindex', 0).attr('role', 'button').attr('aria-label', `${d.y}: HHI ${num.format(d.v)}`);
    if (S.sig === `hhi:${d.y}`) c.classed('is-sel', true);
    c.append('title').text(`${d.y}: HHI ${num.format(d.v)}, ${hhiZone(d.v)} · klik za izvajalce in pogodbe`);
    g.append('circle').attr('class', 'fx-dot').attr('cx', x(d.y)).attr('cy', y(d.v)).attr('r', 3.5);
  }
  xAxis(d3, g, ih, d3.axisBottom(x).tickValues(thin(years, x.step())).tickFormat(yearFmt(x.step())));
}

// --- 15. delitev trga po cestah ----------------------------------------------------------------

function roadIds(road) {
  return works().filter((p) => p.v && (p.lr?.length ? p.lr.some(([r]) => r === road) : (p.r || []).includes(road))).map((p) => p.i);
}

function marketBody(M) {
  if (!M?.rows?.length) return empty('Ni podatkov o cestah in izvajalcih.');
  const shade = (s) => (s >= 0.5 ? 6 : s >= 0.35 ? 5 : s >= 0.2 ? 4 : s >= 0.1 ? 3 : s >= 0.05 ? 2 : 1);
  const head = M.firms.map((f) => `<th scope="col" title="${esc(f)}"><span>${esc(f)}</span></th>`).join('');
  const body = M.rows.map((r) => {
    const rowSpec = { kicker: K.market, title: `Pogodbe na cesti ${r.road}`, sub: `vodilni izvajalec ${r.lead} z ${pct(r.lead_share)} vrednosti · HHI ${num.format(r.hhi)}`, items: () => roadIds(r.road).map((id) => ({ id })) };
    const tds = r.cells.map(([s, ids], j) => (s > 0
      ? `<td class="h${shade(s)}" data-drill="${reg('h', { kicker: K.market, title: `${M.firms[j]} na cesti ${r.road}`, sub: `${pct(s, 1)} vrednosti gradenj na cesti`, items: ids.map((id) => ({ id })), firm: M.firms[j] })}" tabindex="0" role="button" title="${esc(M.firms[j])} na ${r.road}: ${pct(s, 1)} vrednosti, ${pogodb(ids.length)}">${s >= 0.005 ? num.format(s * 100) : '·'}</td>`
      : `<td class="z" title="${esc(M.firms[j])} na ${r.road}: brez pogodb"></td>`)).join('');
    return `<tr><th scope="row">${drillBtn(rowSpec, `${r.road} <small>${pogodb(r.n)}</small>`, 'v-link')}</th>${tds}
      <td class="lead${r.lead_share >= 0.5 ? ' warn' : ''}">${esc(r.lead)} <b>${pct(r.lead_share)}</b></td></tr>`;
  }).join('');
  return `<div class="fx-scroll"><table class="fx-heat fx-market">
      <caption class="v-sr">Delež izvajalcev v vrednosti gradenj po cestah, v odstotkih</caption>
      <thead><tr><th scope="col"><span class="v-sr">Cesta</span></th>${head}<th scope="col" class="lead">vodilni</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="fx-legend"><span>delež vrednosti na cesti: manj <span class="fx-ramp">${[1, 2, 3, 4, 5, 6].map((i) => `<i style="background:var(--seq-${i})"></i>`).join('')}</span> več (temno: nad 50 %)</span></div>`;
}

// --- 16. rotacija -----------------------------------------------------------------------------

function rotationBody(R, values) {
  if (!R?.firms?.length || !R?.years?.length || !R?.cells?.length) return empty('Ni podatkov o zmagovalcih po letih.');
  const vals = [];
  let total = 0;
  for (const row of R.cells) for (const c of row || []) if (c?.[0] > 0) { vals.push(c[1] || 0); total += c[1] || 0; }
  const sorted = vals.slice().sort((a, b) => a - b);
  const qs = [1, 2, 3, 4, 5].map((i) => sorted[Math.floor((i * sorted.length) / 6)] ?? Infinity);
  const shade = (v) => 1 + qs.filter((t) => v >= t && t > 0).length;
  const all = (values || []).reduce((a, v) => a + ((Array.isArray(v) ? v[1] : v) || 0), 0);
  const head = R.years.map((y) => `<th scope="col" title="${y}">${String(y).slice(2)}</th>`).join('');
  const body = R.firms.map((f, j) => {
    let n = 0;
    const allIds = [];
    const tds = R.years.map((y, i) => {
      const c = R.cells[i]?.[j] || [0, 0, []];
      n += c[0] || 0;
      allIds.push(...(c[2] || []));
      if (!(c[0] > 0)) return `<td class="z" title="${esc(f)}, ${y}: brez pogodbe"></td>`;
      const key = reg('h', { kicker: K.rotation, title: `${f} v letu ${y}`, sub: `${pogodb(c[0])}, delež vrednosti ${money(c[1])}`, items: (c[2] || []).map((id) => ({ id })), firm: f });
      return `<td class="h${shade(c[1] || 0)}" data-drill="${key}" tabindex="0" role="button" title="${esc(f)}, ${y}: ${pogodb(c[0])}, ${esc(money(c[1]))}">${c[0]}</td>`;
    }).join('');
    const firmSpec = { kicker: K.rotation, title: `Vse pogodbe izvajalca ${f}`, items: [...new Set(allIds)].map((id) => ({ id })), firm: f, order: 'd' };
    return `<tr><th scope="row">${drillBtn(firmSpec, esc(f), 'v-link')}</th>${tds}<td class="tot">${n}</td></tr>`;
  }).join('');
  return `<div class="fx-scroll"><table class="fx-heat">
      <caption class="v-sr">Število pogodb in vrednost po letih za ${R.firms.length} največjih izvajalcev</caption>
      <thead><tr><th scope="col"><span class="v-sr">Izvajalec</span></th>${head}<th scope="col" title="Skupaj pogodb">Σ</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <div class="fx-legend">
      <span>vrednost v letu: manj <span class="fx-ramp">${[1, 2, 3, 4, 5, 6].map((i) => `<i style="background:var(--seq-${i})"></i>`).join('')}</span> več</span>
      <span>številka: število pogodb</span>
      ${all ? `<span>${R.firms.length} izvajalcev skupaj: <b class="v-mono">${pct(total / all)}</b> vrednosti vseh pogodb</span>` : ''}
    </div>`;
}

// --- 17. tabela izvajalcev ---------------------------------------------------------------------

const COLS = [
  { key: 'n', label: 'Izvajalec', val: (f) => (f.n || '').toLowerCase() },
  { key: 'c', label: 'Pogodbe', num: true, val: (f) => f.c || 0 },
  { key: 'v', label: 'Vrednost', num: true, val: (f) => f.v || 0 },
  { key: 'single', label: 'Ena ponudba', num: true, title: 'pogodbe z eno ponudbo / pogodbe z znanim številom ponudb', val: (f) => (f.bids ? f.single / f.bids : -1) },
  { key: 'ratio', label: 'Razmerje do ocene', num: true, title: 'mediana razmerja med pogodbeno in ocenjeno vrednostjo', val: (f) => (isNum(f.ratio) ? f.ratio : -1) },
  { key: 'growth', label: 'Rast z aneksi', num: true, title: 'mediana rasti vrednosti po aneksih', val: (f) => (isNum(f.growth) ? f.growth : -Infinity) },
  { key: 'redone', label: 'Ponovljeno v garanciji', num: true, title: 'kolikokrat je bilo njihovo delo ponovljeno med garancijsko dobo (v oklepaju: od tega oni sami)', val: (f) => (f.redone || 0) * 1000 + (f.own || 0) },
  { key: 'flags', label: 'Zastavice', val: (f) => (f.flags || []).length * 1e13 + (f.v || 0) },
];

// Seznami pogodb izvajalca po kazalniku (iz id-jev v tabeli in podatkov pogodb).
function firmItems(f, kind) {
  const ps = (f.ids || []).map(P).filter(Boolean);
  if (kind === 'single') return ps.filter((p) => p.b === 1).map((p) => ({ id: p.i, note: 'ena ponudba' }));
  if (kind === 'bids') return ps.filter((p) => p.b).map((p) => ({ id: p.i, note: `ponudb ${p.b}` }));
  if (kind === 'ratio') return ps.filter((p) => p.v && p.e).map((p) => ({ id: p.i, sort: p.v / p.e, note: `razmerje ${num3.format(p.v / p.e)} · ocena ${money(p.e)}` }));
  if (kind === 'growth') return ps.filter((p) => p.v && p.vf && p.vf !== p.v).map((p) => ({ id: p.i, sort: p.vf / p.v, note: `${signedPct(p.vf / p.v - 1)}: ${money(p.v)} → ${money(p.vf)}` }));
  return ps.map((p) => ({ id: p.i }));
}
const pairItems = (list, flags) => (list || []).map(([a, b]) => {
  const row = (S.api?.pairs?.() || []).find((r) => r[0] === a && r[1] === b);
  return { a, b, flags: row?.[6] || flags, note: row ? `${yearsTxt(row[2])} narazen${row[5] ? ` · garancija prejšnjega ${yearsTxt(row[5])}` : ''}` : '' };
});
const splitItems = (list) => (list || []).map(([a, b]) => {
  const row = (S.api?.splits?.() || []).find((r) => r[0] === a && r[1] === b);
  return { a, b, flags: '', note: row ? `${num.format(row[2])} dni narazen` : 'sočasno ločeno naročilo' };
});

function firmSpec(f, kind) {
  const base = { kicker: K.firms, firm: f.n };
  switch (kind) {
    case 'single': return { ...base, title: `${f.n}: pogodbe z eno ponudbo`, sub: `${num.format(f.single || 0)} od ${pogodb(f.bids || 0)} z znanim številom ponudb`, items: () => firmItems(f, 'single') };
    case 'ratio': return { ...base, title: `${f.n}: razmerje do ocenjene vrednosti`, sub: `mediana ${isNum(f.ratio) ? num3.format(f.ratio) : '–'}`, items: () => firmItems(f, 'ratio') };
    case 'growth': return { ...base, title: `${f.n}: rast vrednosti z aneksi`, sub: `mediana ${signedPct(f.growth)}`, items: () => firmItems(f, 'growth') };
    case 'redone': return { ...base, title: `${f.n}: delo ponovljeno v garancijski dobi`, pairs: () => pairItems(f.pg, 'g') };
    case 'own': return { ...base, title: `${f.n}: svoje delo znova v garancijski dobi`, pairs: () => pairItems(f.pi, 'gi') };
    case 'split': return { ...base, title: `${f.n}: sočasna ločena naročila`, pairs: () => splitItems(f.ps), order: 'd' };
    default: return { ...base, title: `Vse pogodbe izvajalca ${f.n}`, sub: `${pogodb(f.c || 0)} gradenj`, items: () => firmItems(f, 'all') };
  }
}
const FLAG_KIND = { 'ena ponudba': 'single', 'tik ob oceni': 'ratio', aneksi: 'growth', 'ponovljeno v garanciji': 'redone', 'svoje delo v garanciji': 'own', 'razdrobljena naročila': 'split' };

function renderTable() {
  const table = S.el.querySelector('.fx-table');
  if (!table) return;
  clearNs('t');
  const rows = (S.F.firms || []).slice();
  const col = COLS.find((c) => c.key === S.sort.key) || COLS.at(-1);
  rows.sort((a, b) => {
    const x = col.val(a);
    const y = col.val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * S.sort.dir || (b.v || 0) - (a.v || 0);
  });
  const shown = S.all ? rows : rows.slice(0, ROWS);
  const head = COLS.map((c) => {
    const on = c.key === col.key;
    const aria = on ? ` aria-sort="${S.sort.dir > 0 ? 'ascending' : 'descending'}"` : '';
    return `<th scope="col" class="${c.num ? 'num' : ''}"${aria}${c.title ? ` title="${esc(c.title)}"` : ''}><button type="button" data-sort="${c.key}">${c.label}<span class="arr" aria-hidden="true">${on && S.sort.dir > 0 ? '▲' : '▼'}</span></button></th>`;
  }).join('');
  const cell = (f, kind, text, ok = true) => (ok ? `<button type="button" class="fx-cell" data-drill="${reg('t', firmSpec(f, kind))}">${text}</button>` : text);
  const body = shown.map((f) => {
    const singleWarn = f.bids >= 3 && f.single / f.bids >= 0.4;
    const ratioWarn = isNum(f.ratio) && f.ratio >= 0.97 && f.ratio <= 1.03;
    const growthWarn = isNum(f.growth) && f.growth > 0.15;
    const redone = !S.hasReg && !f.redone ? '–' : `${num.format(f.redone || 0)}${f.own ? ` (${num.format(f.own)})` : ''}`;
    return `<tr>
      <th scope="row"><button type="button" class="v-link" data-drill="${reg('t', firmSpec(f, 'all'))}" title="Vse pogodbe izvajalca">${esc(f.n)}</button>${f.y ? `<small>${f.y[0]}${f.y[1] !== f.y[0] ? `–${f.y[1]}` : ''}</small>` : ''}</th>
      <td class="num">${cell(f, 'all', num.format(f.c || 0), !!f.ids?.length)}</td>
      <td class="num">${cell(f, 'all', esc(money(f.v)), !!f.ids?.length)}</td>
      <td class="num${singleWarn ? ' warn' : ''}">${f.bids ? cell(f, 'single', `${num.format(f.single || 0)}/${num.format(f.bids)}`, !!f.single) : '–'}</td>
      <td class="num${ratioWarn ? ' warn' : ''}">${isNum(f.ratio) ? cell(f, 'ratio', num3.format(f.ratio)) : '–'}</td>
      <td class="num${growthWarn ? ' warn' : ''}">${isNum(f.growth) ? cell(f, 'growth', signedPct(f.growth)) : '–'}</td>
      <td class="num${f.redone ? ' warn' : ''}">${f.redone ? cell(f, 'redone', redone) : redone}</td>
      <td><span class="v-tags">${(f.flags || []).map((x) => (FLAG_KIND[x] ? `<button type="button" class="v-tag warn" data-drill="${reg('t', firmSpec(f, FLAG_KIND[x]))}">${esc(x)}</button>` : `<span class="v-tag warn">${esc(x)}</span>`)).join('') || '<span class="v-empty">–</span>'}</span></td>
    </tr>`;
  }).join('');
  table.innerHTML = `<caption class="v-sr">Kazalniki po izvajalcih, razvrščeno po stolpcu ${esc(col.label)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  const flagged = rows.filter((f) => f.flags?.length).length;
  S.el.querySelector('.fx-table-foot').innerHTML = `<span>${num.format(rows.length)} izvajalcev, od tega ${num.format(flagged)} z vsaj eno zastavico</span>
    ${rows.length > ROWS ? `<button type="button" class="v-btn" data-all>${S.all ? 'Prikaži manj' : `Prikaži vse (${num.format(rows.length)})`}</button>` : ''}`;
  markSel();
}

// --- risanje ---------------------------------------------------------------------------------

const CHARTS = {
  'benford-award': (n, w, d3) => drawBenford(n, w, d3, S.F.benford.award, 'award'),
  'benford-annex': (n, w, d3) => drawBenford(n, w, d3, S.F.benford.annex, 'annex'),
  ratios: (n, w, d3) => drawRatios(n, w, d3, S.F.ratios),
  comp: (n, w, d3) => drawComp(n, w, d3, S.F.ratios),
  single: (n, w, d3) => drawSingle(n, w, d3, S.F.single),
  unit: (n, w, d3) => drawUnit(n, w, d3, S.F.unit_cost),
  hhi: (n, w, d3) => drawHhi(n, w, d3, S.F.hhi),
  direct: (n, w, d3) => drawDirect(n, w, d3, S.F.direct),
  speed: (n, w, d3) => drawSpeed(n, w, d3, S.F.annex_speed),
  months: (n, w, d3) => drawMonths(n, w, d3, S.F.months),
  growth: (n, w, d3) => drawGrowth(n, w, d3, S.F.growth, `Histogram rasti vrednosti z aneksi za ${pogodb(S.F.growth.length)}, razredi po 5 odstotnih točk`, false),
  'reg-growth': (n, w, d3) => drawGrowth(n, w, d3, S.F.reg_growth, `Histogram dodatkov iz registra pogodb za ${pogodb(S.F.reg_growth.length)}`, true),
  thresholds: (n, w, d3) => drawThresholds(n, w, d3, S.F),
};

function drawCharts() {
  if (!S) return;
  const d3 = window.d3;
  clearNs('c');
  for (const node of S.el.querySelectorAll('[data-chart]')) {
    if (!d3) { node.innerHTML = empty('Knjižnica d3 ni naložena.'); continue; }
    const w = Math.max(240, Math.floor(node.clientWidth || 520));
    try {
      CHARTS[node.dataset.chart]?.(node, w, d3);
    } catch (error) {
      console.error(error);
      node.innerHTML = empty(`Grafa ni bilo mogoče narisati (${error.message}).`);
    }
  }
  markSel();
}

function frame(d3, node, w, h, m, label) {
  node.textContent = '';
  const svg = d3.select(node).append('svg')
    .attr('class', 'fx-svg').attr('width', w).attr('height', h).attr('viewBox', `0 0 ${w} ${h}`)
    .attr('role', 'group').attr('aria-label', label);
  const g = svg.append('g').attr('transform', `translate(${m.l},${m.t})`);
  return { svg, g, iw: Math.max(10, w - m.l - m.r), ih: h - m.t - m.b };
}

function yGrid(d3, g, y, iw, fmt, count = 4, values = null) {
  const axis = d3.axisLeft(y).tickSize(-iw).tickPadding(6).tickFormat(fmt);
  if (values) axis.tickValues(values); else axis.ticks(count);
  g.append('g').attr('class', 'fx-axis').call(axis);
}

function xAxis(d3, g, ih, axis) {
  g.append('g').attr('class', 'fx-axis fx-xaxis').attr('transform', `translate(0,${ih})`)
    .call(axis.tickSizeInner(3).tickSizeOuter(0).tickPadding(5));
}

// Prozoren pravokotnik z opisom: večja tarča za miško kot sam stolpec; s ključem odpre seznam pogodb.
function hit(g, x, y, w, h, title, key = null) {
  const r = g.append('rect').attr('class', `fx-hit${key ? ' go' : ''}`).attr('x', x).attr('y', y).attr('width', Math.max(1, w)).attr('height', Math.max(0, h));
  if (key) r.attr('data-drill', key).attr('tabindex', 0).attr('role', 'button').attr('aria-label', `${title}; pokaži pogodbe`);
  r.append('title').text(key ? `${title} · klik za seznam pogodb` : title);
}

// Stolpec z zaobljenim vrhom in ravnim dnom.
function barPath(x, y, w, h, r = 4) {
  if (!(h > 0) || !(w > 0)) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + h}Z`;
}

// Redčenje oznak let, da se ne prekrivajo.
function thin(values, step) {
  const every = Math.max(1, Math.ceil((step >= 30 ? 34 : 22) / step));
  return values.filter((_, i) => i % every === 0);
}
const yearFmt = (step) => (y) => (step >= 30 ? String(y) : `’${String(y).slice(2)}`);
