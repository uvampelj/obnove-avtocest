"""Linearno referenciranje: položaj del vzdolž avtoceste v kilometrih (za prostorsko-časovni diagram).

Za vsako cesto (A1, A2 …) poiščemo oba konca osi in razdaljo vsakega vozlišča od začetka po osi.
Začetek je severnejši konec (A1 Šentilj, A2 Karavanke, A4 Slivnica). Kilometri so izračunani iz
OpenStreetMap in se lahko za nekaj sto metrov razlikujejo od DARS-ove stacionaže.
"""
from __future__ import annotations

import heapq
from collections import defaultdict

from .locate import LAT_M, LON_M, Network, dist

GAP = 12000.0  # prekinitve osi (npr. A2 po ljubljanskem obroču, ki je v OSM označen kot A1) premostimo
SNAP = 150.0   # točka dela mora biti do 150 m od osi


def _dijkstra(adj, start):
    best = {start: 0.0}
    heap = [(0.0, start)]
    while heap:
        d, node = heapq.heappop(heap)
        if d > best.get(node, 1e18):
            continue
        for other, w in adj[node]:
            nd = d + w
            if nd < best.get(other, 1e18):
                best[other] = nd
                heapq.heappush(heap, (nd, other))
    return best


def _components(nodes, adj):
    seen, comps = set(), []
    for n in nodes:
        if n in seen:
            continue
        stack, comp = [n], []
        seen.add(n)
        while stack:
            x = stack.pop()
            comp.append(x)
            for y, _ in adj[x]:
                if y not in seen:
                    seen.add(y)
                    stack.append(y)
        comps.append(comp)
    return comps


