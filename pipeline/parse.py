"""Razčlenitev posamezne objave (nov obrazec eForms ali arhivsko besedilo) v enoten zapis."""
from __future__ import annotations

import re
from datetime import date

PORTAL = "https://www.enarocanje.si/#/pregled-objav/{}"

KIND_WORDS = {"gradnje": "gradnje", "storitve": "storitve", "blago": "blago"}
# idSifNarociloVrsta v eForms: 1 storitve, 2 blago, 3 gradnje (preverjeno na naslovih objav DARS)
KIND_IDS = {1: "storitve", 2: "blago", 3: "gradnje"}

PHASE = {
    "Rezultat": "oddaja",
    "Predhodna transparentnost": "neposredna",
    "Sprememba pogodbe": "sprememba",
    "Naročilo": "razpis",
}


def money(text: str | None) -> float | None:
    if text is None:
        return None
    if isinstance(text, (int, float)):
        return float(text)
    s = text.strip().replace(" ", "").replace("\xa0", "")
    if not s:
        return None
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    elif s.count(".") > 1:
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError:
        return None


def sl_date(text: str | None) -> str | None:
    if not text:
        return None
    m = re.search(r"(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})", text)
    if m:
        d, mo, y = map(int, m.groups())
        try:
            return date(y, mo, d).isoformat()
        except ValueError:
            return None
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
    return "-".join(m.groups()) if m else None


def clean(text: str | None, limit: int | None = None) -> str:
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text).strip(" ;:-,")
    return text[:limit].rstrip() + "…" if limit and len(text) > limit else text


def walk(value, path=""):
    if isinstance(value, dict):
        for key, item in value.items():
            yield from walk(item, f"{path}.{key}")
    elif isinstance(value, list):
        for i, item in enumerate(value):
            yield from walk(item, f"{path}[{i}]")
    else:
        yield path, value


def keys(form: dict, pattern: str) -> list:
    rx = re.compile(pattern)
    return [value for path, value in walk(form) if rx.search(path) and value not in (None, "")]


# --- Novi obrazci (eForms, od 2023) ---------------------------------------------------------

def parse_form(row: dict, form: dict) -> dict:
    lots = form.get("obrazecSklop") or []
    awards = form.get("obrazecOddaja") or []
    contracts = form.get("obrazecPogodba") or []
    changes = form.get("obrazecSprememba") or []

    winners = []
    for award in awards:
        for subject in award.get("obrazecOddajaSubjekt") or []:
            if subject.get("naziv"):
                winners.append({"name": clean(subject["naziv"]), "id": subject.get("maticna")})
    award_values = [money(a.get("vrednostIzbrana")) for a in awards if a.get("vrednostIzbrana") is not None]
    bids = [int(v) for v in keys(form, r"obrazecOddaja\[\d+\]\.(steviloPonudb|stPrejetihPonudb|steviloPrejetihPonudb)\w*$")
            if str(v).isdigit()]

    text_parts = [form.get("naslov"), form.get("kratekOpis")]
    for lot in lots:
        text_parts += [lot.get("naslov"), lot.get("opis")]
    text_parts += [c.get("opis") for c in changes]

    record = {
        "id": row["idObrazec"],
        "dosje": row.get("idDosje") or form.get("idDosje"),
        "ident": row.get("objavaIdent") or form.get("objavaIdent"),
        "form": row.get("sifObrazecOznaka"),
        "phase": PHASE.get(row.get("sifPostopekFazaNaziv"), "drugo"),
        "published": (row.get("objavaDejanskaDatum") or form.get("objavaDejanskaDatum") or "")[:10] or None,
        "kind": KIND_IDS.get(form.get("idSifNarociloVrsta")),
        "title": clean(form.get("naslov")),
        "text": "\n".join(clean(p) for p in text_parts if p),
        "value": sum(award_values) if award_values else money(form.get("vrednostSkupna")),
        "estimate": money(form.get("vrednostOcenjena") or form.get("ocenjenaVrednost")),
        "winners": winners,
        "bids": max(bids) if bids else None,
        "contract_date": next((c.get("datumSklenitev")[:10] for c in contracts if c.get("datumSklenitev")), None),
        "value_before": money(form.get("vrednostPosodobljenaSkupna") or form.get("vrednostSkupna")),
        "value_after": money(form.get("vrednostPoSpremembah")),
        "change": clean(" ".join(c.get("opis") or "" for c in changes) or form.get("spremembaOpis"), 600),
        "change_basis": clean(form.get("spremembaOpis"), 200),
        "docs": form.get("razpisnaDokumentacijaURL"),
        "refs": [],
        "url": PORTAL.format(row["idObrazec"]),
    }
    return record


