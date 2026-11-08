// Forenzika: rdeče zastavice nad pogodbami DARS kot infografike (d3 je naložen globalno, window.d3).
// Vir podatkov: data/forenzika.json → forensics (pipeline/forensics.py).

const num = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat('sl-SI', { maximumFractionDigits: 1 });
const num3 = new Intl.NumberFormat('sl-SI', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const NO_REG = 'Podatki iz registra pogodb še niso na voljo.';
const VERDICT = {
  tesna: 'tesna skladnost', sprejemljiva: 'sprejemljiva skladnost', mejna: 'mejna skladnost', neskladnost: 'neskladnost',
};
const ROWS = 25; // vrstic tabele izvajalcev pred »Prikaži vse«

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
const dec = (v, d = 1) => new Intl.NumberFormat('sl-SI', { maximumFractionDigits: d }).format(v);

let S = null; // stanje pogleda

function money(v) {
  if (S?.api?.money) return S.api.money(v);
  return v == null ? '–' : `${num.format(v)} €`;
}

// --- vstop -------------------------------------------------------------------------------

export function render(el, data, api) {
  if (S) teardown();
  const F = data?.forensics || {};
  S = {
    el, F, api,
    hasReg: (F.reg_growth?.length > 0) || (F.firms || []).some((f) => f.subs > 0) || (F.flags?.count?.g > 0),
    sort: { key: 'flags', dir: -1 }, all: false, gridW: 0, raf: 0,
  };
  el.classList.add('view-forensics');
  el.innerHTML = layout(F);
  S.onClick = onClick;
  el.addEventListener('click', S.onClick);
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
}

function teardown() {
  S.ro?.disconnect();
  cancelAnimationFrame(S.raf);
  S.el.removeEventListener('click', S.onClick);
  S = null;
}

function onClick(e) {
  const t = e.target.closest('[data-firm],[data-open],[data-sort],[data-all]');
  if (!t || !S) return;
  if (t.dataset.firm != null) S.api?.filterFirm?.(t.dataset.firm);
  else if (t.dataset.open) S.api?.openProject?.(Number(t.dataset.open));
  else if (t.dataset.sort) {
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

function layout(F) {
  const nVals = (F.values || []).length;
  return `<div class="fx">
    <header class="fx-head">
      <h2>Forenzični kazalniki</h2>
      <p class="fx-intro">Statistični vzorci v javnih naročilih DARS za gradnje na avtocestah in hitrih cestah: razmerje med pogodbeno in ocenjeno vrednostjo, delež postopkov z eno ponudbo, koncentracija trga, menjavanje zmagovalcev, rast vrednosti z aneksi in kopičenje vrednosti tik pod zakonskimi pragovi. Izbor sledi OECD smernicam za boj proti dogovarjanju ponudnikov in kazalnikom tveganja Opentender/DIGIWHIST.</p>
      <div class="fx-disclaimer" role="note">
        <p><b>Kazalniki so rdeče zastavice za podrobnejši pregled, kot jih uporabljajo revizorji javnih naročil. Noben sam po sebi ne dokazuje nepravilnosti.</b></p>
        <p>Vsak ima lahko upravičeno razlago, ki jo je treba preveriti v razpisni dokumentaciji, pogodbi in pri naročniku.${S.hasReg ? '' : ' Register pogodb (garancijski roki, podizvajalci, dodatki k pogodbam) še ni vključen, zato so nekateri kazalniki nepopolni.'}</p>
      </div>
      <p class="fx-sources">Viri metod: OECD, Smernice za boj proti dogovarjanju ponudnikov pri javnem naročanju; <a href="https://opentender.eu/" target="_blank" rel="noopener">Opentender.eu</a> (DIGIWHIST), kazalniki tveganja javnih naročil; M. Nigrini, meje MAD za Benfordov zakon. Podatki: portal javnih naročil${nVals ? `, ${pogodb(nVals)} z znano vrednostjo` : ''}.</p>
    </header>
    <div class="fx-grid">
      ${card({
        id: 'flags', n: 1, span: true, title: 'Ponovitve na istem mestu',
        lead: 'Pari pogodb, katerih umeščena dela se prekrivajo, po vrsti nekonsistentnosti',
        body: kpis(F.flags),
        cap: 'Številka je število parov pogodb, znesek pa vsota vrednosti kasnejših pogodb v teh parih. Ista pogodba je lahko v več parih, zato se zneski med karticami prekrivajo in jih ni mogoče seštevati. Garancijski roki niso v objavah, ampak v pogodbah, zato sta prva dva kazalnika odvisna od registra pogodb. Ponovitev ima lahko upravičen razlog: druga smer, druga plast vozišča, nepredvidena škoda.',
      })}
      ${card({
        id: 'benford', n: 2, title: 'Benfordov zakon', lead: 'Porazdelitev prve števke zneskov, opaženo in pričakovano',
        body: benfordBody(F.benford),
        cap: 'V naravno nastalih zneskih je prva števka 1 v približno 30 % primerov, 9 pa le v 5 %. Večje odstopanje (MAD po Nigriniju) lahko kaže na prirejene ali izmišljene zneske. Pogodbene vrednosti se ravnajo po ocenjenih vrednostih in proračunih, zato odstopajo tudi brez manipulacije; pri nekaj sto zneskih je test zelo grob.',
      })}
      ${card({
        id: 'ratios', n: 3, title: 'Pogodbena in ocenjena vrednost', lead: 'Razmerje med vrednostjo ob oddaji in ocenjeno vrednostjo naročila',
        body: ratiosBody(F.ratios),
        cap: 'Kopičenje ponudb tik pod ocenjeno vrednostjo je klasičen znak dogovarjanja ponudnikov ali uhajanja ocene: v konkurenčnem postopku bi pričakovali večjo razpršenost in več ponudb opazno pod oceno. Razmerje okoli 1 ima lahko tudi nedolžen vzrok, npr. ponovljen postopek, v katerem je nova ocena že prilagojena prejetim ponudbam.',
      })}
      ${card({
        id: 'single', n: 4, title: 'Ena ponudba', lead: 'Delež postopkov z eno samo ponudbo med pogodbami z znanim številom ponudb',
        body: singleBody(F.single),
        cap: 'Postopek z eno ponudbo pomeni, da konkurence ni bilo; Opentender/DIGIWHIST ga uporablja kot osnovni kazalnik tveganja. Vzroki so lahko upravičeni (specializirana dela, kratki roki, majhen trg) ali pa omejujoči pogoji in dogovor med ponudniki. Število ponudb je znano le iz objav o oddaji; svetlejši stolpci temeljijo na manj kot petih pogodbah.',
      })}
      ${card({
        id: 'hhi', n: 5, title: 'Koncentracija trga (HHI)', lead: 'Herfindahl-Hirschmanov indeks deležev izvajalcev v vrednosti gradenj DARS po letih; pasovi: nizka, zmerna in visoka koncentracija',
        body: hhiBody(F.hhi),
        cap: 'HHI je vsota kvadratov tržnih deležev (od 0 do 10.000): pod 1.500 je trg nekoncentriran, med 1.500 in 2.500 zmerno, nad 2.500 visoko koncentriran. Na letnem trgu enega naročnika lahko ena velika pogodba sama dvigne indeks, zato je pomembnejši trend kot posamezno leto. Vrednost skupnih ponudb je razdeljena med partnerje enakomerno.',
      })}
      ${card({
        id: 'rotation', n: 6, span: true, title: 'Rotacija zmagovalcev', lead: 'Število pogodb (številka) in vrednost (odtenek) po letih za največje izvajalce',
        body: rotationBody(F.rotation, F.values),
        cap: 'Redno menjavanje istih podjetij, ki si zmage razdelijo po letih, odsekih ali vrstah del, lahko kaže na delitev trga. Vzorec je smiselno brati skupaj z mrežo skupnih ponudb: podjetja, ki se na papirju potegujejo za iste posle, pogosto nastopajo tudi kot partnerji. Klik na ime prikaže pogodbe izvajalca na zemljevidu.',
      })}
      ${card({
        id: 'annex', n: 7, title: 'Aneksi', lead: 'Sprememba vrednosti pogodbe po aneksih glede na vrednost ob oddaji',
        body: annexBody(F),
        cap: 'Visoka rast z aneksi je znak tveganja, ker lahko pomeni prenizko ponudbo, ki jo izvajalec pozneje nadoknadi z dodatnimi deli. Zakon spremembe pogodb omejuje (dodatna dela praviloma do 50 % prvotne vrednosti). Iz objav so znani le objavljeni aneksi; del rasti je upravičen zaradi nepredvidenih razmer na terenu. Okrogli zneski lahko kažejo na pavšalno dogovorjene, ne izračunane spremembe.',
      })}
      ${card({
        id: 'thresholds', n: 8, title: 'Pragovi', lead: 'Porazdelitev vrednosti pogodb na logaritemski lestvici z zakonskimi pragovi',
        body: thresholdsBody(F),
        cap: 'Če je tik pod pragom občutno več pogodb kot tik nad njim, je to lahko znak drobljenja naročil, da bi se izognili strožjemu postopku ali objavi v Uradnem listu EU. Pri majhnem številu pogodb so naključna nihanja velika, najmanjša naročila pa na portalu sploh niso objavljena, zato je levi del porazdelitve nepopoln.',
      })}
      ${card({
        id: 'firms', n: 9, span: true, title: 'Kazalniki po izvajalcih',
        lead: 'Izvajalci z vsaj dvema pogodbama gradenj; razvrstite s klikom na glavo stolpca',
        body: (F.firms || []).length ? '<div class="fx-scroll"><table class="fx-table"></table></div><div class="fx-table-foot"></div>' : empty('Ni izvajalcev z dovolj pogodbami za izračun kazalnikov.'),
        cap: `<b>Tabela je pripomoček za izbor primerov za podrobnejši pregled, ne seznam kršitev.</b> Zastavice: ena ponudba (vsaj 40 % pogodb z eno ponudbo, vsaj tri pogodbe), tik ob oceni (mediana razmerja 0,97–1,03, vsaj tri pogodbe), aneksi (mediana rasti nad 15 %), ponovljeno v garanciji, svoje delo v garanciji, razdrobljena naročila (vsaj dva primera). Vrednost skupnih ponudb je razdeljena med partnerje. Klik na ime prikaže pogodbe izvajalca na zemljevidu.${S.hasReg ? '' : ` Stolpec »ponovljeno v garanciji« potrebuje garancijske roke iz pogodb: ${NO_REG}`}`,
      })}
    </div>
  </div>`;
}

// --- 1. KPI trak ----------------------------------------------------------------------------

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
    return `<div class="fx-kpi ${t.k}">
      <b>${missing ? '–' : num.format(n || 0)}</b>
      <span class="lab">${t.label}</span>
      ${missing ? `<span class="hint miss">${NO_REG}</span>` : v ? `<span class="val">kasnejše pogodbe: ${money(v)}</span>` : ''}
      <span class="hint">${t.hint}</span>
    </div>`;
  }).join('')}</div>`;
}

// --- 2. Benford -----------------------------------------------------------------------------

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

function drawBenford(node, w, d3, b) {
  const { g, iw, ih } = frame(d3, node, w, 180, { t: 8, r: 4, b: 22, l: 34 },
    `Benfordov zakon: delež prve števke 1 do 9, opaženo in pričakovano, n = ${b.n}`);
  const digits = d3.range(1, 10);
  const x = d3.scaleBand().domain(digits).range([0, iw]).paddingInner(0.28).paddingOuter(0.1);
  const y = d3.scaleLinear().domain([0, Math.max(...b.obs, ...b.exp) * 1.08]).nice().range([ih, 0]);
  yGrid(d3, g, y, iw, (v) => `${num.format(v * 100)} %`, 4);
  const bw = Math.min(12, (x.bandwidth() - 2) / 2);
  digits.forEach((d, i) => {
    hit(g, x(d) - (x.step() - x.bandwidth()) / 2, 0, x.step(), ih,
      `Prva števka ${d}: opaženo ${pct(b.obs[i], 1)}, pričakovano ${pct(b.exp[i], 1)}`);
    const cx = x(d) + x.bandwidth() / 2;
    g.append('path').attr('class', 'fx-bar obs').attr('d', barPath(cx - bw - 1, y(b.obs[i]), bw, ih - y(b.obs[i])));
    g.append('path').attr('class', 'fx-bar exp').attr('d', barPath(cx + 1, y(b.exp[i]), bw, ih - y(b.exp[i])));
  });
  xAxis(d3, g, ih, d3.axisBottom(x));
}

// --- 3. razmerje do ocene --------------------------------------------------------------------

function ratioValues(ratios) {
  return (ratios || []).filter((r) => isNum(r?.[1]));
}

function ratiosBody(ratios) {
  const R = ratioValues(ratios);
  if (!R.length) return empty('Ni pogodb z znano ocenjeno vrednostjo.');
  const v = R.map((r) => r[1]);
  const near = R.filter((r) => r[1] >= 0.97 && r[1] <= 1);
  const over = v.filter((x) => x > 1).length;
  const out = v.filter((x) => x < 0.4 || x >= 1.6).length;
  const median = v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const examples = near
    .map(([id, r]) => [S.api?.project?.(id), r])
    .filter(([p]) => p)
    .sort((a, b) => (b[0].v || 0) - (a[0].v || 0));
  return `${chart('ratios')}
    <div class="fx-legend"><span><i class="hl"></i>pogodbe v pasu 0,97–1,00 (tik pod oceno ali enako oceni)</span><span><i class="obs-bar"></i>razredi po 0,05</span></div>
    <div class="fx-stats">
      <span class="warn"><b>${pct(near.length / v.length, 1)}</b> v pasu 0,97–1,00 (${num.format(near.length)} od ${pogodb(v.length)})</span>
      <span><b>${pct(over / v.length, 1)}</b> nad oceno (${num.format(over)})</span>
      <span>mediana <b>${num3.format(median)}</b></span>
      ${out ? `<span>zunaj prikaza (pod 0,4 ali nad 1,6): ${num.format(out)}</span>` : ''}
    </div>
    ${examples.length ? `<details class="fx-more"><summary>Največje pogodbe v pasu 0,97–1,00</summary>${projectList(examples, (r, p) => `razmerje ${num3.format(r)}${p.e ? ` · ocena ${money(p.e)}` : ''}`)}</details>` : ''}`;
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
  bins.forEach((b) => {
    hit(g, x(b.a), 0, x(b.b) - x(b.a), ih, `${dec(b.a, 2)}–${dec(b.b, 2)} × ocene: ${pogodb(b.n)}`);
    const bw = Math.min(24, x(b.b) - x(b.a) - 2);
    const bx = (x(b.a) + x(b.b)) / 2 - bw / 2;
    g.append('path').attr('class', 'fx-bar').attr('d', barPath(bx, y(b.n), bw, ih - y(b.n)));
  });
  // pas 0,97–1,00 kot ožji stolpec čez razred 0,95–1,00: pokaže, koliko pogodb je tik pod oceno
  const bx0 = x(0.97) + 0.5;
  const bw0 = Math.max(2, x(1) - x(0.97) - 1);
  g.append('path').attr('class', 'fx-bar hl').attr('d', barPath(bx0, y(band), bw0, ih - y(band), 2));
  g.append('rect').attr('class', 'fx-hit').attr('x', bx0).attr('y', y(band)).attr('width', bw0).attr('height', ih - y(band))
    .append('title').text(`0,97–1,00 × ocene: ${pogodb(band)}`);
  g.append('text').attr('class', 'ref').attr('x', x(0.97) - 4).attr('y', Math.max(-6, y(band) + 4)).attr('text-anchor', 'end').text(num.format(band));
  g.append('line').attr('class', 'fx-ref-ink').attr('x1', x(1)).attr('x2', x(1)).attr('y1', -10).attr('y2', ih);
  g.append('text').attr('class', 'lbl').attr('x', x(1) + 5).attr('y', -4).text('= ocena');
  xAxis(d3, g, ih, d3.axisBottom(x).tickValues([0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6]).tickFormat((t) => dec(t)));
}

// --- 4. ena ponudba -----------------------------------------------------------------------

function singleRows(single) {
  return Object.entries(single || {})
    .map(([y, r]) => ({ y: Number(y), s: r?.[0] || 0, k: r?.[1] || 0 }))
    .filter((d) => Number.isFinite(d.y))
    .sort((a, b) => a.y - b.y);
}

function singleBody(single) {
  const rows = singleRows(single);
  const s = rows.reduce((a, d) => a + d.s, 0);
  const k = rows.reduce((a, d) => a + d.k, 0);
  if (!k) return empty('Število ponudb ni znano za nobeno pogodbo.');
  const top = rows.filter((d) => d.k >= 5).sort((a, b) => b.s / b.k - a.s / a.k)[0];
  return `${chart('single')}
    <div class="fx-stats">
      <span><b>${pct(s / k, 1)}</b> vseh (${num.format(s)} od ${pogodb(k)})</span>
      ${top ? `<span>največ ${top.y}: <b>${pct(top.s / top.k)}</b> (${num.format(top.s)} od ${num.format(top.k)})</span>` : ''}
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
    hit(g, x(d.y) - (x.step() - x.bandwidth()) / 2, 0, x.step(), ih, share == null
      ? `${d.y}: število ponudb ni znano`
      : `${d.y}: ${num.format(d.s)} od ${pogodb(d.k)} z eno ponudbo (${pct(share)})`);
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

