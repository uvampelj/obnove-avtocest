"""Umestitev odsekov iz besedila objav na os avtoceste (OpenStreetMap).

DARS v objavah navaja ceste (A1, H4), šifre odsekov (0036, desna smer 0636), imena
odsekov po priključkih (»Fram–Slovenska Bistrica«) in kilometre znotraj odseka
(»od km 0,500 do km 4,200«). Imena priključkov poiščemo med priključki v OSM,
pot med njima po osi ceste, kilometre pa odmerimo od prvega priključka.
Lega je zato približna, natančnost je zapisana pri vsakem zapisu.
"""
from __future__ import annotations

import heapq
import math
import re
import unicodedata
from collections import defaultdict

ROADS = r"[AH][1-7]"
LON_M = 111320 * math.cos(math.radians(46.1))
LAT_M = 110540

STOP = {
    "razcep", "prikljucek", "prikljucka", "prikljucku", "prikljuckom", "pr", "cp", "cestninska", "postaja",
    "pocivalisce", "rondo", "krozisce", "avtocesta", "avtoceste", "odsek", "odseka", "ac", "hc", "na", "do",
    "deviacija", "obvoznica", "kamionska", "cesta", "ii", "i",
}
SIDES = {"vzhod", "zahod", "sever", "jug", "center", "vzhodni", "zahodni", "severni", "juzni"}


def norm(name: str) -> tuple[str, str]:
    s = name.split("/")[0]
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    words = [w for w in s.split() if w not in STOP]
    side = next((w for w in words if w in SIDES), "")
    base = " ".join(w for w in words if w not in SIDES)
    return base, side[:3]


def dist(a, b) -> float:
    return math.hypot((a[0] - b[0]) * LON_M, (a[1] - b[1]) * LAT_M)


