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
MIN_TEXT = 1500      # manj znakov besedila pomeni sken brez besedilnega sloja
MAX_OCR_PAGES = 40
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
    result = subprocess.run(["pdftotext", "-enc", "UTF-8", str(path), "-"], capture_output=True, text=True,
                            errors="replace", timeout=300)
    return result.stdout, pages


def ocr_page(image: Path) -> str:
    result = subprocess.run(["tesseract", str(image), "-", "-l", "slv", "--psm", "3"], capture_output=True,
                            text=True, errors="replace", timeout=300)
    return result.stdout


def ocr(path: Path, pages: int, workdir: Path) -> str:
    last = min(pages or MAX_OCR_PAGES, MAX_OCR_PAGES)
    subprocess.run(["pdftoppm", "-r", "200", "-gray", "-png", "-f", "1", "-l", str(last), str(path),
                    str(workdir / "p")], check=True, capture_output=True, timeout=900)
    images = sorted(workdir.glob("p*.png"))
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 2) as pool:
        texts = list(pool.map(ocr_page, images))
    for image in images:
        image.unlink()
    return "\n".join(texts)


def excerpt(text: str) -> str:
    """Odlomki okoli omemb garancije (z uvodom pogodbe, kjer je številka pogodbe)."""
    text = re.sub(r"[ \t\xa0]+", " ", text)
    spans = [(0, min(len(text), 800))]
    for match in KEYWORD.finditer(text):
        start, end = max(0, match.start() - BEFORE), min(len(text), match.end() + AFTER)
        if start <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end))
        else:
            spans.append((start, end))
    out = "\n…\n".join(text[a:b].strip() for a, b in spans)
    return out[:MAX_EXCERPT]


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
                detail = portal.contract(row["id"])
                meta = register_meta(detail, row)
                text, source, pages = read_files(portal, meta["files"], workdir) if is_works(row) else ("", None, 0)
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