# --- Stari obrazci (arhiv portala, 2009-2023) -----------------------------------------------

HEAD = r"(?=\n?(?:[IVX]{1,4}\.\d[\d.]*(?:\)|\s)|ODDELEK|Oddelek|SKLOP|ŠT\. NAROČILA|$))"


def grab(text: str, label: str, limit: int = 1500) -> str:
    m = re.search(label + r"[^:\n]*:?\s*(.+?)" + HEAD, text, re.S | re.I)
    return m.group(1).strip()[:limit] if m else ""


WINNER_LABEL = re.compile(
    r"(?:IME IN NASLOV GOSPODARSKEGA SUBJEKTA, KI MU JE BILO NAROČILO ODDANO|"
    r"Ime in naslov (?:izbranega )?(?:ponudnika|izvajalca|gospodarskega subjekta)[^:\n]*|"
    r"Izbrani ponudnik|Naziv izbranega ponudnika)\s*:?\s*\n?\s*(.+)",
    re.I,
)
STREET = re.compile(
    r",\s+(?=[A-ZČŠŽĆĐ][\wčšžćđČŠŽĆĐ.\-]*(?:\s+[\wčšžćđČŠŽĆĐ.\-]+){0,4}?\s+\d+[a-zA-Z]?\b|SI-\d{4}|\d{4}\s)"
)


def winner_name(line: str) -> str:
    line = clean(line).rstrip(".")
    m = STREET.search(line)
    name = line[: m.start()] if m else line
    name = re.sub(r",\s*Slovenija\b", "", name)
    return clean(name, 140)


def parse_text(row: dict, text: str) -> dict:
    head = text[:400].splitlines()
    kind = next((KIND_WORDS[l.strip().lower()] for l in head[:8] if l.strip().lower() in KIND_WORDS), None)
    if kind is None:
        m = re.search(r"Vrsta naročila[^:\n]*:?\s*\n?\s*(Gradnje|Storitve|Blago)", text, re.I)
        kind = m.group(1).lower() if m else None

    title = grab(text, r"(?:Naslov|Naziv) naročila, ki ga je (?:določil|izbral) naročnik", 400) \
        or grab(text, r"II\.1\.1\)\s*(?:Naslov|Naziv)(?: naročila)?", 400) \
        or grab(text, r"Predmet (?:javnega )?naročila", 400)
    desc = grab(text, r"Kratek opis(?: naročila)?(?: ali nabave)?", 2500) or grab(text, r"Opis (?:javnega )?naročila", 2500)
    place = grab(text, r"Glavna lokacija(?: ali mesto gradnje)?", 600) or grab(text, r"Kraj (?:izvedbe|gradnje)", 600)

    values = [money(v) for v in re.findall(r"Skupna končna vrednost naročila:?\s*\n?\s*Vrednost:?\s*([\d.,]+)\s*EUR", text, re.I)]
    if not values:
        values = [money(v) for v in re.findall(r"(?:Končna )?[Vv]rednost(?: naročila| pogodbe)?:?\s*\n?\s*([\d.,]+)\s*EUR", text)]
    values = [v for v in values if v]
    estimate = re.search(r"ocenjena vrednost[^:\n]*:?\s*\n?\s*(?:Vrednost:?\s*)?([\d.,]+)\s*EUR", text, re.I)
    bids = [int(b) for b in re.findall(r"ŠTEVILO PREJETIH PONUDB:?\s*\n?\s*(\d+)", text, re.I)]
    award_date = re.search(r"DATUM (?:ODDAJE NAROČILA|SKLENITVE POGODBE)[^:\n]*:?\s*\n?\s*([\d. ]+\d{4})", text, re.I)
    winners = []
    for m in WINNER_LABEL.finditer(text):
        name = winner_name(m.group(1))
        if name and name.lower() not in {w["name"].lower() for w in winners}:
            winners.append({"name": name, "id": None})

    before = re.search(r"pred spremembami?[^:\n]*:?\s*\n?\s*(?:Vrednost:?\s*)?([\d.,]+)\s*EUR", text, re.I)
    after = re.search(r"po spremembah?[^:\n]*:?\s*\n?\s*(?:Vrednost:?\s*)?([\d.,]+)\s*EUR", text, re.I)
    change = grab(text, r"Opis sprememb", 1200) or grab(text, r"Razlogi? za spremembo", 1200)

    own = row.get("objavaIdent") or ""
    refs = sorted(set(re.findall(r"JN\d{3,6}/\d{4}", text)) - {own})

    return {
        "id": row["idObrazec"],
        "dosje": row.get("idDosje"),
        "ident": own,
        "form": row.get("sifObrazecOznaka"),
        "phase": PHASE.get(row.get("sifPostopekFazaNaziv"), "drugo"),
        "published": (row.get("objavaDejanskaDatum") or "")[:10] or None,
        "kind": kind,
        "title": clean(title) or clean(row.get("naslov")),
        "text": "\n".join(clean(p) for p in (title, place, desc) if p),
        "value": sum(values) if values else None,
        "estimate": money(estimate.group(1)) if estimate else None,
        "winners": winners,
        "bids": sum(bids) if bids else None,
        "contract_date": sl_date(award_date.group(1)) if award_date else None,
        "value_before": money(before.group(1)) if before else None,
        "value_after": money(after.group(1)) if after else None,
        "change": clean(change, 600),
        "change_basis": "",
        "docs": None,
        "refs": refs,
        "url": PORTAL.format(row["idObrazec"]),
    }


