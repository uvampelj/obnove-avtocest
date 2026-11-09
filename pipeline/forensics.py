"""Forenzični kazalniki nad pogodbami: garancije, nekonsistentnosti, statistični testi in mreža izvajalcev.

Kazalniki so »rdeče zastavice« za podrobnejši pregled, kot jih uporabljajo revizorji javnih naročil
(OECD, Evropsko računsko sodišče, Opentender/DIGIWHIST). Noben kazalnik sam po sebi ne dokazuje
nepravilnosti: vsak ima lahko upravičeno razlago, ki jo je treba preveriti v dokumentaciji.
"""
from __future__ import annotations

import json
import math
import re
import statistics
from collections import Counter, defaultdict
from datetime import date
from difflib import SequenceMatcher
from pathlib import Path

from .firms import BUYER, firm_key, norm_title, short_firm, subcontractors
from .warranty import covers, parse_warranty, term_for

ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = ROOT / "data" / "contracts"

# Dela, ki obnovijo celotno konstrukcijo ali zgradijo novo; ponovna dela na istem mestu v nekaj
# letih so nenavadna (projektna doba voziščne konstrukcije je 20 let, obrabne plasti 10-15 let).
RECONSTRUCTION = re.compile(
    r"rekonstrukc|celovit|obnov\w* vozi[sš][čc]n\w* konstrukc|izgradnj|novogradnj|gradnj\w* (?:odseka|avtoc|hitre)|"
    r"razširit|nadgradnj\w* (?:ceste|avtoc|odseka|vozi)|zamenjav\w* vozi[sš][čc]n",
    re.I,
)
RECON_YEARS = 8
SUBSTANCE = {"vozisce", "objekti", "predori", "hrup", "ograje", "odvodnjavanje", "brezine", "oprema"}
# Pragovi za gradnje po ZJN-3: evidenčna naročila do 40.000 €, naročila male vrednosti do 500.000 €,
# nad evropskim pragom (okoli 5,4 mio €) obvezna objava v Uradnem listu EU.
THRESHOLDS = [[40000, "evidenčna naročila"], [500000, "male vrednosti"], [5382000, "evropski prag"]]


def load_contracts() -> list[dict]:
    if not CONTRACTS.exists():
        return []
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(CONTRACTS.glob("*.json"))]


def _days(a: str | None, b: str | None) -> float | None:
    if not a or not b:
        return None
    return abs((date.fromisoformat(a[:10]) - date.fromisoformat(b[:10])).days)


# --- povezava z registrom pogodb --------------------------------------------------------------

