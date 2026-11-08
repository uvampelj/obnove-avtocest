"""Avtoceste in hitre ceste iz OpenStreetMap: osi, priključki, viadukti, predori in naselja.

Rezultat je data/osm.json, ki ga build.py uporabi za umestitev odsekov na zemljevid.
Podatki se redko spreminjajo, zato je datoteka v repozitoriju; obnovite jo s
`python -m pipeline.osm`.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import requests

from .portal import USER_AGENT

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "osm.json"
OVERPASS = "https://overpass-api.de/api/interpreter"
ROAD_REF = re.compile(r"(?:^|;)\s*([AH]\d)\b")

QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="SI"][admin_level=2]->.si;
(
  way(area.si)["highway"~"^(motorway|trunk)$"]["ref"~"(^|;) *[AH][0-9]"];
)->.roads;
.roads out body geom qt;
node(w.roads)["highway"="motorway_junction"];
out body qt;
(
  way(area.si)["highway"~"^(motorway_link|trunk_link)$"];
)->.links;
node(w.links)["highway"="motorway_junction"]["name"];
out body qt;
node(area.si)["place"~"^(city|town|village|suburb)$"];
out body qt;
"""


def fetch() -> dict:
    response = requests.post(OVERPASS, data={"data": QUERY}, headers={"User-Agent": USER_AGENT}, timeout=300)
    response.raise_for_status()
    return response.json()


def simplify(data: dict) -> dict:
    ways, junctions, places = [], {}, {}
    for element in data["elements"]:
        tags = element.get("tags", {})
        if element["type"] == "way":
            refs = ROAD_REF.findall(tags.get("ref", ""))
            if not refs or "geometry" not in element:
                continue
            ways.append({
                "id": element["id"],
                "ref": refs[0],
                "nodes": element["nodes"],
                "coords": [[round(p["lon"], 6), round(p["lat"], 6)] for p in element["geometry"]],
                "name": tags.get("name", ""),
                "bridge": tags.get("bridge") not in (None, "no"),
                "tunnel": tags.get("tunnel") not in (None, "no"),
                "bridge_name": tags.get("bridge:name", ""),
                "tunnel_name": tags.get("tunnel:name", ""),
            })
        elif element["type"] == "node" and tags.get("highway") == "motorway_junction":
            junctions[element["id"]] = {
                "id": element["id"], "lon": round(element["lon"], 6), "lat": round(element["lat"], 6),
                "name": tags.get("name", ""), "ref": tags.get("ref", ""),
            }
        elif element["type"] == "node" and "place" in tags and tags.get("name"):
            places[element["id"]] = {
                "id": element["id"], "lon": round(element["lon"], 6), "lat": round(element["lat"], 6),
                "name": tags["name"], "place": tags["place"],
            }
    return {"ways": ways, "junctions": list(junctions.values()), "places": list(places.values())}


def main() -> int:
    # `python -m pipeline.osm --query` izpiše poizvedbo; z argumentom poti se namesto
    # prenosa prebere že shranjen odgovor Overpass (uporabno za omrežja s TLS proxyjem).
    if sys.argv[1:] == ["--query"]:
        print(QUERY)
        return 0
    if len(sys.argv) > 1:
        raw = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    else:
        raw = fetch()
    data = simplify(raw)
    if len(data["ways"]) < 500:
        print(f"Overpass je vrnil le {len(data['ways'])} odsekov cest. Ustavljam.", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    refs = sorted({way["ref"] for way in data["ways"]})
    print(f"Cest: {len(data['ways'])} ({', '.join(refs)}), priključkov: {len(data['junctions'])}, "
          f"naselij: {len(data['places'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