# --- Standardni obrazci EU v arhivu (2016-2023): »II.1.1 Naslov«, »V.2.4 ...« ---------------

def line_after(text: str, label: str) -> str:
    m = re.search(label + r"\s*\n\s*(.+)", text)
    return m.group(1).strip() if m else ""


def block(text: str, start: str, stop: str = r"\n(?:[IVX]{1,4}\.\d[\d.]*\s|Oddelek|Sklop \d)", limit: int = 2500) -> str:
    m = re.search(start + r"\s*\n(.+?)(?=" + stop + r"|$)", text, re.S)
    return m.group(1).strip()[:limit] if m else ""


def eur(text: str, label: str) -> list[float]:
    return [v for v in (money(x) for x in re.findall(label + r"[^\n]*?:?\s*\n?\s*(?:Vrednost[^:\n]*:\s*)?([\d.,]+)\s*EUR", text)) if v]


def parse_standard(row: dict, text: str) -> dict:
    title = (re.search(r"II\.1\.1 Naslov\s*\nNaslov:\s*(.+)", text) or re.search(r"Naslov:\s*(.+)", text))
    title = title.group(1).strip() if title else ""
    kind = re.search(r"II\.1\.3 Vrsta naročila\s*\n\s*(Gradnje|Storitve|Blago)", text)
    parts = [
        block(text, r"II\.1\.4 Kratek opis"),
        " ".join(re.findall(r"Glavna lokacija ali kraj izvedbe:\s*(.+)", text)[:3]),
        block(text, r"II\.2\.4 Opis javnega naročila"),
        block(text, r"VII\.1\.4 Opis javnega naročila"),
    ]

    lots = re.split(r"\nSklop \d+\n", text.split("Oddelek V", 1)[1]) if "Oddelek V" in text else []
    values, estimates, bids, dates, winners, lot_titles = [], [], [], [], [], []
    for lot in lots[1:] if len(lots) > 1 else lots:
        if re.search(r"(?:oddano|oddan):\s*Ne\b", lot):
            continue
        lot = lot.split("Oddelek VI")[0]
        lt = re.search(r"Naslov:\s*(.+)", lot)
        if lt:
            lot_titles.append(lt.group(1).strip())
        values += eur(lot, r"Skupna vrednost (?:javnega )?naročila/sklopa")[:1]
        estimates += eur(lot, r"Začetna skupna ocenjena vrednost")[:1]
        b = re.search(r"Število prejetih ponudb:\s*(\d+)", lot)
        if b:
            bids.append(int(b.group(1)))
        d = line_after(lot, r"V\.2\.1 Datum sklenitve pogodbe")
        if sl_date(d):
            dates.append(sl_date(d))
        for name in re.findall(r"Uradno ime\s*\n(.+)", lot.split("V.2.3", 1)[-1].split("V.2.4", 1)[0]):
            name = clean(name, 140)
            if name and name.lower() not in {w["name"].lower() for w in winners}:
                winners.append({"name": name, "id": None})
    if not values:
        values = eur(text, r"II\.1\.7 Skupna vrednost javnega naročila")[:1] or eur(text, r"VII\.1\.6 Informacije o vrednosti")[:1]

    # Obvestilo o spremembi (EU 20)
    if "VII.1.7" in text:
        for name in re.findall(r"Uradno ime\s*\n(.+)", text.split("VII.1.7", 1)[1].split("VII.2", 1)[0]):
            name = clean(name, 140)
            if name and name.lower() not in {w["name"].lower() for w in winners}:
                winners.append({"name": name, "id": None})
    before = eur(text, r"pred spremembami")
    after = eur(text, r"po spremembah")
    change = block(text, r"VII\.2\.1 Opis sprememb", limit=1200)
    reason = block(text, r"VII\.2\.2 Razlogi za spremembo", limit=300).split("\n")[0]

    own = row.get("objavaIdent") or ""
    refs = sorted(set(re.findall(r"(?:JN|NMV)\d{3,6}/\d{4}", text)) - {own})
    return {
        "id": row["idObrazec"],
        "dosje": row.get("idDosje"),
        "ident": own,
        "form": row.get("sifObrazecOznaka"),
        "phase": PHASE.get(row.get("sifPostopekFazaNaziv"), "drugo"),
        "published": (row.get("objavaDejanskaDatum") or "")[:10] or None,
        "kind": kind.group(1).lower() if kind else None,
        "title": clean(title) or clean(row.get("naslov")),
        "text": "\n".join(clean(p) for p in [title, *lot_titles, *parts] if p),
        "value": sum(values) if values else None,
        "estimate": sum(estimates) if estimates else None,
        "winners": winners,
        "bids": max(bids) if bids else None,
        "contract_date": min(dates) if dates else None,
        "value_before": before[0] if before else None,
        "value_after": after[0] if after else None,
        "change": clean(change, 600),
        "change_basis": clean(reason, 200),
        "docs": None,
        "refs": refs,
        "url": PORTAL.format(row["idObrazec"]),
    }


