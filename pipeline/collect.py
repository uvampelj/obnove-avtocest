"""Prenese DARS-ove objave o oddaji, neposredni oddaji in spremembi pogodb za gradbena dela.

Vsaka objava se shrani enkrat v data/notices/<id>.json in se ne prenaša znova,
ker se objavljena obvestila ne spreminjajo (popravek je nova objava).
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from .portal import DARS, Portal

ROOT = Path(__file__).resolve().parent.parent
NOTICES = ROOT / "data" / "notices"
STATUS = ROOT / "status" / "latest.json"

RESULT_PHASES = {"Rezultat", "Sprememba pogodbe", "Predhodna transparentnost"}
SKIP_FORMS = re.compile(r"preklic|popravek|^EU 14", re.I)
# Stari obrazci imajo v naslovu pogosto le ime kode CPV, zato je izbor širok;
# vrsta naročila (gradnje) se preveri pri obdelavi.
WORKS = re.compile(
    r"gradb|gradnj|obnov|sanacij|rekonstr|vozi[sš]|cest|odsek|viadukt|most|predor|asfalt|ograj|odvodnj|"
    r"dilatac|krovn|plast|zaš[cč]it|nadgradn|razširit|izgradn|ureditev|zid|brežin|plaz|galerij|pokrit|"
    r"vkop|nadvoz|podvoz|oporn|signalizac|označb|rušenj|zemeljsk|površinsk|prepust|lovilc|kanaliz",
    re.I,
)
NOT_WORKS = re.compile(
    r"^storitve|^izdelava\b|projektiran|projektn\w* dokumentacij|študij|svetovan|presoj|\bPZI\b|\bIZP\b|"
    r"\bPGD\b|\bDPN\b|odkup|geodet|zavarovan|čiščen|sol za|posipn|najem|cestninsk\w* sistem|"
    r"programsk|informacijsk|dobava pisarn",
    re.I,
)
CALL_FORMS = {"EUe16", "EUe17", "EUe19", "EUe20", "EUe23", "EUe24"}

# Iz obrazca eForms ne hranimo kontaktnih in tehničnih polj.
DROP_KEYS = re.compile(
    r"^(md|telefon|eNaslov|faks|postniNaslov|postnaStevilka|informator|mediator|revizor|kontakt)", re.I
)


def compact(value):
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if DROP_KEYS.match(key):
                continue
            item = compact(item)
            if item not in (None, "", [], {}):
                out[key] = item
        return out
    if isinstance(value, list):
        return [item for item in (compact(v) for v in value) if item not in (None, "", [], {})]
    return value


def is_candidate(row: dict) -> bool:
    if row.get("sifPostopekFazaNaziv") not in RESULT_PHASES:
        return False
    if SKIP_FORMS.search(row.get("sifObrazecOznaka") or ""):
        return False
    title = row.get("naslov") or ""
    return bool(WORKS.search(title)) and not NOT_WORKS.search(title)


def row_meta(row: dict) -> dict:
    keys = (
        "idObrazec", "idDosje", "naslov", "sifObrazecOznaka", "sifObrazecKoda", "sifPostopekFazaNaziv",
        "objavaIdent", "objavaDejanskaDatum", "noviObrazec", "idStariSistem", "objavaEU",
    )
    return {key: row.get(key) for key in keys}


def main() -> int:
    NOTICES.mkdir(parents=True, exist_ok=True)
    portal = Portal()
    rows = portal.notices(DARS)
    if len(rows) < 9000:
        print(f"Portal je vrnil le {len(rows)} objav DARS, pričakovanih je vsaj 9000. Ustavljam.", file=sys.stderr)
        return 1

    candidates = [row for row in rows if is_candidate(row)]
    # Za nove obrazce prenesemo še prvotno obvestilo o naročilu iz istega dosjeja:
    # v njem je povezava do razpisne dokumentacije z vzorcem pogodbe in garancijskimi roki.
    dosjes = {row["idDosje"] for row in candidates if row.get("noviObrazec")}
    calls = [
        row for row in rows
        if row.get("noviObrazec") and row.get("idDosje") in dosjes
        and row.get("sifObrazecOznaka") in CALL_FORMS
        and "-P" not in (row.get("objavaIdent") or "")
    ]

    limit = int(os.environ.get("MAX_FETCH", "5000"))
    fetched = failed = 0
    for row in candidates + calls:
        path = NOTICES / f"{row['idObrazec']}.json"
        if path.exists():
            continue
        if fetched >= limit:
            break
        record = {"row": row_meta(row), "fetched": datetime.now(timezone.utc).date().isoformat()}
        try:
            if row.get("noviObrazec"):
                record["form"] = compact(portal.form(row["idObrazec"]))
            else:
                record["text"] = portal.archive(row["idObrazec"])
        except Exception as error:  # posamezna objava se poskusi znova ob naslednjem zagonu
            failed += 1
            print(f"Objave {row['idObrazec']} ni bilo mogoče prenesti: {error}", file=sys.stderr)
            continue
        path.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
        fetched += 1
        if fetched % 100 == 0:
            print(f"… {fetched} novih objav", flush=True)

    STATUS.parent.mkdir(parents=True, exist_ok=True)
    status = {
        "checked": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dars_notices": len(rows),
        "candidates": len(candidates),
        "calls": len(calls),
        "stored": len(list(NOTICES.glob("*.json"))),
        "newest_notice": max((row.get("objavaDejanskaDatum") or "") for row in rows),
    }
    STATUS.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Objav DARS: {len(rows)}, izbranih: {len(candidates)} + {len(calls)} razpisov, "
          f"novih: {fetched}, neuspešnih: {failed}, zahtevkov: {portal.requests}")
    if failed > max(20, fetched // 10):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