def link_contracts(projects: list[dict], contracts: list[dict]) -> dict:
    meta = {c["meta"]["id"]: c for c in contracts}
    pog = [c for c in contracts if c["meta"].get("type") == "POG"]
    by_dosje, by_title = defaultdict(list), defaultdict(list)
    for c in pog:
        m = c["meta"]
        if m.get("idDosje"):
            by_dosje[m["idDosje"]].append(c)
        for t in {m.get("procurement"), m.get("title")}:
            if t:
                by_title[norm_title(t)].append(c)

    def root(c):
        seen = set()
        while c["meta"].get("prev") in meta and c["meta"]["id"] not in seen:
            seen.add(c["meta"]["id"])
            c = meta[c["meta"]["prev"]]
        return c["meta"]["id"]

    annexes = defaultdict(list)
    for c in contracts:
        if c["meta"].get("type") == "DOD":
            annexes[root(c)].append(c["meta"])

    linked = with_warranty = 0
    for p in projects:
        cands = list(by_dosje.get(p["dosje"], []))
        same_dosje = bool(cands)
        if not cands:
            cands = [c for c in by_title.get(norm_title(p["title"]), [])
                     if (_days(c["meta"].get("signed"), p["date"]) or 0) <= 400]
        if len(cands) > 1 and p["winners"]:
            keys = {firm_key(w) for w in p["winners"]}
            narrowed = [c for c in cands if keys & {firm_key(n) for n in c["meta"].get("contractors") or []}]
            cands = narrowed or cands
            same_dosje = same_dosje and bool(narrowed)  # sklopi: partnerje dodamo le pri ujemanju izvajalca
        p["warranty"], p["subs"], p["register"] = [], [], []
        if not cands:
            continue
        linked += 1
        winners = {firm_key(w) for w in p["winners"]}
        for c in cands:
            m = c["meta"]
            winners |= {firm_key(n) for n in m.get("contractors") or []}
        for c in cands:
            m = c["meta"]
            for term in parse_warranty(c.get("text") or ""):
                if term not in p["warranty"]:
                    p["warranty"].append(term)
            for name in subcontractors(c.get("text") or "", winners):
                if firm_key(name) not in {firm_key(s) for s in p["subs"]}:
                    p["subs"].append(name)
            dods = sorted(annexes.get(m["id"], []), key=lambda a: a.get("signed") or "")
            p["register"].append({
                "id": m["id"], "number": m.get("number"), "signed": m.get("signed"), "to": m.get("to"),
                "value": m.get("value"), "contractors": m.get("contractors") or [], "source": c.get("source"),
                "buyers": m.get("buyers") or [],
                "files": [f for f in m.get("files") or [] if f.get("url")][:3],
                "annexes": [{"d": a.get("signed"), "v": a.get("value"), "t": a.get("title")} for a in dods],
            })
            for f in m.get("files") or []:
                if f.get("url") and len(p["sources"]) < 14:
                    p["sources"].append(["Pogodba (PDF)", f["url"]])
            # Register navaja vse partnerje v skupni ponudbi; objava včasih le vodilnega.
            if not p["winners"] or same_dosje:
                have = {firm_key(w) for w in p["winners"]}
                for name in m.get("contractors") or []:
                    if firm_key(name) not in have and not BUYER.search(name):
                        p["winners"].append(name)
                        have.add(firm_key(name))
        with_warranty += bool(p["warranty"])
    return {"linked": linked, "warranty": with_warranty, "register": len(pog)}


# --- nekonsistentnosti pri ponovitvah --------------------------------------------------------------

def firm_set(p: dict) -> set[str]:
    return {firm_key(w) for w in p["winners"]}


def flag_pairs(pairs: list[list], by_id: dict) -> None:
    """Doda vsakemu paru veljavni garancijski rok prvega dela in oznake:
    g = drugo delo v garancijski dobi prvega, i = isti izvajalec v garancijski dobi,
    r = ponovna dela kmalu po rekonstrukciji ali novogradnji, p = ista vrsta dela pod drugim imenom."""
    for row in pairs:
        first, second = by_id[row[0]], by_id[row[1]]
        gap, same = row[2], row[4]
        flags = ""
        ratio = SequenceMatcher(None, norm_title(first["title"]), norm_title(second["title"])).ratio()
        # Skoraj enak naslov v manj kot treh letih: zaporedne faze istega programa, ne ponovitev. Pri
        # umestitvi na cel odsek se sosednje faze navidezno prekrivajo, zato tam zahtevamo vsaj 3 leta.
        approx = {first.get("precision"), second.get("precision")} & {"odsek", "kraj"}
        phased = gap < 3 and (ratio > 0.8 or bool(approx))
        c2 = second["cats"][0]
        terms = first.get("warranty") or []
        # Kaj je prejšnja pogodba dejansko obsegala: vrste dela iz naslova (opis objave omenja
        # marsikaj, npr. prometno ureditev med deli) ali vrsta dela s posebnim garancijskim rokom.
        scope = set(first.get("tcats") or ())   # brez vrste v naslovu (»Gradbena dela na avtocestah«) obsega ne poznamo
        in_scope = c2 in scope or covers(terms, c2)
        wy = term_for(terms, c2) if in_scope else None
        # Oznako dobi le par, ki je zares na istem mestu: skupna je vsaj polovica krajšega dela (ali
        # 2 km) ali ista šifra odseka; pogodbe za cela območja (nad 40 km osi) so preveč razpršene.
        shorter = min(_km(first), _km(second)) * 1000
        shared_code = bool((first.get("seccodes") or set()) & (second.get("seccodes") or set()))
        # Prejšnja pogodba mora v naslovu imeti vrsto dela, sicer ne vemo, kaj je obsegala.
        solid = ((row[3] >= 0.5 * shorter or row[3] >= 2000 or shared_code) and max(_km(first), _km(second)) <= 40
                 and bool(scope))
        if solid and wy and gap < wy and not phased and c2 not in ("gradnja", "drugo"):
            flags += "g"
            if firm_set(first) & firm_set(second):
                flags += "i"
        if (solid and RECONSTRUCTION.search(first["title"]) and c2 in SUBSTANCE and c2 in scope
                and gap < RECON_YEARS and not phased):
            flags += "r"
        # Široki vrsti (oprema, stavbe) združujeta zelo različna dela, zato ju pri »drugem imenu« ne štejemo.
        broad = ("gradnja", "drugo", "oprema", "stavbe")
        if solid and not same and first["cats"][0] not in broad and c2 not in broad and c2 in scope and ratio < 0.5:
            flags += "p"
        row.extend([wy, flags])


