"""Prenese DARS-ov register pogodb in iz pogodb za gradnje izlušči garancijo in podizvajalce.

Register pogodb na portalu javnih naročil vsebuje vse pogodbe in dodatke (anekse) od leta 2015 z
izvajalci (tudi partnerji v skupni ponudbi) in podpisano pogodbo v PDF. Za vse zapise shranimo
podatke iz registra; za pogodbe za gradnje še odlomke besedila o garanciji in podizvajalcih.
Približno polovica pogodb je skeniranih brez besedilnega sloja, zato jih preberemo z OCR
(tesseract, slovenščina). Vse je v data/contracts/<id>.json; zapis se ne prenaša znova.

Potrebna orodja: pdftotext in pdftoppm (poppler-utils), tesseract z jezikom slv.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from .collect import NOT_WORKS, WORKS
from .portal import DARS, Portal

ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = ROOT / "data" / "contracts"

KEYWORD = re.compile(r"garanc|jamstven|podizvajal", re.I)
PRIORITY = re.compile(r"garancijsk\w*\s+(?:rok|dob)", re.I)   # sam garancijski rok, ne bančna garancija
MIN_TEXT = 1500      # manj znakov besedila pomeni sken brez besedilnega sloja
MAX_OCR_PAGES = 40
SCALE = 2400         # daljša stranica slike strani v pikslih (~200 dpi za A4); skeni z napačno velikostjo strani
                     # bi sicer dali več deset milijonov pikslov in tesseract bi obstal
PAGE_TIMEOUT = 120   # sekund za eno stran
OCR_DEADLINE = 600   # sekund za vso pogodbo; preostale strani preskočimo
OCR_ENV = {**os.environ, "OMP_THREAD_LIMIT": "1"}   # več vzporednih tesseractov brez prepletanja niti
BEFORE, AFTER, MAX_EXCERPT = 400, 1500, 20000


def is_works(row: dict) -> bool:
    if row.get("sifObrazecOznaka") != "POG":
        return False
    if row.get("idSifNarociloVrsta") == 3:
        return True
    title = row.get("naziv") or ""
    return bool(WORKS.search(title)) and not NOT_WORKS.search(title)


def pdf_text(path: Path) -> tuple[str, int]:
    pages = 0
    info = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True, errors="replace")
    match = re.search(r"^Pages:\s+(\d+)", info.stdout, re.M)
    if match:
        pages = int(match.group(1))
    result = subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"], capture_output=True, text=True,
                            errors="replace", timeout=300)
    return result.stdout, pages


def ocr_page(image: Path, deadline: float) -> str | None:
    """Besedilo strani; None, če je zmanjkalo časa."""
    left = min(PAGE_TIMEOUT, deadline - time.monotonic())
    if left < 5:
        return None
    try:
        result = subprocess.run(["tesseract", str(image), "-", "-l", "slv", "--psm", "3"], capture_output=True,
                                text=True, errors="replace", timeout=left, env=OCR_ENV)
    except subprocess.TimeoutExpired:
        return None
    return result.stdout


def ocr(path: Path, pages: int, workdir: Path) -> str:
    last = min(pages or MAX_OCR_PAGES, MAX_OCR_PAGES)
    pages_dir = Path(tempfile.mkdtemp(dir=workdir))
    try:
        subprocess.run(["pdftoppm", "-scale-to", str(SCALE), "-gray", "-png", "-f", "1", "-l", str(last),
                        str(path), str(pages_dir / "p")], check=True, capture_output=True, timeout=600)
        images = sorted(pages_dir.glob("p*.png"))
        deadline = time.monotonic() + OCR_DEADLINE
        with ThreadPoolExecutor(max_workers=os.cpu_count() or 2) as pool:
            texts = list(pool.map(lambda image: ocr_page(image, deadline), images))
    finally:
        shutil.rmtree(pages_dir, ignore_errors=True)
    missing = sum(text is None for text in texts)
    text = "\n".join(text or "" for text in texts)
    if missing and len(re.sub(r"\s", "", text)) < MIN_TEXT:
        raise RuntimeError(f"OCR ni uspel na {missing} od {len(texts)} strani")
    return text


def excerpt(text: str) -> str:
    """Odlomki okoli omemb garancije in podizvajalcev (z uvodom pogodbe, kjer je številka pogodbe).

    Najprej vzamemo okolico garancijskega roka, nato podizvajalce, nato ostale omembe, dokler ne
    dosežemo omejitve dolžine; odlomki ostanejo v vrstnem redu pogodbe.
    """
    text = re.sub(r"[ \t\xa0]+", " ", text)
    windows = [(0, 0, min(len(text), 800))]
    for match in KEYWORD.finditer(text):
        rank = 1 if PRIORITY.match(text, match.start()) else 2 if match.group(0).lower().startswith("podiz") else 3
        windows.append((rank, max(0, match.start() - BEFORE), min(len(text), match.end() + AFTER)))
    chosen: list[tuple[int, int]] = []
    used = 0
    for _, start, end in sorted(windows):
        if used + (end - start) > MAX_EXCERPT:
            continue
        chosen.append((start, end))
        used += end - start
    spans: list[tuple[int, int]] = []
    for start, end in sorted(chosen):
        if spans and start <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end))
        else:
            spans.append((start, end))
    return "\n…\n".join(text[a:b].strip() for a, b in spans)[: MAX_EXCERPT + 200]


def register_meta(detail: dict, row: dict) -> dict:
    files = [{"name": f.get("ime"), "url": f.get("url")} for f in detail.get("datoteka") or [] if f.get("url")]
    return {
        "id": detail.get("id") or row.get("id"),
        "type": detail.get("sifObrazecOznaka") or row.get("sifObrazecOznaka"),
        "prev": detail.get("idPogodbaPrej"),
        "idObrazec": detail.get("idObrazec"),
        "idDosje": detail.get("idDosje"),
        "title": detail.get("naziv") or row.get("naziv"),
        "procurement": detail.get("narociloNaziv"),
        "kind": detail.get("idSifNarociloVrsta"),
        "value": detail.get("vrednost"),
        "signed": (detail.get("datumSklenitve") or "")[:10] or None,
        "from": (detail.get("trajanjeOd") or "")[:10] or None,
        "to": (detail.get("trajanjeDo") or "")[:10] or None,
        "number": detail.get("internaStevilka"),
        "contractors": [c.get("naziv") for c in detail.get("izvajalec") or [] if c.get("naziv")],
        "contractor_ids": [c.get("maticna") for c in detail.get("izvajalec") or [] if c.get("naziv")],
        "buyers": [b.get("naziv") for b in detail.get("narocnik") or [] if b.get("naziv")],
        "ident": detail.get("objavaIdent") or row.get("objavaIdent"),
        "published": (detail.get("objavaDejanskaDatum") or row.get("objavaDejanskaDatum") or "")[:10] or None,
        "files": files,
    }


def read_files(portal: Portal, files: list[dict], workdir: Path) -> tuple[str, str, int]:
    """Besedilo vseh PDF prilog; vrne (besedilo, vir, strani)."""
    texts, source, total = [], "none", 0
    for item in files:
        if not (item.get("name") or "").lower().endswith(".pdf"):
            continue
        path = workdir / "pogodba.pdf"
        path.write_bytes(portal.file(item["url"]))
        text, pages = pdf_text(path)
        total += pages
        if len(re.sub(r"\s", "", text)) >= MIN_TEXT:
            source = "pdf" if source in ("none", "pdf") else source
        else:
            text = ocr(path, pages, workdir)
            source = "ocr"
        texts.append(text)
        path.unlink()
    return "\n".join(texts), source, total


def main() -> int:
    for tool in ("pdftotext", "pdfinfo", "pdftoppm", "tesseract"):
        if not shutil.which(tool):
            print(f"Manjka orodje {tool} (poppler-utils, tesseract-ocr, tesseract-ocr-slv).", file=sys.stderr)
            return 1
    CONTRACTS.mkdir(parents=True, exist_ok=True)
    portal = Portal()
    rows = portal.contracts(DARS)
    if len(rows) < 2000:
        print(f"Register je vrnil le {len(rows)} pogodb DARS, pričakovanih je vsaj 2000. Ustavljam.", file=sys.stderr)
        return 1
    works = [row for row in rows if is_works(row)]
    # CONTRACT_IDS: samo navedene pogodbe (tudi že prenesene), npr. za ponovni poskus ali preverjanje.
    only = {item.strip() for item in os.environ.get("CONTRACT_IDS", "").split(",") if item.strip()}
    if only:
        todo = [row for row in rows if str(row["id"]) in only]
    else:
        todo = [row for row in rows if not (CONTRACTS / f"{row['id']}.json").exists()]
    # Najprej pogodbe za gradnje (PDF), nato ostali zapisi registra; znotraj najnovejši najprej.
    todo.sort(key=lambda r: r.get("objavaDejanskaDatum") or "", reverse=True)
    todo.sort(key=lambda r: not is_works(r))

    budget = float(os.environ.get("CONTRACT_MINUTES", "60")) * 60
    started = time.monotonic()
    done = failed = ocred = 0
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        for row in todo:
            if time.monotonic() - started > budget:
                print(f"Časovna omejitev: preostalo {len(todo) - done - failed} pogodb za naslednji zagon.")
                break
            try:
                tick = time.monotonic()
                detail = portal.contract(row["id"])
                meta = register_meta(detail, row)
                text, source, pages = read_files(portal, meta["files"], workdir) if is_works(row) else ("", None, 0)
                if only or source == "ocr":
                    print(f"Pogodba {row['id']}: {source or 'register'}, {pages} strani, {len(text)} znakov, "
                          f"{time.monotonic() - tick:.0f} s", flush=True)
            except Exception as error:  # poskusi znova ob naslednjem zagonu
                failed += 1
                print(f"Pogodbe {row['id']} ni bilo mogoče prebrati: {error}", file=sys.stderr)
                continue
            record = {"meta": meta, "fetched": datetime.now(timezone.utc).date().isoformat()}
            if source:
                record.update({"source": source, "pages": pages, "text": excerpt(text) if text.strip() else ""})
            (CONTRACTS / f"{row['id']}.json").write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
            done += 1
            ocred += source == "ocr"
            if done % 25 == 0:
                print(f"… {done} pogodb ({ocred} z OCR), {(time.monotonic() - started) / 60:.0f} min", flush=True)

    print(f"Pogodb DARS v registru: {len(rows)}, za gradnje: {len(works)}, novih: {done} ({ocred} z OCR), "
          f"neuspešnih: {failed}, zahtevkov: {portal.requests}")
    if failed > max(20, done // 5):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
