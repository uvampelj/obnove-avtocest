"""Iz shranjenih objav zgradi web/data/obnove.json: pogodbe z aneksi, lego na avtocesti in ponovitve."""
from __future__ import annotations

import json
import math
import re
import sys
from collections import defaultdict
from datetime import date, datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path

from .firms import norm_title, short_firm
from .forensics import flag_pairs, forensics, link_contracts, load_contracts
from .warranty import term_for
from .forensics import network as firm_network
from .linear import Linear
from .locate import LAT_M, LON_M, Locator, Network, direction, read
from .parse import clean, parse

ROOT = Path(__file__).resolve().parent.parent
NOTICES = ROOT / "data" / "notices"
OSM = ROOT / "data" / "osm.json"
STATUS = ROOT / "status" / "latest.json"
OUT = ROOT / "web" / "data" / "obnove.json"
OUT_FORENSICS = ROOT / "web" / "data" / "forenzika.json"
OUT_AXES = ROOT / "web" / "data" / "osi.json"
AXIS_STEP = 200.0   # m med točkami osi za 3D prikaz plasti

CATEGORIES = [
    ("gradnja", "Novogradnje, priključki, širitve",
     r"^(?:izgradnj|gradnj|dograditev|novogradnj|dokončanje)|izgradnj\w* (?:hitr|avtoc|nov|štiri|trase)|razširit|tretj\w* (?:vozn\w* )?pas|"
     r"dodatn\w* (?:vozn\w* )?pas|glavna gradbena dela|zaključna gradbena dela|\btras[ae]\b|avtocestni odsek|deviacij|bencinsk|"
     r"gradnj\w* odseka|\betap[aei]\b|pasov za prepletanje|odstavnih niš|"
     r"priključ\w* .*(?:ureditev|izvedb|rekonstr)|ureditev priključ|rekonstrukcij\w* priključ|križišč|krožn\w* križ|parkirišč"),
    ("vozisce", "Vozišče", r"vozi[sš][cč]|vozn\w* povr|krovn\w* plast|asfalt|preplast|obrabn|cestišč|nosiln\w* plast|razpok|\brež\b|krpanj|hrapav|torn\w* lastnost|obnov\w* (?:ceste|cestnega odseka|odsek)|rekonstrukcij\w* (?:ceste|cestnega telesa|avtoc)"),
    ("objekti", "Mostovi in viadukti", r"viadukt|\bmost|nadvoz|podvoz|galerij|prepust|oporn\w* zid|podporn\w* zid|dilatac|ležišč|premostitv|(?:rekonstrukcij|sanacij)\w* objekt"),
    ("predori", "Predori", r"predor|pokrit\w* vkop"),
    ("hrup", "Protihrupna zaščita", r"protihrup|\bhrup"),
    ("ograje", "Varnostne ograje", r"ograj|\bJVO\b|\bBVO\b"),
    ("odvodnjavanje", "Odvodnjavanje", r"odvodnj|kanalizac|lovilc|zadrževaln|meteorn|ponikoval|jarek|jarki|odcejalnik"),
    ("brezine", "Brežine, nasipi in plazovi", r"brežin|plaz|usad|padajoč|skaln|pobočj|zemeljsk\w* dela|nasip|pilotn|zdrs"),
    ("oprema", "Oprema in signalizacija", r"signalizac|razsvetljav|označb|\bESO\b|prometn\w* oprem|vremensk|cestninsk|video|elektro|portal"),
    ("stavbe", "Stavbe in počivališča", r"počivališč|stavb|baz\w*\b|centr\w* za vzdrževanje|izpostav"),
    ("drugo", "Drugo", r""),
]
CAT_RX = [(key, re.compile(rx, re.I)) for key, _, rx in CATEGORIES if rx]
WORKS_HINT = re.compile(r"gradb|gradnj|obnov|sanacij|rekonstr|vozi[sš]|viadukt|predor|asfalt|ograj|odvodnj", re.I)
SERVICES = re.compile(r"projektiran|projektn\w* dokumentacij|študij|svetovan|nadzor|revizij|izdelav\w* (?:pzi|pgd|izp|dpn)", re.I)
IDENT = re.compile(r"(\d{3,6})/(\d{4})")
ANNEX = re.compile(r"\s*aneks\w*\s*(?:št\.?\s*)?(\d+)?", re.I)
CONTRACT_NO = re.compile(r"(?:pog\w*\.?|pogodbi)\s*(?:DARS\s*)?(?:d\.\s?d\.,?\s*)?št\.?\s*(\d{1,5}\s*/\s*\d{2,4})", re.I)
ANNEX_SUBJECT = re.compile(r"^\s*aneks.*?(?:št\.?\s*\d{1,5}\s*/\s*\d{2,4}|\d{1,5}/\d{2,4})\s*[:,]?", re.I)