# --- statistični testi ---------------------------------------------------------------------------

def benford(values: list[float]) -> dict | None:
    digits = [int(str(int(v))[0]) for v in values if v and v >= 10]
    n = len(digits)
    if n < 50:
        return None
    counts = Counter(digits)
    observed = [counts.get(d, 0) / n for d in range(1, 10)]
    expected = [math.log10(1 + 1 / d) for d in range(1, 10)]
    mad = sum(abs(o - e) for o, e in zip(observed, expected)) / 9
    chi2 = sum((counts.get(d, 0) - n * e) ** 2 / (n * e) for d, e in zip(range(1, 10), expected))
    # Nigrini: MAD pod 0,006 tesna skladnost, do 0,012 sprejemljiva, do 0,015 mejna, nad tem neskladnost.
    verdict = "tesna" if mad < 0.006 else "sprejemljiva" if mad < 0.012 else "mejna" if mad < 0.015 else "neskladnost"
    return {"n": n, "obs": [round(o, 4) for o in observed], "exp": [round(e, 4) for e in expected],
            "mad": round(mad, 4), "chi2": round(chi2, 1), "verdict": verdict}


def shares(projects: list[dict]) -> dict[str, float]:
    out: dict[str, float] = defaultdict(float)
    for p in projects:
        if p["value"] and p["winners"]:
            keys = list(dict.fromkeys(firm_key(w) for w in p["winners"]))
            for k in keys:
                out[k] += p["value"] / len(keys)
    return out


def hhi(projects: list[dict]) -> float | None:
    s = shares(projects)
    total = sum(s.values())
    if not total:
        return None
    return round(sum((v / total) ** 2 for v in s.values()) * 10000)


def _value(p: dict) -> float:
    return p["value_final"] or p["value"] or 0


def _km(p: dict) -> float:
    return sum(max(0.0, b - a) for _, a, b in p.get("lr") or [])