class Network:
    def __init__(self, osm: dict):
        self.coord: dict[int, tuple[float, float]] = {}
        self.adj: dict[int, list[tuple[int, float]]] = defaultdict(list)
        self.node_refs: dict[int, set[str]] = defaultdict(set)
        self.road_nodes: dict[str, list[int]] = defaultdict(list)
        self.structures: list[dict] = []
        self.node_way: dict[int, tuple[list, int]] = {}
        for way in osm["ways"]:
            ids, coords = way["nodes"], way["coords"]
            if len(ids) != len(coords):
                continue
            for k, (nid, c) in enumerate(zip(ids, coords)):
                self.node_way.setdefault(nid, (coords, k))
                if nid not in self.coord:
                    self.coord[nid] = (c[0], c[1])
                if way["ref"] not in self.node_refs[nid]:
                    self.node_refs[nid].add(way["ref"])
                    self.road_nodes[way["ref"]].append(nid)
            for a, b in zip(ids, ids[1:]):
                d = dist(self.coord[a], self.coord[b])
                self.adj[a].append((b, d))
                self.adj[b].append((a, d))
            label = way.get("bridge_name") or way.get("tunnel_name") or (way["name"] if way["bridge"] or way["tunnel"] else "")
            if label:
                self.structures.append({"base": norm(label)[0], "label": label, "ref": way["ref"], "coords": coords})

        # Ceste se v OSM stikajo prek priključnih krakov, ki jih ne nalagamo. Konec ceste zato
        # povežemo z najbližjim vozliščem druge ceste (do 600 m), da poti tečejo npr. z A1 na H4.
        grid = defaultdict(list)
        for nid, (x, y) in self.coord.items():
            grid[(int(x * LON_M // 600), int(y * LAT_M // 600))].append(nid)
        for nid, edges in list(self.adj.items()):
            if len(edges) != 1:
                continue
            x, y = self.coord[nid]
            cx, cy = int(x * LON_M // 600), int(y * LAT_M // 600)
            best, best_d = None, 600.0
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other in grid[(cx + dx, cy + dy)]:
                        if self.node_refs[other] & self.node_refs[nid]:
                            continue
                        d = dist(self.coord[nid], self.coord[other])
                        if d < best_d:
                            best, best_d = other, d
            if best is not None:
                self.adj[nid].append((best, best_d))
                self.adj[best].append((nid, best_d))

        self.junctions = []
        for j in osm["junctions"]:
            if not j["name"] or j["id"] not in self.coord:
                continue
            base, side = norm(j["name"])
            if base:
                self.junctions.append({"base": base, "side": side, "node": j["id"], "name": j["name"],
                                       "refs": self.node_refs[j["id"]], "pt": self.coord[j["id"]]})
        self.places = []
        for p in osm["places"]:
            base, side = norm(p["name"])
            if base:
                self.places.append({"base": base, "side": side, "name": p["name"], "pt": (p["lon"], p["lat"])})

    # --- iskanje imen -----------------------------------------------------------------------

    @staticmethod
    def match(query: str, target: str) -> int:
        """Ujemanje imen: 4 enako, 3 začetek ali okrajšave (»slov bistrica«), 2 delno, 0 ne."""
        if target == query:
            return 4
        if target.startswith(query + " ") or query.startswith(target + " "):
            return 3
        q, t = query.split(), target.split()
        if len(q) == len(t) and all(len(a) >= 2 and b.startswith(a) for a, b in zip(q, t)):
            return 3
        if len(query) >= 5 and (target.startswith(query) or query.startswith(target)):
            return 2
        return 0

    def candidates(self, name: str, road: str | None) -> list[dict]:
        base, side = norm(name)
        if not base or len(base) < 3:
            return []
        out = []
        for j in self.junctions:
            if road and road not in j["refs"]:
                continue
            score = self.match(base, j["base"])
            if not score:
                continue
            if side and j["side"] == side:
                score += 1
            out.append({"node": j["node"], "pt": j["pt"], "score": score, "label": j["name"]})
        if out:
            return out
        for p in self.places:
            if self.match(base, p["base"]) < 3:
                continue
            node = self.snap(p["pt"], road, 5000)
            if node is not None:
                out.append({"node": node, "pt": self.coord[node], "score": 1, "label": p["name"]})
        return out

    def snap(self, pt, road: str | None, limit: float) -> int | None:
        pool = self.road_nodes[road] if road else self.coord.keys()
        best, best_d = None, limit
        for nid in pool:
            d = dist(pt, self.coord[nid])
            if d < best_d:
                best, best_d = nid, d
        return best

    def structure(self, name: str, road: str | None) -> list | None:
        base = norm(name)[0]
        if len(base) < 4:
            return None
        hits = [s for s in self.structures if (s["base"] == base or s["base"].startswith(base + " ")
                or s["base"].endswith(" " + base) or (" " + base + " ") in (" " + s["base"] + " "))
                and (road is None or s["ref"] == road)]
        if not hits:
            return None
        return [h["coords"] for h in hits]

    def around(self, node: int, half: float):
        """Del osi ceste dolžine 2 × half okoli vozlišča."""
        if node not in self.node_way:
            return None
        coords, k = self.node_way[node]
        at = length(coords[: k + 1])
        return cut(coords, max(0.0, at - half), at + half)

    # --- poti --------------------------------------------------------------------------------

    def path(self, a: int, b: int, road: str | None, limit: float = 80000) -> list[int] | None:
        if a == b:
            return None
        best = {a: 0.0}
        prev: dict[int, int] = {}
        heap = [(0.0, a)]
        while heap:
            d, n = heapq.heappop(heap)
            if n == b:
                break
            if d > best.get(n, math.inf) or d > limit:
                continue
            for m, w in self.adj[n]:
                if road and road not in self.node_refs[m]:
                    continue
                nd = d + w
                if nd < best.get(m, math.inf):
                    best[m] = nd
                    prev[m] = n
                    heapq.heappush(heap, (nd, m))
        if b not in prev:
            return None
        out = [b]
        while out[-1] != a:
            out.append(prev[out[-1]])
        return out[::-1]

    def between(self, name_a: str, name_b: str, road: str | None):
        """Pot po osi ceste med dvema imenovanima mestoma, ali None."""
        ca, cb = self.candidates(name_a, road), self.candidates(name_b, road)
        if not ca or not cb:
            return None
        pairs = sorted(
            ((dist(x["pt"], y["pt"]) - 400 * (x["score"] + y["score"]), x, y) for x in ca for y in cb
             if x["node"] != y["node"] and dist(x["pt"], y["pt"]) > 300),
            key=lambda t: t[0],
        )
        for _, x, y in pairs[:6]:
            nodes = self.path(x["node"], y["node"], road, limit=40000)
            if not nodes:
                continue
            line = [self.coord[n] for n in nodes]
            straight = dist(x["pt"], y["pt"])
            # Odseki DARS so dolgi do ~25 km in skoraj ravni; ovinek pomeni napačno ujemanje imen.
            if length(line) > max(2.2 * straight, straight + 3000) or length(line) > 35000:
                continue
            return line, (x["label"], y["label"])
        return None


def length(line) -> float:
    return sum(dist(a, b) for a, b in zip(line, line[1:]))


def cut(line, d0: float, d1: float):
    """Del črte med razdaljama d0 in d1 (m) od začetka."""
    if d1 < d0:
        d0, d1 = d1, d0
    out, run = [], 0.0
    for a, b in zip(line, line[1:]):
        seg = dist(a, b)
        if seg == 0:
            continue
        lo, hi = run, run + seg
        if hi >= d0 and lo <= d1:
            t0 = max(0.0, (d0 - lo) / seg)
            t1 = min(1.0, (d1 - lo) / seg)
            p0 = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
            p1 = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
            if not out:
                out.append(p0)
            out.append(p1)
        run = hi
        if run > d1:
            break
    return out if len(out) >= 2 else None


def simplify(line, tolerance: float = 12.0):
    if len(line) < 3:
        return line
    keep = [False] * len(line)
    keep[0] = keep[-1] = True
    stack = [(0, len(line) - 1)]
    while stack:
        i, j = stack.pop()
        a, b = line[i], line[j]
        ax, ay, bx, by = a[0] * LON_M, a[1] * LAT_M, b[0] * LON_M, b[1] * LAT_M
        dx, dy = bx - ax, by - ay
        den = math.hypot(dx, dy) or 1e-9
        worst, idx = 0.0, None
        for k in range(i + 1, j):
            px, py = line[k][0] * LON_M, line[k][1] * LAT_M
            d = abs(dy * px - dx * py + bx * ay - by * ax) / den
            if d > worst:
                worst, idx = d, k
        if idx is not None and worst > tolerance:
            keep[idx] = True
            stack += [(i, idx), (idx, j)]
    return [p for p, k in zip(line, keep) if k]


# --- branje lokacij iz besedila -----------------------------------------------------------

# Šifra odseka: štiri števke, ki se začnejo z 0 ali 1 (»0036«, »A2/0620«, »0002/0602«).
# Izključene so številke pogodb (»1075/2022«), deli daljših števil in decimalke.
CODE = re.compile(rf"(?:\b(?:AC|HC)?({ROADS}|(?<=AC)[1-5]|(?<=HC)[2-7])\s*[/-]\s*)?(?<![\w.,])([01]\d{{3}})(?![\w.,]|/(?:19|20)\d\d)")
# Ime kraja: besede z veliko začetnico in nekaj povezovalnih besed. Pri naslovih v velikih
# črkah (»HRUŠICA - VRBA OD KM 5,544«) se ime ne sme nadaljevati v »OD KM«.
NOT_NAME = r"(?!(?i:od|do|km|in|ter|za|z|s|vključno|vkljucno|sifra|šifra|nuts|sklop|lot|faza|etapa)\b)"
WORD = NOT_NAME + r"[A-ZČŠŽĆĐ][\wčšžćđČŠŽĆĐ.]*"
NAME = WORD + r"(?:[ ]+(?:" + WORD + r"|vas|v|pri|na|ob|polje|polju|gorica|goricah|sever|jug|vzhod|zahod|center|toplice)(?!\w)){0,4}"
PAIR = re.compile(rf"({NAME})\s*[-–—]\s*({NAME})")
KM = re.compile(r"(?:od\s*)?km\s*(\d+)\s*[,.+]\s*(\d+)\s*(?:do|-|–)\s*(?:km\s*)?(\d+)\s*[,.+]\s*(\d+)", re.I)
# Cesta mora biti navedena kot cesta (»AC A1«, »avtoceste A2«, »A1/0036«, »H4 0379«), ker sta
# npr. H1 in H2 tudi razreda zadrževanja varnostnih ograj.
ROAD_TOKEN = re.compile(
    r"\b(?:AC|HC|avtocest\w*|hitr\w* cest\w*)\s*-?\s*(A[1-5]|H[2-7])\b|\b(A[1-5]|H[2-7])\s*[/-]?\s*[01]\d{3}\b|\bAC ?([1-5])\s*/"
)
STRUCT = re.compile(
    r"\b(viadukt\w*|most\w*|predor\w*|galerij\w*|nadvoz\w*|podvoz\w*|pokrit\w* vkop\w*)\s+"
    r"((?:[A-ZČŠŽĆĐ][\wčšžćđ]+)(?:[ -](?:[A-ZČŠŽĆĐ][\wčšžćđ]+|pri|na|v))*)"
)
MARKER = re.compile(r"\b(?:AC|HC|avtocest\w*|hitr\w* cest\w*|odsek\w*)\b", re.I)
SINGLE = re.compile(
    r"\b(?i:priključ\w*|razcep\w*|počivališč\w*|cestninsk\w* postaj\w*|predor\w*|viadukt\w*|most\w*|"
    r"nadvoz\w*|podvoz\w*|galerij\w*|pokrit\w* vkop\w*)\s+(" + NAME + r")"
)
CITY_PREFIX = re.compile(r"^\s*[:–-]?\s*(?:LJ\.?|Lj\.?|MB|Ljubljana|Maribor)\s*\(", re.I)


def clean_name(name: str) -> str:
    name = re.sub(rf"\b(?:AC|HC|{ROADS})\b\s*", "", name)
    name = re.sub(r"\b(?:VA|NA|PO|PR)\s?\d+\S*", "", name)  # oznake objektov (VA0143-L)
    return name.strip(" .,;()–-")


def km_value(whole: str, frac: str) -> float:
    return float(f"{whole}.{frac}")


def base_code(code: int) -> int:
    return code - 600 if 600 <= code < 1200 else code


def is_year(code: str) -> bool:
    return code.startswith("19")


def read(text: str) -> dict:
    """Ceste, šifre odsekov z imeni in kilometri ter imena objektov v besedilu."""
    roads = []
    for m in ROAD_TOKEN.finditer(text):
        road = m.group(1) or m.group(2) or f"A{m.group(3)}"
        if road not in roads:
            roads.append(road)

    mentions = []  # {pos, road, codes, names, km}
    for m in CODE.finditer(text):
        code = m.group(2)
        if is_year(code):
            continue
        road = m.group(1)
        if road and road.isdigit():  # »AC1/0031« → A1
            road = ("A" if text[m.start(1) - 2: m.start(1)] == "AC" else "H") + road
        if mentions and m.start() - mentions[-1]["end"] <= 8:
            # »0036 in 0636« ali »0002/0602«: druga šifra istega odseka
            mentions[-1]["codes"].append(int(code))
            mentions[-1]["end"] = m.end()
            mentions[-1]["road"] = mentions[-1]["road"] or road
            continue
        mentions.append({"pos": m.start(), "end": m.end(), "road": road, "codes": [int(code)], "names": None, "km": None})

    for i, mention in enumerate(mentions):
        tail = text[mention["end"]: mention["end"] + 120]
        stop = len(tail)
        if i + 1 < len(mentions):
            stop = min(stop, mentions[i + 1]["pos"] - mention["end"])
        tail = CITY_PREFIX.sub("", tail[:stop])
        pm = PAIR.match(tail.lstrip(" :–-"))
        if pm:
            a, b = clean_name(pm.group(1)), clean_name(pm.group(2))
            if a and b:
                mention["names"] = (a, b)

    # Odseki, navedeni le z imeni (»na AC Turnišče-Razcep Dolga vas, Dolga vas-Lendava«).
    named = {m["names"] for m in mentions if m["names"]}
    for marker in MARKER.finditer(text):
        chunk = text[marker.end(): marker.end() + 260]
        for pm in PAIR.finditer(chunk):
            names = (clean_name(pm.group(1)), clean_name(pm.group(2)))
            if not all(names):
                continue
            start = marker.end() + pm.start()
            inside = any(m["pos"] <= start <= m["end"] + 120 and m["names"] for m in mentions)
            if names in named or inside:
                continue
            named.add(names)
            mentions.append({"pos": start, "names": names, "road": None, "codes": [], "km": None,
                             "end": marker.end() + pm.end()})
    mentions.sort(key=lambda m: m["pos"])

    for m in KM.finditer(text):
        k0, k1 = km_value(m.group(1), m.group(2)), km_value(m.group(3), m.group(4))
        if k1 - k0 > 60 or k1 <= k0:
            continue
        owner = None
        for mention in mentions:
            if mention["pos"] <= m.start():
                owner = mention
        if owner is not None:
            if owner["km"] is None:
                owner["km"] = [k0, k1]
            else:  # več razponov na istem odseku: vzamemo ovojnico
                owner["km"] = [min(owner["km"][0], k0), max(owner["km"][1], k1)]

    # Isti odsek je pogosto naveden v naslovu brez kilometrov in v opisu s kilometri.
    with_km = {(tuple(m["codes"]), m["names"]) for m in mentions if m["km"]}
    unique, seen = [], set()
    for m in mentions:
        key = (tuple(m["codes"]), m["names"])
        if (m["km"] is None and key in with_km) or (key, tuple(m["km"] or ())) in seen:
            continue
        seen.add((key, tuple(m["km"] or ())))
        unique.append(m)
    mentions = unique

    structures = []
    for m in STRUCT.finditer(text):
        name = m.group(2).strip()
        if name not in structures:
            structures.append(name)
    places = []
    for m in SINGLE.finditer(text):
        name = clean_name(m.group(1))
        if name and name not in places:
            places.append(name)
    return {"roads": roads, "mentions": mentions, "structures": structures, "places": places}


class Locator:
    def __init__(self, network: Network):
        self.net = network
        self.code_names: dict[int, dict[tuple, int]] = defaultdict(lambda: defaultdict(int))
        self.code_road: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))

    def learn(self, info: dict):
        """Zbere imena odsekov pri šifrah iz vseh objav, da lahko umestimo tudi šifre brez imen."""
        default_road = info["roads"][0] if len(info["roads"]) == 1 else None
        for mention in info["mentions"]:
            for code in mention["codes"]:
                base = base_code(code)
                if mention["names"]:
                    self.code_names[base][mention["names"]] += 1
                road = mention["road"] or default_road
                if road:
                    self.code_road[base][road] += 1

    def locate(self, info: dict):
        """Vrne (seznam črt, natančnost, opis odsekov) ali (None, None, [])."""
        lines, sections, precision = [], [], None
        default_road = info["roads"][0] if len(info["roads"]) == 1 else None
        for mention in info["mentions"]:
            base = base_code(mention["codes"][0]) if mention["codes"] else None
            road = mention["road"] or default_road
            if road is None and base is not None and self.code_road[base]:
                road = max(self.code_road[base].items(), key=lambda kv: kv[1])[0]
            names = mention["names"]
            if names is None and base is not None and self.code_names[base]:
                names = max(self.code_names[base].items(), key=lambda kv: kv[1])[0]
            if names is None:
                continue
            found = self._between(names, road)
            if found is None and road is not None:
                found = self._between(names, None)
            if found is None:
                continue
            line, labels = found
            km = mention["km"]
            part = None
            if km:
                total = length(line)
                if km[0] * 1000 < total * 1.25:
                    part = cut(line, km[0] * 1000, min(km[1] * 1000, total))
            if part:
                lines.append(part)
                precision = "km" if precision in (None, "km") else precision
            else:
                lines.append(line)
                precision = "odsek"
            sections.append({
                "road": road, "codes": mention["codes"], "a": labels[0], "b": labels[1],
                "km": km, "named": list(names),
            })
        if not lines:
            for name in info["structures"]:
                hit = self.net.structure(name, default_road)
                if hit:
                    lines.extend(hit)
                    precision = "objekt"
                    sections.append({"road": default_road, "codes": [], "a": name, "b": None, "km": None, "named": [name]})
        if not lines:
            # Posamezen priključek, razcep ali objekt brez para: kratek odsek okoli njega.
            for name in info.get("places", []):
                found = self.net.candidates(name, default_road) or (self.net.candidates(name, None) if default_road else [])
                if not found:
                    continue
                best = max(found, key=lambda c: c["score"])
                piece = self.net.around(best["node"], 200)
                if piece:
                    lines.append(piece)
                    precision = "kraj"
                    sections.append({"road": default_road, "codes": [], "a": best["label"], "b": None, "km": None, "named": [name]})
        if not lines:
            return None, None, []
        if sum(length(line) for line in lines) > 80000:
            # Pogodba za velik del omrežja (npr. vse ograje na območju več AC baz): črta bi zavajala.
            return None, None, sections
        return [simplify(line) for line in lines], precision, sections

    def _between(self, names, road):
        key = (names, road)
        if not hasattr(self, "_cache"):
            self._cache = {}
        if key not in self._cache:
            self._cache[key] = self._between_uncached(names, road)
        return self._cache[key]

    def _between_uncached(self, names, road):
        a, b = names
        found = self.net.between(a, b, road)
        if found:
            return found
        # Ime s pomišljajem (»Šmarje-Sap«) je lahko eno samo ime: poskusi še druge delitve.
        joined = f"{a}-{b}"
        parts = re.split(r"\s*[-–—]\s*", joined)
        if len(parts) > 2:
            for i in range(1, len(parts)):
                x, y = "-".join(parts[:i]), "-".join(parts[i:])
                if (x, y) != (a, b):
                    found = self.net.between(x, y, road)
                    if found:
                        return found
        return None