// --- 5. HHI --------------------------------------------------------------------------------

const hhiZone = (v) => (v > 2500 ? 'visoko koncentriran' : v >= 1500 ? 'zmerno koncentriran' : 'nekoncentriran');

function hhiRows(hhi) {
  return Object.entries(hhi || {}).map(([y, v]) => ({ y: Number(y), v })).filter((d) => Number.isFinite(d.y) && isNum(d.v))
    .sort((a, b) => a.y - b.y);
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
      <span>${last.y}: <b>${num.format(last.v)}</b> (${hhiZone(last.v)})</span>
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
    g.append('circle').attr('class', 'fx-dot-hit').attr('cx', x(d.y)).attr('cy', y(d.v)).attr('r', 10)
      .append('title').text(`${d.y}: HHI ${num.format(d.v)}, ${hhiZone(d.v)}`);
    g.append('circle').attr('class', 'fx-dot').attr('cx', x(d.y)).attr('cy', y(d.v)).attr('r', 3.5);
  }
  xAxis(d3, g, ih, d3.axisBottom(x).tickValues(thin(years, x.step())).tickFormat(yearFmt(x.step())));
}

// --- 6. rotacija -----------------------------------------------------------------------------

function rotationBody(R, values) {
  if (!R?.firms?.length || !R?.years?.length || !R?.cells?.length) return empty('Ni podatkov o zmagovalcih po letih.');
  const vals = [];
  let total = 0;
  for (const row of R.cells) for (const c of row || []) if (c?.[0] > 0) { vals.push(c[1] || 0); total += c[1] || 0; }
  const sorted = vals.slice().sort((a, b) => a - b);
  const qs = [1, 2, 3, 4, 5].map((i) => sorted[Math.floor((i * sorted.length) / 6)] ?? Infinity);
  const shade = (v) => 1 + qs.filter((t) => v >= t && t > 0).length;
  const all = (values || []).reduce((a, v) => a + (v || 0), 0);
  const head = R.years.map((y) => `<th scope="col" title="${y}">${String(y).slice(2)}</th>`).join('');
  const body = R.firms.map((f, j) => {
    let n = 0;
    const tds = R.years.map((y, i) => {
      const c = R.cells[i]?.[j] || [0, 0];
      n += c[0] || 0;
      return c[0] > 0
        ? `<td class="h${shade(c[1] || 0)}" title="${esc(f)}, ${y}: ${pogodb(c[0])}, ${esc(money(c[1]))}">${c[0]}</td>`
        : `<td class="z" title="${esc(f)}, ${y}: brez pogodbe"></td>`;
    }).join('');
    return `<tr><th scope="row"><button type="button" class="v-link" data-firm="${esc(f)}" title="${esc(f)}: prikaži pogodbe na zemljevidu">${esc(f)}</button></th>${tds}<td class="tot">${n}</td></tr>`;
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

// --- 7. aneksi -------------------------------------------------------------------------------

function annexBody(F) {
  const G = (F.growth || []).filter((r) => isNum(r?.[1]));
  const RG = (F.reg_growth || []).filter((r) => isNum(r?.[1]));
  const v = G.map((r) => r[1]);
  const share = (t) => v.filter((x) => x > t).length;
  const sortedG = v.slice().sort((a, b) => a - b);
  const examples = G.slice().sort((a, b) => b[1] - a[1]).map(([id, r]) => [S.api?.project?.(id), r]).filter(([p]) => p);
  const round = F.round_annex;
  let html = '';
  if (G.length) {
    html += `<p class="fx-sub">Iz objav o spremembah (n = ${num.format(G.length)})</p>${chart('growth')}
      <div class="fx-stats">
        <span>nad +10 %: <b>${num.format(share(0.1))}</b></span>
        <span class="${share(0.3) ? 'warn' : ''}">nad +30 %: <b>${num.format(share(0.3))}</b></span>
        <span class="${share(0.5) ? 'warn' : ''}">nad +50 %: <b>${num.format(share(0.5))}</b></span>
        <span>znižanj: <b>${num.format(v.filter((x) => x < 0).length)}</b></span>
        <span>mediana <b>${signedPct(sortedG[Math.floor(sortedG.length / 2)])}</b></span>
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
  html += `<div class="fx-stats"><span>okrogli zneski aneksov (deljivi s 1.000 €): <b>${isNum(round) ? pct(round, 1) : 'ni podatka'}</b></span></div>`;
  if (examples.length) {
    html += `<details class="fx-more"><summary>Pogodbe z največjo rastjo</summary>${projectList(examples, (r, p) => `${signedPct(r)}: ${money(p.v)} → ${money(p.vf)}`)}</details>`;
  }
  return html;
}

function drawGrowth(node, w, d3, rows, label) {
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
    hit(g, x(b.a), 0, x(b.b) - x(b.a), ih, `${signedPct(b.a / 100)} do ${last ? 'več' : signedPct(b.b / 100)}: ${pogodb(b.n)}`);
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

// --- 8. pragovi ------------------------------------------------------------------------------

const THRESHOLD_SHORT = (t) => (t >= 1e6 ? `${dec(t / 1e6)} mio` : `${num.format(t / 1e3)} tisoč`);
const DECADE = { 3: '1 tis.', 4: '10 tis.', 5: '100 tis.', 6: '1 mio', 7: '10 mio', 8: '100 mio', 9: '1 mrd' };

function thresholdsBody(F) {
  const V = (F.values || []).filter((v) => v > 0);
  if (!V.length) return empty('Ni vrednosti pogodb.');
  const th = F.thresholds || [];
  const rows = th.map((t) => {
    const bunch = t.below >= 5 && t.below > 1.5 * t.above;
    return `<span class="${bunch ? 'warn' : ''}">${esc(t.name)} (${money(t.t)}): 10 % pod pragom <b>${num.format(t.below)}</b> · 10 % nad <b>${num.format(t.above)}</b>${bunch ? ' <span class="v-tag warn">več tik pod pragom</span>' : ''}</span>`;
  }).join('');
  const splits = F.flags?.splits;
  return `${chart('thresholds')}
    <div class="fx-legend"><span><i class="band"></i>±10 % okoli praga</span><span><i class="line"></i>zakonski prag</span></div>
    <div class="fx-stats" style="flex-direction:column;gap:3px">${rows}
      ${isNum(splits) ? `<span>sočasna ločena naročila za isto delo na istem mestu: <b>${num.format(splits)}</b></span>` : ''}
    </div>`;
}

function drawThresholds(node, w, d3, F) {
  const V = (F.values || []).filter((v) => v > 0);
  const L = V.map((v) => Math.log10(v));
  const lo = Math.floor(Math.min(...L) * 2) / 2;
  const hi = Math.max(lo + 0.5, Math.ceil(Math.max(...L) * 2) / 2);
  const m = { t: 30, r: 10, b: 24, l: 30 };
  // razredi po 0,05 dekade, če je stolpec širok vsaj 6 px, sicer po 0,1
  const per = (w - m.l - m.r) / ((hi - lo) * 20) >= 6 ? 20 : 10;
  const nb = Math.round((hi - lo) * per);
  const bins = d3.range(nb).map((i) => ({ a: lo + i / per, b: lo + (i + 1) / per, n: 0 }));
  for (const l of L) bins[Math.min(nb - 1, Math.max(0, Math.floor((l - lo) * per + 1e-9)))].n += 1;
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
  bins.forEach((b) => {
    hit(g, x(b.a), 0, x(b.b) - x(b.a), ih, `${money(10 ** b.a)} do ${money(10 ** b.b)}: ${pogodb(b.n)}`);
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

// --- 9. tabela izvajalcev ---------------------------------------------------------------------

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

function renderTable() {
  const table = S.el.querySelector('.fx-table');
  if (!table) return;
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
  const body = shown.map((f) => {
    const singleWarn = f.bids >= 3 && f.single / f.bids >= 0.4;
    const ratioWarn = isNum(f.ratio) && f.ratio >= 0.97 && f.ratio <= 1.03;
    const growthWarn = isNum(f.growth) && f.growth > 0.15;
    const redone = !S.hasReg && !f.redone ? '–' : `${num.format(f.redone || 0)}${f.own ? ` (${num.format(f.own)})` : ''}`;
    return `<tr>
      <th scope="row"><button type="button" class="v-link" data-firm="${esc(f.n)}" title="Prikaži pogodbe na zemljevidu">${esc(f.n)}</button>${f.y ? `<small>${f.y[0]}${f.y[1] !== f.y[0] ? `–${f.y[1]}` : ''}</small>` : ''}</th>
      <td class="num">${num.format(f.c || 0)}</td>
      <td class="num">${esc(money(f.v))}</td>
      <td class="num${singleWarn ? ' warn' : ''}">${f.bids ? `${num.format(f.single || 0)}/${num.format(f.bids)}` : '–'}</td>
      <td class="num${ratioWarn ? ' warn' : ''}">${isNum(f.ratio) ? num3.format(f.ratio) : '–'}</td>
      <td class="num${growthWarn ? ' warn' : ''}">${signedPct(f.growth)}</td>
      <td class="num${f.redone ? ' warn' : ''}">${redone}</td>
      <td><span class="v-tags">${(f.flags || []).map((x) => `<span class="v-tag warn">${esc(x)}</span>`).join('') || '<span class="v-empty">–</span>'}</span></td>
    </tr>`;
  }).join('');
  table.innerHTML = `<caption class="v-sr">Kazalniki po izvajalcih, razvrščeno po stolpcu ${esc(col.label)}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  const flagged = rows.filter((f) => f.flags?.length).length;
  S.el.querySelector('.fx-table-foot').innerHTML = `<span>${num.format(rows.length)} izvajalcev, od tega ${num.format(flagged)} z vsaj eno zastavico</span>
    ${rows.length > ROWS ? `<button type="button" class="v-btn" data-all>${S.all ? 'Prikaži manj' : `Prikaži vse (${num.format(rows.length)})`}</button>` : ''}`;
}

// --- risanje ---------------------------------------------------------------------------------

const CHARTS = {
  'benford-award': (n, w, d3) => drawBenford(n, w, d3, S.F.benford.award),
  'benford-annex': (n, w, d3) => drawBenford(n, w, d3, S.F.benford.annex),
  ratios: (n, w, d3) => drawRatios(n, w, d3, S.F.ratios),
  single: (n, w, d3) => drawSingle(n, w, d3, S.F.single),
  hhi: (n, w, d3) => drawHhi(n, w, d3, S.F.hhi),
  growth: (n, w, d3) => drawGrowth(n, w, d3, S.F.growth, `Histogram rasti vrednosti z aneksi za ${pogodb(S.F.growth.length)}, razredi po 5 odstotnih točk`),
  'reg-growth': (n, w, d3) => drawGrowth(n, w, d3, S.F.reg_growth, `Histogram dodatkov iz registra pogodb za ${pogodb(S.F.reg_growth.length)}`),
  thresholds: (n, w, d3) => drawThresholds(n, w, d3, S.F),
};

function drawCharts() {
  if (!S) return;
  const d3 = window.d3;
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
}

function frame(d3, node, w, h, m, label) {
  node.textContent = '';
  const svg = d3.select(node).append('svg')
    .attr('class', 'fx-svg').attr('width', w).attr('height', h).attr('viewBox', `0 0 ${w} ${h}`)
    .attr('role', 'img').attr('aria-label', label);
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

// Prozoren pravokotnik z opisom: večja tarča za miško kot sam stolpec.
function hit(g, x, y, w, h, title) {
  g.append('rect').attr('class', 'fx-hit').attr('x', x).attr('y', y).attr('width', Math.max(1, w)).attr('height', h)
    .append('title').text(title);
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

function projectList(items, extra) {
  return `<ul class="fx-list">${items.slice(0, 5).map(([p, x]) => `<li><button type="button" data-open="${p.i}">
    <span class="t">${esc(p.t)}</span><span class="v">${esc(money(p.vf ?? p.v))}</span>
    <span class="m">${p.y ?? '–'}${p.ws?.length ? ` · ${esc(p.ws.join(', '))}` : ''} · ${esc(extra(x, p))}</span>
  </button></li>`).join('')}</ul>`;
}