def hotspots(projects: list[dict], roads: dict, axes: dict, step: float, limit: int = 15) -> list[dict]:
    """Odseki osi (po 1 km), na katerih je bilo največ pogodb; sosednji kilometri z istimi pogodbami so združeni."""
    cells: dict[tuple, set] = defaultdict(set)
    for p in projects:
        for ref, a, b in p.get("lr") or []:
            for k in range(int(a), max(int(a) + 1, math.ceil(b))):
                cells[(ref, k)].add(p["id"])
    by_id = {p["id"]: p for p in projects}
    segments = []
    for ref in sorted({r for r, _ in cells}):
        ks = sorted(k for r, k in cells if r == ref)
        run = None
        for k in ks:
            ids = cells[(ref, k)]
            if run and run["k1"] == k and run["ids"] == ids:
                run["k1"] = k + 1
                continue
            run = {"road": ref, "k0": k, "k1": k + 1, "ids": ids}
            segments.append(run)
    segments.sort(key=lambda s: (-len(s["ids"]), -sum(_value(by_id[i]) for i in s["ids"])))
    out = []
    for s in segments:
        if len(out) >= limit or len(s["ids"]) < 3:
            break
        if any(o["road"] == s["road"] and s["k0"] < o["km"][1] + 2 and o["km"][0] - 2 < s["k1"] for o in out):
            continue   # sosednji kos istega kupa
        ticks = roads.get(s["road"], {}).get("ticks", [])
        inside = [name for km, name in ticks if s["k0"] - 0.5 <= km <= s["k1"] + 0.5]
        before = [name for km, name in ticks if km < s["k0"]]
        after = [name for km, name in ticks if km > s["k1"]]
        name = inside[0] if inside else " – ".join(n for n in (before[-1] if before else None, after[0] if after else None) if n)
        pts = axes.get(s["road"]) or []
        mid = int(((s["k0"] + s["k1"]) / 2) / step)
        ll = pts[mid] if 0 <= mid < len(pts) else None
        ids = sorted(s["ids"], key=lambda i: by_id[i]["date"] or "")
        out.append({
            "road": s["road"], "km": [s["k0"], s["k1"]], "name": name, "ll": ll, "ids": ids,
            "n": len(ids), "precise": sum(1 for i in ids if by_id[i]["precision"] in ("km", "objekt")),
            "v": round(sum(_value(by_id[i]) for i in ids)),
            "years": [int(by_id[ids[0]]["date"][:4]), int(by_id[ids[-1]]["date"][:4])] if by_id[ids[0]]["date"] else None,
        })
    return out


SERIAL_DAYS = 90


def serial_awards(works: list[dict], label) -> list[dict]:
    """Več pogodb istemu izvajalcu za isto vrsto dela v 90 dneh, vsaka pod pragom, skupaj nad njim
    (možno drobljenje naročila, da bi se izognili strožjemu postopku)."""
    by_firm: dict[str, list[dict]] = defaultdict(list)
    for p in works:
        if p["value"] and p["date"] and p["phase"] in ("oddaja", "neposredna"):
            for k in firm_set(p):
                by_firm[k].append(p)
    def related(p: dict, q: dict) -> bool:
        """Isti kos ceste (do 10 km narazen) ali skoraj enako delo (»Izvedba odcejalnika Koseze / Hrušica«);
        dela v različnih regijah so naravno ločena naročila, ne drobljenje."""
        for ra, a0, a1 in p.get("lr") or []:
            for rb, b0, b1 in q.get("lr") or []:
                if ra == rb and a0 - 10 <= b1 and b0 - 10 <= a1:
                    return True
        return SequenceMatcher(None, norm_title(p["title"]), norm_title(q["title"])).ratio() >= 0.6

    groups: list[dict] = []
    for k, ps in by_firm.items():
        ps.sort(key=lambda p: p["date"])
        for t, name in THRESHOLDS:
            clusters: list[set] = []
            for i, p in enumerate(ps):
                if not 0.1 * t <= p["value"] < t:
                    continue
                group = [q for q in ps[i:] if 0.1 * t <= q["value"] < t and q["cats"][0] == p["cats"][0]
                         and (_days(p["date"], q["date"]) or 0) <= SERIAL_DAYS and (q is p or related(p, q))]
                # Sklopi istega postopka niso drobljenje (en razpis, več pogodb).
                if len(group) >= 2 and sum(q["value"] for q in group) >= t and len({q["dosje"] for q in group}) > 1:
                    ids = {q["id"] for q in group}
                    for c in [c for c in clusters if c & ids]:   # prekrivajoče se skupine združimo
                        ids |= c
                        clusters.remove(c)
                    clusters.append(ids)
            for ids in clusters:
                members = sorted((p for p in ps if p["id"] in ids), key=lambda p: p["date"])
                groups.append({"firm": label(k), "t": t, "name": name, "ids": [p["id"] for p in members],
                               "sum": round(sum(p["value"] for p in members)),
                               "days": int(_days(members[0]["date"], members[-1]["date"]) or 0)})
    return sorted(groups, key=lambda g: (-g["t"], -g["sum"]))[:40]