class Linear:
    def __init__(self, network: Network, roads: set[str] | None = None):
        self.network = network
        self.roads: dict[str, dict] = {}
        for ref, nodes in network.road_nodes.items():
            if roads and ref not in roads:
                continue
            measured = self._measure(ref, nodes)
            if measured:
                self.roads[ref] = measured
        # Mreža vozlišč z znano razdaljo za hitro iskanje najbližjega.
        self.grid = defaultdict(list)
        for ref, road in self.roads.items():
            for nid, m in road["dist"].items():
                x, y = network.coord[nid]
                self.grid[(int(x * LON_M // SNAP), int(y * LAT_M // SNAP))].append((nid, ref, m))

    def _measure(self, ref: str, nodes: list[int]) -> dict | None:
        net = self.network
        nodeset = set(nodes)
        adj = defaultdict(list)
        for n in nodes:
            for other, w in net.adj[n]:
                if other in nodeset:
                    adj[n].append((other, w))
        # Smerni vozišči sta v OSM ločeni verigi; prečne povezave (do 60 m) naredijo »lestev«,
        # da razdalja teče vzdolž osi in ne po eni smeri dol in po drugi nazaj.
        cell = 60.0
        grid = defaultdict(list)
        for n in nodes:
            x, y = net.coord[n]
            grid[(int(x * LON_M // cell), int(y * LAT_M // cell))].append(n)
        for n in nodes:
            x, y = net.coord[n]
            cx, cy = int(x * LON_M // cell), int(y * LAT_M // cell)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for other in grid[(cx + dx, cy + dy)]:
                        if other != n:
                            d = dist(net.coord[n], net.coord[other])
                            if d <= cell:
                                adj[n].append((other, d))
        comps = sorted(_components(nodes, adj), key=len, reverse=True)
        # Prekinitve: kose osi povežemo med najbližjima vozliščema, če sta do GAP narazen.
        main = set(comps[0])
        for comp in comps[1:]:
            if len(comp) < 30:
                continue
            best = None
            sample_main = list(main)[::5]
            for a in comp[::5]:
                for b in sample_main:
                    d = dist(net.coord[a], net.coord[b])
                    if d < GAP and (best is None or d < best[2]):
                        best = (a, b, d)
            if best:
                a, b, d = best
                adj[a].append((b, d))
                adj[b].append((a, d))
                main |= set(comp)
        if len(main) < 20:
            return None
        anchor = next(iter(main))
        d0 = _dijkstra(adj, anchor)
        end1 = max(d0, key=d0.get)
        d1 = _dijkstra(adj, end1)
        end2 = max(d1, key=d1.get)
        start, end = (end1, end2) if net.coord[end1][1] >= net.coord[end2][1] else (end2, end1)
        measure = d1 if start == end1 else _dijkstra(adj, start)
        return {"dist": measure, "length": max(measure.values()), "start": start, "end": end}

    def ranges(self, geometry) -> list[list]:
        """[[cesta, km od, km do], …] za črte dela.

        Vsaka črta ima svoj razpon; razpone iste ceste združimo le, če so do 0,5 km narazen. Pogodba z
        več ločenimi lokacijami (npr. prehodi na petih odsekih) tako ne pokrije vsega vmes.
        """
        spans: dict[str, list[list[float]]] = defaultdict(list)
        counts: dict[str, int] = defaultdict(int)
        for line in geometry or []:
            hits: dict[str, list[float]] = defaultdict(list)
            for lon, lat in line[:: max(1, len(line) // 60)] + line[-1:]:
                x, y = lon * LON_M, lat * LAT_M
                cx, cy = int(x // SNAP), int(y // SNAP)
                best: dict[str, tuple[float, float]] = {}
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        for nid, ref, m in self.grid.get((cx + dx, cy + dy), ()):
                            nx, ny = self.network.coord[nid]
                            d = ((nx * LON_M - x) ** 2 + (ny * LAT_M - y) ** 2) ** 0.5
                            if d <= SNAP and (ref not in best or d < best[ref][0]):
                                best[ref] = (d, m)
                for ref, (_, m) in best.items():
                    hits[ref].append(m)
            for ref, ms in hits.items():
                spans[ref].append([min(ms), max(ms)])
                counts[ref] += len(ms)
        out = []
        for ref, items in spans.items():
            if counts[ref] < 2 and len(spans) > 1:
                continue
            merged: list[list[float]] = []
            for a, b in sorted(items):
                if merged and a <= merged[-1][1] + 500:
                    merged[-1][1] = max(merged[-1][1], b)
                else:
                    merged.append([a, b])
            out += [[ref, round(a / 1000, 2), round(b / 1000, 2)] for a, b in merged]
        return sorted(out, key=lambda r: (r[0], r[1]))

    def measure(self, lon: float, lat: float, ref: str) -> float | None:
        x, y = lon * LON_M, lat * LAT_M
        cx, cy = int(x // SNAP), int(y // SNAP)
        best = None
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for nid, r, m in self.grid.get((cx + dx, cy + dy), ()):
                    if r != ref:
                        continue
                    nx, ny = self.network.coord[nid]
                    d = (nx * LON_M - x) ** 2 + (ny * LAT_M - y) ** 2
                    if best is None or d < best[0]:
                        best = (d, m)
        return best[1] if best else None

    def orient(self, geometry, ranges) -> list:
        """Črte obrne v smer naraščajočih kilometrov, da je zamik smeri vožnje na zemljevidu dosleden."""
        if not geometry or not ranges:
            return geometry
        ref = ranges[0][0]
        out = []
        for line in geometry:
            a = self.measure(line[0][0], line[0][1], ref)
            b = self.measure(line[-1][0], line[-1][1], ref)
            out.append(list(reversed(line)) if a is not None and b is not None and b < a else line)
        return out

    def axis(self, ref: str, step: float = 200.0) -> list:
        """Os ceste kot točke na vsakih `step` metrov (sredina obeh smernih vozišč); None, kjer osi ni."""
        road = self.roads.get(ref)
        if not road:
            return []
        bins: dict[int, list] = defaultdict(list)
        for nid, m in road["dist"].items():
            bins[int(round(m / step))].append(self.network.coord[nid])
        last = int(road["length"] // step) + 1
        pts: list = []
        for k in range(last + 1):
            coords = bins.get(k)
            if not coords:
                pts.append(None)
                continue
            lons = sorted(c[0] for c in coords)
            lats = sorted(c[1] for c in coords)
            pts.append([round(lons[len(lons) // 2], 5), round(lats[len(lats) // 2], 5)])
        # Kratke luknje (vozlišča so redka na ravnih odsekih) zapolnimo linearno.
        for k, pt in enumerate(pts):
            if pt is not None:
                continue
            a = next((i for i in range(k - 1, max(-1, k - 6), -1) if pts[i] is not None), None)
            b = next((i for i in range(k + 1, min(len(pts), k + 6)) if pts[i] is not None), None)
            if a is not None and b is not None:
                t = (k - a) / (b - a)
                pts[k] = [round(pts[a][0] + (pts[b][0] - pts[a][0]) * t, 5), round(pts[a][1] + (pts[b][1] - pts[a][1]) * t, 5)]
        return pts

    def summary(self) -> dict:
        """Dolžina vsake ceste in priključki z njihovim kilometrom za os diagrama."""
        out = {}
        for ref, road in self.roads.items():
            ticks: dict[str, list[float]] = defaultdict(list)
            for j in self.network.junctions:
                m = road["dist"].get(j["node"])
                if m is not None:
                    ticks[j["name"]].append(m)
            marks = sorted(([round(sum(v) / len(v) / 1000, 1), name] for name, v in ticks.items()), key=lambda t: t[0])
            out[ref] = {
                "length": round(road["length"] / 1000, 1),
                "ticks": marks,
                "from": self._nearest_name(road["start"]),
                "to": self._nearest_name(road["end"]),
            }
        return out

    def _nearest_name(self, node: int) -> str | None:
        pt = self.network.coord[node]
        best = min(self.network.junctions, key=lambda j: dist(j["pt"], pt), default=None)
        if best and dist(best["pt"], pt) < 8000:
            return best["name"]
        place = min(self.network.places, key=lambda p: dist(p["pt"], pt), default=None)
        return place["name"] if place else None