def categorize(title: str, text: str) -> list[str]:
    hits = [key for key, rx in CAT_RX if rx.search(title)]
    for key, rx in CAT_RX:
        if key not in hits and rx.search(text):
            hits.append(key)
    if not hits:
        return ["drugo"]
    if "gradnja" in hits and not CAT_RX[0][1].search(title):
        hits.remove("gradnja")
        hits.append("gradnja")
    return hits


def ident_keys(*idents: str) -> set[tuple[int, int]]:
    out = set()
    for ident in idents:
        for num, year in IDENT.findall(ident or ""):
            out.add((int(num), int(year)))
    return out


def is_works(rec: dict) -> bool:
    if rec["kind"] == "gradnje":
        return True
    if rec["kind"] in ("storitve", "blago"):
        return False
    blob = f"{rec['title']} {rec['text'][:400]}"
    return bool(WORKS_HINT.search(blob)) and not SERVICES.search(rec["title"])


def year_of(iso: str | None) -> int | None:
    return int(iso[:4]) if iso else None


def years_between(a: str, b: str) -> float:
    da, db = date.fromisoformat(a), date.fromisoformat(b)
    return abs((db - da).days) / 365.25


# --- ponovitve na istem mestu -----------------------------------------------------------------

STEP = 40.0     # razdalja med točkami ob črti (m)
NEAR = 70.0     # obe smeri vožnje sta do ~40 m narazen
CELL = 100.0


def directions(p: dict) -> set[str]:
    out = set()
    for s in p.get("sections") or []:
        for code in s.get("codes") or []:
            d = direction(code)
            if d:
                out.add("L" if d == 1 else "D")
    return out