def market(works: list[dict], label, top: int = 8) -> dict:
    """Deleži izvajalcev v vrednosti gradenj po cestah (geografska delitev trga)."""
    road_val: dict[str, float] = defaultdict(float)
    cell: dict[tuple, list] = defaultdict(lambda: [0.0, []])
    firm_total: dict[str, float] = defaultdict(float)
    for p in works:
        refs = sorted({r for r, _, _ in p.get("lr") or []}) or p.get("roads") or []
        keys = firm_set(p)
        if not refs or not keys or not p["value"]:
            continue
        part = p["value"] / len(refs) / len(keys)
        for r in refs:
            road_val[r] += p["value"] / len(refs)
            for k in keys:
                cell[(r, k)][0] += part
                cell[(r, k)][1].append(p["id"])
                firm_total[k] += part
    count = Counter(r for (r, _), c in cell.items() for _ in c[1])
    roads = [r for r, v in sorted(road_val.items(), key=lambda kv: -kv[1]) if count[r] >= 5 and v > 0][:10]
    firms = [k for k, _ in sorted(firm_total.items(), key=lambda kv: -kv[1])[:top]]
    rows = []
    for r in roads:
        shares = {k: c[0] / road_val[r] for (rr, k), c in cell.items() if rr == r}
        lead = max(shares, key=shares.get)
        n = len({i for (rr, _), c in cell.items() if rr == r for i in c[1]})
        rows.append({
            "road": r, "v": round(road_val[r]), "n": n,
            "hhi": round(sum(s * s for s in shares.values()) * 10000),
            "lead": label(lead), "lead_share": round(shares[lead], 3),
            "cells": [[round(shares.get(k, 0), 3), sorted(set(cell[(r, k)][1])) if (r, k) in cell else []] for k in firms],
        })
    return {"firms": [label(k) for k in firms], "keys": firms, "rows": rows}