# Razlog za oddajo brez predhodne objave razpisa (iz utemeljitve v objavi ali naslova); prvi ujem velja.
DIRECT_REASONS = [
    ("po neuspešnem razpisu", r"neuspe|predhodno izveden\w*\s+(?:odprt|javn|postop)|vse ponudnike|ni\s+prejel\w*\s+(?:nobene|ustrezn|sprejemljiv|dopustn)|nedopustn\w* ponudb|neprimern\w* ponudb"),
    ("po prekinitvi pogodbe", r"prekinit\w*\s+pogodb|odstop\w*\s+od\s+pogodb|razdr\w*\s+pogodb"),
    ("nujnost", r"nujn|nepredvidljiv\w*\s+dogod|po\s+požaru|plazu|neodložljiv"),
    ("dodatna dela", r"dodatn\w*\s+(?:in\s+\w+\s+)?del|\baneks|več\s+in\s+manj\s+del|ponovitev\s+podobnih"),
    ("en sam možen izvajalec", r"izključn\w*\s+prav|tehničn\w*\s+razlog|le\s+en\w*\s+gospodarsk|edin\w*\s+(?:ponudnik|izvajal|gospodarsk)|avtorsk"),
]


def direct_reason(notice: dict, title: str) -> str:
    import json
    # Naslov (»Dodatna dela pri …«) ima prednost pred splošnim besedilom objave.
    blob = json.dumps(notice, ensure_ascii=False)
    for text in (title, blob):
        for label, rx in DIRECT_REASONS:
            if re.search(rx, text, re.I):
                return label
    return "razlog ni razviden"


def parse(notice: dict) -> dict:
    row = notice["row"]
    if "form" in notice:
        rec = parse_form(row, notice["form"])
    else:
        text = notice.get("text") or ""
        rec = parse_standard(row, text) if "Uradno ime" in text or "Oddelek I:" in text[:800] else parse_text(row, text)
    if rec["phase"] == "neposredna":
        rec["reason"] = direct_reason(notice, rec["title"])
    return rec