def densify(lines) -> list[tuple[float, float]]:
    pts = []
    for line in lines:
        xy = [(p[0] * LON_M, p[1] * LAT_M) for p in line]
        for (x0, y0), (x1, y1) in zip(xy, xy[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            n = max(1, int(seg // STEP))
            for k in range(n):
                t = k / n
                pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
        if xy:
            pts.append(xy[-1])
    return pts


def overlaps(projects: list[dict]) -> tuple[list[list], list[list]]:
    """Pari pogodb na istem mestu: ponovitve (1-15 let narazen) in sočasna ločena naročila (pod 1 leto)."""
    shapes = []
    for p in projects:
        if not p["geometry"] or p["precision"] not in ("km", "odsek", "objekt", "kraj"):
            continue
        pts = densify(p["geometry"])
        if len(pts) < 2:
            continue
        xs, ys = [x for x, _ in pts], [y for _, y in pts]
        grid = defaultdict(list)
        for x, y in pts:
            grid[(int(x // CELL), int(y // CELL))].append((x, y))
        shapes.append((p, pts, (min(xs), min(ys), max(xs), max(ys)), grid))

    pairs, splits = [], []
    for i in range(len(shapes)):
        pa, pts_a, box_a, _ = shapes[i]
        for j in range(i + 1, len(shapes)):
            pb, pts_b, box_b, grid_b = shapes[j]
            if box_a[0] > box_b[2] + NEAR or box_b[0] > box_a[2] + NEAR or box_a[1] > box_b[3] + NEAR or box_b[1] > box_a[3] + NEAR:
                continue
            if pa["date"] is None or pb["date"] is None:
                continue
            gap = years_between(pa["date"], pb["date"])
            if gap > 15:
                continue
            # Pod enim letom gre večinoma za sklope ali anekse istega posla, ne za ponovitev; ločena
            # naročila iste vrste dela na istem mestu z različnim naslovom so kazalnik razdrobitve.
            simultaneous = gap < 1
            if simultaneous and (pa["dosje"] == pb["dosje"] or pa["cats"][0] != pb["cats"][0]
                                 or pa["cats"][0] in ("gradnja", "drugo") or "aneksi" in (pa["phase"], pb["phase"])
                                 or SequenceMatcher(None, norm_title(pa["title"]), norm_title(pb["title"])).ratio() > 0.8):
                continue
            if "aneksi" in (pa["phase"], pb["phase"]) and pa.get("contract") and pa.get("contract") == pb.get("contract"):
                continue
            # Šifre 00xx in 06xx sta nasprotni smeri vožnje; na zemljevidu sta na isti osi.
            da, db = directions(pa), directions(pb)
            if da and db and not (da & db):
                continue
            hits = 0
            for x, y in pts_a:
                cx, cy = int(x // CELL), int(y // CELL)
                found = False
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for qx, qy in grid_b.get((cx + dx, cy + dy), ()):
                            if (qx - x) ** 2 + (qy - y) ** 2 <= NEAR * NEAR:
                                found = True
                                break
                        if found:
                            break
                    if found:
                        break
                hits += found
            shared = hits * STEP
            shorter = min(len(pts_a), len(pts_b)) * STEP
            if shared >= 300 or (shorter and shared / shorter >= 0.4 and shared >= 100):
                first, second = (pa, pb) if pa["date"] <= pb["date"] else (pb, pa)
                if simultaneous:
                    splits.append([first["id"], second["id"], int(round(gap * 365.25)), int(round(shared, -1))])
                    continue
                # Ista vrsta dela; novogradnja, ki ji sledi gradnja na istem mestu, ni ponovitev obnove.
                same = first["cats"][0] == second["cats"][0] and first["cats"][0] not in ("gradnja", "drugo")
                if same and first["phase"] == "aneksi" and second["phase"] == "aneksi":
                    same = False
                # Skoraj enak naslov v manj kot treh letih: ista dela v fazah ali ponovno oddan posel.
                if same and gap < 3 and SequenceMatcher(None, norm_title(first["title"]), norm_title(second["title"])).ratio() > 0.8:
                    same = False
                pairs.append([first["id"], second["id"], round(gap, 1), int(round(shared, -1)), int(same)])
    return pairs, splits


# --- glavni del ---------------------------------------------------------------------------------

def load() -> list[dict]:
    records = []
    for path in sorted(NOTICES.glob("*.json")):
        notice = json.loads(path.read_text(encoding="utf-8"))
        try:
            records.append(parse(notice))
        except Exception as error:
            print(f"Objave {path.stem} ni bilo mogoče razčleniti: {error}", file=sys.stderr)
    return records


def build_projects(records: list[dict]) -> list[dict]:
    calls = {}
    for rec in records:
        if rec["phase"] == "razpis" and rec.get("docs"):
            calls[rec["dosje"]] = rec

    awards = [r for r in records if r["phase"] in ("oddaja", "neposredna") and is_works(r)]
    mods = [r for r in records if r["phase"] == "sprememba"]
    # Stari portal (do 2015) je anekse objavljal kot obvestila o oddaji: »aneks št. 4 k pog. DARS št. 494/08: ...«.
    annexes = [r for r in awards if ANNEX.match(r["title"])]
    awards = [r for r in awards if not ANNEX.match(r["title"])]

    # Novi obrazci: en projekt na dosje (zadnja objava o oddaji velja); stari: vsaka oddaja posebej.
    by_dosje: dict = {}
    singles = []
    for rec in awards:
        if rec["form"].startswith("EUe"):
            prev = by_dosje.get(rec["dosje"])
            if prev is None or (rec["published"] or "") > (prev["published"] or ""):
                by_dosje[rec["dosje"]] = rec
        else:
            singles.append(rec)
    chosen = list(by_dosje.values()) + singles

    projects = []
    key_index: dict[tuple, list[dict]] = defaultdict(list)
    dosje_index: dict = {}
    title_index: dict[str, list[dict]] = defaultdict(list)
    for rec in chosen:
        project = {
            "id": rec["id"],
            "dosje": rec["dosje"],
            "title": rec["title"],
            "text": rec["text"],
            "date": rec["contract_date"] or rec["published"],
            "published": rec["published"],
            "value": rec["value"],
            "estimate": rec["estimate"],
            "winners": [w["name"] for w in rec["winners"]],
            "bids": rec["bids"],
            "phase": rec["phase"],
            "mods": [],
            "sources": [["Oddaja" if rec["phase"] == "oddaja" else "Neposredna oddaja", rec["url"]]],
            "docs": None,
        }
        call = calls.get(rec["dosje"])
        if call:
            project["docs"] = call["docs"]
            project["sources"].insert(0, ["Razpis", call["url"]])
        projects.append(project)
        for key in ident_keys(rec["ident"], *rec["refs"]):
            key_index[key].append(project)
        if rec["form"].startswith("EUe"):
            dosje_index[rec["dosje"]] = project
        title_index[norm_title(rec["title"])].append(project)

    orphans = 0
    for mod in sorted(mods, key=lambda m: m["published"] or ""):
        target = dosje_index.get(mod["dosje"])
        if target is None:
            for key in ident_keys(mod["ident"], *mod["refs"]):
                if key in key_index:
                    target = key_index[key][0]
                    break
        if target is None:
            same = title_index.get(norm_title(mod["title"]), [])
            if len(same) == 1:
                target = same[0]
        entry = {
            "date": mod["published"],
            "before": mod["value_before"],
            "after": mod["value_after"],
            "note": mod["change"],
            "url": mod["url"],
        }
        if target is None:
            if not is_works(mod):
                continue
            orphans += 1
            target = {
                "id": mod["id"], "dosje": mod["dosje"], "title": mod["title"], "text": mod["text"],
                "date": mod["contract_date"] or mod["published"], "published": mod["published"],
                "value": mod["value_before"] or mod["value"], "estimate": None,
                "winners": [w["name"] for w in mod["winners"]], "bids": None, "phase": "sprememba",
                "mods": [], "sources": [], "docs": None,
            }
            projects.append(target)
            if mod["form"].startswith("EUe"):
                dosje_index[mod["dosje"]] = target
            title_index[norm_title(mod["title"])].append(target)
        target["mods"].append(entry)
        target["sources"].append(["Sprememba pogodbe", mod["url"]])
        if not target["winners"] and mod["winners"]:
            target["winners"] = [w["name"] for w in mod["winners"]]
    print(f"Sprememb brez najdene prvotne oddaje: {orphans}")

    groups: dict[str, list[dict]] = defaultdict(list)
    for rec in annexes:
        m = CONTRACT_NO.search(rec["title"])
        groups[m.group(1).replace(" ", "") if m else f"id{rec['id']}"].append(rec)
    for number, recs in groups.items():
        recs.sort(key=lambda r: r["published"] or "")
        seen_no = set()
        entries = []
        for rec in recs:
            no = ANNEX.match(rec["title"]).group(1)
            if no and no in seen_no:
                continue
            seen_no.add(no)
            entries.append(rec)
        subject = ANNEX_SUBJECT.sub("", entries[-1]["title"]).strip(" :-") or entries[-1]["title"]
        subject = re.sub(r"\s*[-–]\s*(?:nepredvidena|dodatna|podaljšanje|razlike|več in manj)[^:]*$", "", subject, flags=re.I)
        first = entries[0]
        project = {
            "id": first["id"], "dosje": first["dosje"], "title": clean(subject, 220) or first["title"],
            "text": "\n".join(r["text"] for r in entries)[:4000],
            "date": first["contract_date"] or first["published"], "published": first["published"],
            "value": None, "estimate": None,
            "winners": list(dict.fromkeys(w["name"] for r in entries for w in r["winners"])),
            "bids": None, "phase": "aneksi", "contract": None if number.startswith("id") else number,
            "mods": [{
                "date": r["contract_date"] or r["published"], "before": None, "after": None, "add": r["value"],
                "note": clean(r["title"], 300), "url": r["url"],
            } for r in entries],
            "sources": [[f"Aneks {ANNEX.match(r['title']).group(1) or ''}".strip(), r["url"]] for r in entries],
            "docs": None,
        }
        projects.append(project)

    # Stari portal je isto oddajo občasno objavil dvakrat: združi zapise z istim naslovom,
    # vrednostjo in izvajalcem.
    unique: dict[tuple, dict] = {}
    for p in projects:
        key = (norm_title(p["title"]), round(p["value"] or 0), tuple(p["winners"][:1]))
        if key in unique and p["value"]:
            keep = unique[key]
            keep["sources"] += [s for s in p["sources"] if s not in keep["sources"]]
            keep["mods"] += [m for m in p["mods"] if m not in keep["mods"]]
            continue
        unique[key] = p
    projects = list(unique.values())

    for p in projects:
        p["mods"].sort(key=lambda m: m["date"] or "")
        # Aneks pri naročilu s sklopi navaja vrednost posameznega sklopa, zato končno vrednost
        # računamo kot vrednost ob oddaji in razlike aneksov (vsaka razlika enkrat).
        deltas = {}
        for m in p["mods"]:
            if m["before"] and m["after"]:
                deltas[(round(m["before"]), round(m["after"]))] = m["after"] - m["before"]
        added = sum(m.get("add") or 0 for m in p["mods"])
        if p["value"] is None and p["phase"] == "sprememba":
            befores = [m["before"] for m in p["mods"] if m["before"]]
            p["value"] = befores[0] if befores else None
        if p["value"] is None and not added:
            p["value_final"] = None
        else:
            p["value_final"] = (p["value"] or 0) + sum(deltas.values()) + added
        p["cats"] = categorize(p["title"], p["text"])
    return projects


NOISE = re.compile(
    r"(?:Š|S)ifra NUTS:?\s*[A-Z0-9]*\.?|Naročilo je oddano/sklop je oddan:\s*\w+|II\.\d[\d.]*\s*Opis javnega naročila|"
    r"Javno naročilo je razdeljeno na \d+\s*\w*",
    re.I,
)


def description(p: dict) -> str:
    """Opis brez naslova, ponovitev in obrazčnih fraz."""
    parts, seen = [], {norm_title(p["title"])}
    for line in p["text"].split("\n")[1:]:
        for piece in re.split(r"(?<=[.!?])\s+", NOISE.sub(" ", line)):
            piece = clean(piece)
            key = norm_title(piece)
            if len(key) < 4 or key in seen or any(key in s for s in seen):
                continue
            seen.add(key)
            parts.append(piece)
    return clean(" ".join(parts), 500)


def compact_project(p: dict) -> dict:
    geometry = None
    if p["geometry"]:
        geometry = [[[round(x, 5), round(y, 5)] for x, y in line] for line in p["geometry"]]
    sections = [
        {k: v for k, v in s.items() if v not in (None, [], "")} for s in p["sections"]
    ]
    out = {
        "i": p["id"], "t": p["title"], "c": p["cats"], "d": p["date"], "y": year_of(p["date"]),
        "v": round(p["value"]) if p["value"] else None,
        "vf": round(p["value_final"]) if p["value_final"] else None,
        "e": round(p["estimate"]) if p["estimate"] else None,
        "w": p["winners"], "ws": list(dict.fromkeys(short_firm(w) for w in p["winners"])), "b": p["bids"], "k": p["phase"], "r": p["roads"], "s": sections,
        "p": p["precision"], "g": geometry,
        "m": [{k: v for k, v in {
            "d": m["date"], "v0": round(m["before"]) if m["before"] else None,
            "v1": round(m["after"]) if m["after"] else None, "a": round(m["add"]) if m.get("add") else None,
            "x": m["note"], "u": m["url"]}.items() if v not in (None, "")} for m in p["mods"]],
        "n": p.get("contract"),
        "src": p["sources"], "doc": p["docs"], "x": description(p),
        # Garancijski roki [predmet, leta], podizvajalci, vpis v registru pogodb, km na cesti, smer vožnje.
        "gw": p.get("warranty"), "wy": term_for(p.get("warranty") or [], p["cats"][0]), "sub": p.get("subs"),
        "rg": [{k: v for k, v in {
            "no": r["number"], "d": r["signed"], "to": r["to"], "v": round(r["value"]) if r["value"] else None,
            "src": r["source"], "a": [[a["d"], round(a["v"]) if a["v"] else None, a["t"]] for a in r["annexes"]],
        }.items() if v not in (None, [], "")} for r in p.get("register") or []],
        "lr": p.get("lr"),
        "dir": {frozenset("L"): 1, frozenset("D"): 2}.get(frozenset(directions(p)), 0) or None,
    }
    return {k: v for k, v in out.items() if v not in (None, [], "")}


def main() -> int:
    records = load()
    if not records:
        print("Ni shranjenih objav. Najprej zaženite python -m pipeline.collect.", file=sys.stderr)
        return 1
    projects = build_projects(records)
    contracts = load_contracts()
    linked = link_contracts(projects, contracts)
    print(f"Pogodb v registru: {len(contracts)}, povezanih z objavami: {linked['linked']}, z garancijskim rokom: {linked['warranty']}")

    network = Network(json.loads(OSM.read_text(encoding="utf-8")))
    locator = Locator(network)
    linear = Linear(network)
    infos = {}
    for p in projects:
        infos[p["id"]] = read(f"{p['title']}\n{p['text']}")
        locator.learn(infos[p["id"]])
    located = 0
    for p in projects:
        info = infos[p["id"]]
        p["roads"] = info["roads"]
        lines, precision, sections = locator.locate(info)
        p["geometry"], p["precision"], p["sections"] = lines, precision, sections
        p["lr"] = linear.ranges(lines) if lines else None
        p["geometry"] = linear.orient(lines, p["lr"])
        p["dirs"] = directions(p)
        located += lines is not None

    repeats, splits = overlaps(projects)
    by_id = {p["id"]: p for p in projects}
    flag_pairs(repeats, by_id)
    projects.sort(key=lambda p: (p["date"] or "", p["id"]))

    status = json.loads(STATUS.read_text(encoding="utf-8")) if STATUS.exists() else {}
    years = [year_of(p["date"]) for p in projects if p["date"]]
    data = {
        "meta": {
            "built": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "newest": (status.get("newest_notice") or "")[:10] or None,
            "notices": len(records),
            "projects": len(projects),
            "located": located,
            "contracts": linked["linked"],
            "warranty": linked["warranty"],
            "years": [min(years), max(years)] if years else None,
            "categories": [{"key": key, "label": label} for key, label, _ in CATEGORIES],
        },
        "roads": linear.summary(),
        "projects": [compact_project(p) for p in projects],
        "repeats": repeats,
        "splits": splits,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    roads = linear.summary()
    axes = {ref: linear.axis(ref, AXIS_STEP) for ref in linear.roads}
    OUT_AXES.write_text(json.dumps({"step": AXIS_STEP / 1000, "roads": axes}, separators=(",", ":")), encoding="utf-8")
    extra = {"forensics": forensics(projects, repeats, splits, contracts, roads, axes, AXIS_STEP / 1000),
             "network": firm_network(projects, contracts)}
    OUT_FORENSICS.write_text(json.dumps(extra, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    flags = extra["forensics"]["flags"]["count"]
    print(f"Objav: {len(records)}, pogodb: {len(projects)}, umeščenih: {located}, "
          f"parov na istem mestu: {len(repeats)} (v garanciji {flags.get('g', 0)}, po rekonstrukciji {flags.get('r', 0)}, "
          f"drugo ime {flags.get('p', 0)}), sočasnih: {len(splits)}, {OUT.stat().st_size / 1e6:.1f} MB + "
          f"{OUT_FORENSICS.stat().st_size / 1e6:.1f} MB + {OUT_AXES.stat().st_size / 1e6:.2f} MB, mreža: {len(extra['network']['nodes'])} vozlišč")
    return 0


if __name__ == "__main__":
    sys.exit(main())