def forensics(projects: list[dict], pairs: list[list], splits: list[list], contracts: list[dict],
              roads: dict | None = None, axes: dict | None = None, step: float = 0.2) -> dict:
    works = [p for p in projects if p["phase"] != "aneksi"]
    by_id = {p["id"]: p for p in projects}
    names: dict[str, Counter] = defaultdict(Counter)
    for p in projects:
        for w in p["winners"]:
            names[firm_key(w)][short_firm(w)] += 1

    def label(key):
        return names[key].most_common(1)[0][0] if names.get(key) else key

    # Razmerje pogodbena / ocenjena vrednost: kopičenje tik pod 1 je znak dogovarjanja ponudnikov.
    ratios = [[p["id"], round(p["value"] / p["estimate"], 3)] for p in works
              if p["value"] and p["estimate"] and 0.2 < p["value"] / p["estimate"] < 3]
    # Rast vrednosti z aneksi.
    growth = [[p["id"], round(p["value_final"] / p["value"] - 1, 3)] for p in projects
              if p["value"] and p["value_final"] and p["value_final"] != p["value"]]
    reg_growth = []
    for p in projects:
        for r in p.get("register") or []:
            added = [a["v"] for a in r["annexes"] if a.get("v")]
            if r.get("value") and added:
                # Dodatek navaja znesek spremembe; zapis, ki je skoraj enak pogodbi, je nova skupna vrednost.
                delta = sum(v - r["value"] if v >= 0.95 * r["value"] else v for v in added)
                reg_growth.append([p["id"], round(delta / r["value"], 3), len(r["annexes"])])

    years = sorted({int(p["date"][:4]) for p in works if p["date"]})
    by_year = defaultdict(list)
    for p in works:
        if p["date"]:
            by_year[int(p["date"][:4])].append(p)
    single = {y: [sum(1 for p in ps if p["bids"] == 1), sum(1 for p in ps if p["bids"]),
                  [p["id"] for p in ps if p["bids"] == 1]] for y, ps in by_year.items()}
    concentration = {y: hhi(ps) for y, ps in by_year.items()}
    hhi_top = {}
    for y, ps in by_year.items():
        s = shares(ps)
        total_y = sum(s.values())
        if total_y:
            hhi_top[y] = [[label(k), round(v / total_y, 3), [p["id"] for p in ps if k in firm_set(p)]]
                          for k, v in sorted(s.items(), key=lambda kv: -kv[1])[:6]]
    # Neposredne oddaje (brez predhodne objave) in časovni vzorci podpisa.
    direct = {y: [sum(1 for p in ps if p["phase"] == "neposredna"), len(ps),
                  round(sum(p["value"] or 0 for p in ps if p["phase"] == "neposredna")),
                  [p["id"] for p in ps if p["phase"] == "neposredna"]] for y, ps in by_year.items()}
    direct_reason = {p["id"]: p.get("reason") or "razlog ni razviden" for p in works if p["phase"] == "neposredna"}
    months = {m: [0, 0, []] for m in range(1, 13)}
    for p in works:
        if p["date"]:
            row = months[int(p["date"][5:7])]
            row[0] += 1
            row[1] += round(p["value"] or 0)
            row[2].append(p["id"])
    # Čas od pogodbe do prve objavljene spremembe (zgodnji aneks lahko pomeni prenizko ponudbo).
    annex_speed = []
    for p in works:
        dates = [m["date"] for m in p["mods"] if m.get("date")]
        if p["date"] and dates and p["phase"] in ("oddaja", "neposredna"):
            d = (date.fromisoformat(min(dates)[:10]) - date.fromisoformat(p["date"][:10])).days
            if d >= 0:
                annex_speed.append([p["id"], d])
    # Cena na kilometer osi za dela, ki se merijo v dolžini (le natančno umeščena po kilometrih).
    unit_cost = []
    for p in works:
        km = _km(p)
        if p["precision"] == "km" and p["value"] and km >= 0.3 and p["cats"][0] in ("vozisce", "ograje", "hrup"):
            unit_cost.append([p["id"], round(km, 2), round(p["value"]), p["cats"][0], len(p.get("dirs") or ())])

    total = shares(works)
    top = [k for k, _ in sorted(total.items(), key=lambda kv: -kv[1])[:16]]
    rotation = {"firms": [label(k) for k in top], "keys": top, "years": years, "cells": []}
    for y in years:
        row = []
        for k in top:
            ps = [p for p in by_year[y] if k in firm_set(p)]
            row.append([len(ps), round(sum((p["value"] or 0) / max(1, len(firm_set(p))) for p in ps)), [p["id"] for p in ps]])
        rotation["cells"].append(row)

    # Kazalniki po izvajalcih.
    firms: dict[str, dict] = {}

    def firm(k):
        if k not in firms:
            firms[k] = {"k": k, "n": label(k), "c": 0, "v": 0.0, "single": 0, "bids": 0, "ratio": [], "growth": [],
                        "redone": 0, "redid": 0, "own": 0, "split": 0, "partners": set(), "subs": set(), "y": [],
                        "ids": [], "pg": [], "pi": [], "ps": []}
        return firms[k]

    for p in works:
        keys = firm_set(p)
        for k in keys:
            f = firm(k)
            f["ids"].append(p["id"])
            f["c"] += 1
            f["v"] += (p["value"] or 0) / max(1, len(keys))
            f["bids"] += bool(p["bids"])
            f["single"] += p["bids"] == 1
            if p["value"] and p["estimate"]:
                f["ratio"].append(p["value"] / p["estimate"])
            if p["value"] and p["value_final"] and p["value_final"] != p["value"]:
                f["growth"].append(p["value_final"] / p["value"] - 1)
            f["partners"] |= keys - {k}
            f["subs"] |= {firm_key(s) for s in p.get("subs") or []}
            if p["date"]:
                f["y"].append(int(p["date"][:4]))
    for a, b, gap, overlap, same, wy, flags in pairs:
        if "g" in flags:
            for k in firm_set(by_id[a]):
                firm(k)["redone"] += 1
                firm(k)["pg"].append([a, b])
            for k in firm_set(by_id[b]):
                firm(k)["redid"] += 1
            if "i" in flags:
                for k in firm_set(by_id[a]) & firm_set(by_id[b]):
                    firm(k)["own"] += 1
                    firm(k)["pi"].append([a, b])
    for a, b, *_ in splits:
        for k in firm_set(by_id[a]) | firm_set(by_id[b]):
            firm(k)["split"] += 1
            firm(k)["ps"].append([a, b])

    table = []
    for f in firms.values():
        if f["c"] < 2:
            continue
        ratio = statistics.median(f["ratio"]) if f["ratio"] else None
        growth_med = statistics.median(f["growth"]) if f["growth"] else None
        flags = []
        if f["bids"] >= 3 and f["single"] / f["bids"] >= 0.4:
            flags.append("ena ponudba")
        if ratio and len(f["ratio"]) >= 3 and 0.97 <= ratio <= 1.03:
            flags.append("tik ob oceni")
        if growth_med is not None and len(f["growth"]) >= 2 and growth_med > 0.15:
            flags.append("aneksi")
        if f["redone"]:
            flags.append("ponovljeno v garanciji")
        if f["own"]:
            flags.append("svoje delo v garanciji")
        if f["split"] >= 2:
            flags.append("razdrobljena naročila")
        table.append({
            "k": f["k"], "n": f["n"], "c": f["c"], "v": round(f["v"]), "single": f["single"], "bids": f["bids"],
            "ratio": round(ratio, 3) if ratio else None, "growth": round(growth_med, 3) if growth_med is not None else None,
            "redone": f["redone"], "redid": f["redid"], "own": f["own"], "split": f["split"],
            "partners": len(f["partners"]), "subs": len(f["subs"] - {f["k"]}),
            "y": [min(f["y"]), max(f["y"])] if f["y"] else None, "flags": flags,
            "ids": f["ids"], "pg": f["pg"], "pi": f["pi"], "ps": f["ps"],
        })
    table.sort(key=lambda f: (-len(f["flags"]), -f["v"]))

    values = [[p["id"], round(p["value"])] for p in works if p["value"]]
    bunching = []
    for t, name in THRESHOLDS:
        below = sum(1 for _, v in values if 0.9 * t <= v < t)
        above = sum(1 for _, v in values if t <= v < 1.1 * t)
        bunching.append({"t": t, "name": name, "below": below, "above": above})
    # Zneski aneksov z objavo, iz katere so: [projekt, znesek, povezava].
    annex_amounts = []
    for p in projects:
        for m in p["mods"]:
            if m.get("add"):
                annex_amounts.append([p["id"], round(m["add"]), m.get("url")])
            elif m.get("after") and m.get("before") and m["after"] > m["before"]:
                annex_amounts.append([p["id"], round(m["after"] - m["before"]), m.get("url")])
    round_share = (sum(1 for _, v, _ in annex_amounts if v % 1000 == 0) / len(annex_amounts)) if annex_amounts else None

    flag_counts = Counter(ch for row in pairs for ch in row[6])
    flag_value = {ch: round(sum(by_id[row[1]]["value"] or 0 for row in pairs if ch in row[6])) for ch in "girp"}
    return {
        "benford": {"award": benford([v for _, v in values]), "annex": benford([v for _, v, _ in annex_amounts])},
        "ratios": ratios,
        "growth": growth,
        "reg_growth": reg_growth,
        "single": single,
        "hhi": concentration,
        "hhi_top": hhi_top,
        "rotation": rotation,
        "firms": table[:120],
        "values": values,
        "annex_amounts": annex_amounts,
        "thresholds": bunching,
        "round_annex": round(round_share, 3) if round_share is not None else None,
        "flags": {"count": dict(flag_counts), "value": flag_value, "splits": len(splits)},
        "hotspots": hotspots(projects, roads or {}, axes or {}, step),
        "direct": direct,
        "direct_reason": direct_reason,
        "months": months,
        "annex_speed": annex_speed,
        "unit_cost": unit_cost,
        "serial": serial_awards(works, label),
        "market": market(works, label),
    }


