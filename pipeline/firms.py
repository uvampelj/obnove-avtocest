"""Imena izvajalcev: kratko ime za seštevke in ključ za povezovanje med objavami in registrom pogodb."""
from __future__ import annotations

import re

LEGAL = re.compile(r"\b(?:d\.\s?d\.|d\.\s?o\.\s?o\.|s\.\s?p\.|k\.\s?d\.|d\.n\.o\.|GmbH|AG|S\.p\.A\.|S\.r\.l\.|a\.s\.|Kft\.?)(?=\W|$)", re.I)
ALIASES = {"SGP POMGRAD": "POMGRAD"}
BUYER = re.compile(r"DRU[ŽZ]BA ZA AVTOCESTE|\bDARS\b", re.I)


def short_firm(name: str) -> str:
    """Kratko ime izvajalca za seštevke: »CGP, družba za ..., d.d.« → »CGP«."""
    first = LEGAL.sub("", name.split(",")[0]).strip(" .-")
    words = first.split()
    caps = []
    for word in words:
        letters = re.sub(r"[^A-Za-zČŠŽĆĐčšžćđ]", "", word)
        if letters and letters.isupper() and (len(letters) >= 2 or caps):
            caps.append(word)
        else:
            break
    short = " ".join(caps) if caps and len(" ".join(caps)) >= 3 and len(caps) < len(words) else first
    short = re.sub(r"\s+", " ", short).strip(" .-") or name
    return ALIASES.get(short.upper(), short)


def firm_key(name: str) -> str:
    return re.sub(r"[^A-Z0-9ČŠŽĆĐ]+", " ", short_firm(name).upper()).strip()


def norm_title(title: str) -> str:
    return re.sub(r"[^a-zčšž0-9]+", " ", (title or "").lower()).strip()


# Podizvajalci v pogodbi: »Poleg izvajalca sodelujejo pri izvedbi tudi naslednji podizvajalci: …«
SUB_START = re.compile(r"naslednj\w*\s+podizvajal\w*|PODIZVAJAL\w*\s*\n|podizvajal\w*\s*:", re.I)
SUB_NONE = re.compile(r"\bni\s+podizvajal|brez\s+podizvajal|nastop\w*\s+brez|podizvajalcev\s+ni|/\s*$", re.I)
SUB_STOP = re.compile(r"\d{1,2}\s*\.\s*[čc]len\b|Izvajalec\s+(?:se|je|mora)|lzvajalec|Naro[čc]nik\s+bo|V\s+primeru", re.I)
FIRM = re.compile(
    r"([A-ZČŠŽĆĐ0-9][\w&\-'\"+.]*(?:\s+[\w&\-'\"+.,]+){0,7}?\s*,?\s*"
    r"(?:d\.\s?o\.\s?o\.|d\.\s?d\.|s\.\s?p\.|GmbH|S\.p\.A\.|S\.r\.l\.|Kft\.?|a\.\s?s\.|d\.n\.o\.|k\.d\.))"
)
NOT_FIRM = re.compile(r"^(?:naziv|polni|naslov|mati[čc]n|dav[čc]n|TRR|podizvajal|poleg|izvajal|naro[čc]nik|pogodb|in|ter)\b", re.I)


GENERIC = {"CESTNO", "CESTNA", "PODJETJE", "GRADBENO", "GRADBENI", "GRADBENA", "GP", "CP", "SGP", "INŠTITUT", "INSTITUT",
           "ZAVOD", "DRUŽBA", "DRUZBA", "SKUPINA", "GROUP", "INŽENIRING", "INZENIRING", "PROJEKT", "PROJEKTIRANJE", "D", "O"}


def firm_stem(key: str) -> str:
    """Prva značilna beseda imena: »KOLEKTOR CPG« → KOLEKTOR, »CESTNO PODJETJE PTUJ« → PTUJ."""
    words = [w for w in key.split() if w not in GENERIC and len(w) >= 3]
    return words[0] if words else key


def subcontractors(text: str, exclude: set[str]) -> list[str]:
    """Imena podizvajalcev iz odlomkov pogodbe; izključi izvajalce in naročnika."""
    if not text:
        return []
    stems = {firm_stem(key) for key in exclude}
    out: list[str] = []
    for start in SUB_START.finditer(text):
        window = text[start.end(): start.end() + 900]
        stop = SUB_STOP.search(window, 40)
        window = window[: stop.start()] if stop else window
        if SUB_NONE.search(window[:120]):
            continue
        # Vsak podizvajalec je v svoji vrstici ali alineji; ime je na začetku, sledi naslov.
        for item in re.split(r"\n+|;|\s[-–•]\s", window):
            match = FIRM.search(item.strip(" -–•\t"))
            if not match:
                continue
            name = re.sub(r"\s+", " ", match.group(1)).strip(" ,.;:")
            if NOT_FIRM.match(name) or BUYER.search(name):
                continue
            if re.search(r"\d{4}\s?\d{4}|\bbank", name, re.I):   # transakcijski račun »… pri … banka d.d.«
                continue
            key = firm_key(name)
            if len(key) < 3 or key in exclude or firm_stem(key) in stems or not re.search(r"[A-ZČŠŽ]{2}", key):
                continue
            if name not in out and key not in {firm_key(n) for n in out}:
                out.append(name)
    return out[:12]