# --- mreža izvajalcev, partnerjev, podizvajalcev in naročnikov ------------------------------------

KINDS = {1: "storitve", 2: "blago", 3: "gradnje"}


def network(projects: list[dict], contracts: list[dict]) -> dict:
    nodes: dict[str, dict] = {}
    edges: dict[tuple, list] = {}
    names: dict[str, Counter] = defaultdict(Counter)

    def node(key, name, kind="firm"):
        names[key][short_firm(name) if kind == "firm" else name] += 1
        if key not in nodes:
            nodes[key] = {"id": key, "t": kind, "v": 0.0, "c": 0, "k": set(), "r": set(), "y": set(), "full": Counter()}
        nodes[key]["full"][name] += 1
        return nodes[key]

    def edge(a, b, kind, value):
        if a == b:
            return
        if kind == "partner" and a > b:
            a, b = b, a
        e = edges.setdefault((a, b, kind), [a, b, kind, 0, 0.0])
        e[3] += 1
        e[4] += value or 0

    buyer = "DARS"
    node(buyer, "DARS d.d.", "buyer")
    linked_ids = set()

    def deal(contractors, value, year, kind, subs=(), buyers=()):
        keys = list(dict.fromkeys(firm_key(n) for n in contractors if n and not BUYER.search(n)))
        for n in contractors:
            if n and not BUYER.search(n):
                f = node(firm_key(n), n)
                f["v"] += (value or 0) / max(1, len(keys))
                f["c"] += 1
                f["k"].add(kind)
                f["r"].add("izvajalec" if len(keys) == 1 else "partner")
                if year:
                    f["y"].add(year)
        for k in keys:
            edge(buyer, k, "narocnik", (value or 0) / max(1, len(keys)))
        for i, a in enumerate(keys):
            for b in keys[i + 1:]:
                edge(a, b, "partner", value)
        for s in subs:
            sk = firm_key(s)
            sn = node(sk, s)
            sn["r"].add("podizvajalec")
            sn["k"].add(kind)
            for k in keys:
                edge(k, sk, "podizvajalec", 0)
        for b in buyers:
            if b and not BUYER.search(b):
                bk = "N:" + b.upper()
                node(bk, b, "buyer")
                for k in keys:
                    edge(bk, k, "narocnik", (value or 0) / max(1, len(keys)))

    for p in projects:
        year = int(p["date"][:4]) if p["date"] else None
        co_buyers = []
        for r in p.get("register") or []:
            linked_ids.add(r["id"])
            co_buyers += [b for b in r.get("buyers") or [] if b not in co_buyers]
        deal(p["winners"], p["value"], year, "gradnje", p.get("subs") or [], co_buyers)
    for c in contracts:
        m = c["meta"]
        if m.get("type") != "POG" or m["id"] in linked_ids:
            continue
        year = int(m["signed"][:4]) if m.get("signed") else None
        deal(m.get("contractors") or [], m.get("value"), year, KINDS.get(m.get("kind"), "drugo"),
             (), m.get("buyers") or [])

    # Skupnosti (label propagation) le po povezavah med podjetji.
    adj = defaultdict(lambda: defaultdict(float))
    for a, b, kind, count, value in edges.values():
        if kind in ("partner", "podizvajalec"):
            adj[a][b] += count
            adj[b][a] += count
    labels = {k: k for k in adj}
    for _ in range(20):
        changed = False
        for k in sorted(adj, key=lambda x: (-len(adj[x]), x)):
            score = defaultdict(float)
            for other, w in adj[k].items():
                score[labels[other]] += w
            best = max(sorted(score), key=lambda l: score[l])
            if best != labels[k]:
                labels[k], changed = best, True
        if not changed:
            break
    groups = Counter(labels.values())
    group_ids = {g: i + 1 for i, (g, n) in enumerate(groups.most_common()) if n >= 3}

    out_nodes = []
    for key, n in nodes.items():
        out_nodes.append({
            "id": key, "n": names[key].most_common(1)[0][0], "f": n["full"].most_common(1)[0][0], "t": n["t"],
            "v": round(n["v"]), "c": n["c"], "k": sorted(n["k"]), "r": sorted(n["r"]),
            "y": [min(n["y"]), max(n["y"])] if n["y"] else None, "g": group_ids.get(labels.get(key), 0),
        })
    out_edges = [[a, b, kind, count, round(value)] for a, b, kind, count, value in edges.values()]
    return {"nodes": out_nodes, "edges": out_edges}
