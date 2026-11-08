"""Garancijski roki iz besedila pogodbe.

DARS-ove pogodbe za gradnje imajo poseben člen »Garancijski rok« ali »Garancijska doba«, npr.:

    Izvajalec je odgovoren … v času trajanja garancijskega roka, ki znaša:
    - za prometno signalizacijo – debeloslojne označbe na vozišču ........ 3 leta,
    - za nadvoz VA0007 Britof ........................................... 10 let,
    - za vsa ostala razpisana dela ...................................... 5 let.

ali v enem stavku (»Garancijski rok … mora biti najmanj pet (5) let …, za debeloslojne talne
označbe pa tri (3) leta«). Besedilo je pogosto iz OCR, zato so vzorci prizanesljivi do napak.
"""
from __future__ import annotations

import re

WORDS = {
    "en": 1, "ena": 1, "eno": 1, "dve": 2, "dva": 2, "tri": 3, "štiri": 4, "stiri": 4, "pet": 5,
    "šest": 6, "sest": 6, "sedem": 7, "osem": 8, "devet": 9, "deset": 10, "petnajst": 15, "dvajset": 20,
}
WORD_RX = "|".join(sorted(WORDS, key=len, reverse=True))

# Po prednosti; skupina »pre« je predmet, kadar stoji pred glagolom (»Garancijski rok za vsa dela je …«).
ANCHORS = [
    re.compile(r"garancijsk\w*\s+(?:rok\w*|dob\w*)\s*,?\s*ki\s+(?:zna\w{1,3}|traja|je)\b", re.I),
    re.compile(r"garancijsk\w*\s+(?:rok|doba)\b(?P<pre>[^.;]{0,160}?)\s(?:zna\w{1,3}|traja|je|mora\s+biti|velja)\b", re.I),
    re.compile(r"GARANCIJSK[IA]\s+(?:ROK|DOBA)\b"),
]
END = re.compile(
    r"za[čc]ne\s+te[čc]i|Garancij\w*\s+za\s+odpravo|Rok\s+trajanja\s+garancije|bosta\s+pred\s+iztekom|"
    r"\d{1,2}\s*\.\s*[čc]len\b|\b[XVI]{1,5}\.\s+[A-ZČŠŽ]{4,}",
)
# »pet (5) let«, »štiriindvajset (24) mesecev« → samo številka.
SPELLED = re.compile(
    r"\b[a-zčšž]*(?:en[ao]?|dv[ae]|tri|[šs]tiri|pet|[šs]est|sedem|osem|devet|deset|najst|dvajset|trideset)"
    r"\s*\(\s*(\d{1,3})\s*\)",
    re.I,
)
DURATION = re.compile(
    rf"(?:\b(?P<w>{WORD_RX})\s+|(?<![\d/])(?<!\d[.,])(?P<n>\d{{1,3}}(?:[.,]5)?)\s*)"
    r"(?P<u>let|leta|leti|leto|mesecev|meseca|mesece|mesecih|mesec)\b",
    re.I,
)
NOISE = re.compile(r"[._…·•©®°|_~=*]{2,}|\b(?:[neao]{4,}|[a-z]*(?:nnn|eee|aaa)[a-z]*)\b", re.I)
LEAD = re.compile(r"^(?:ki\s+zna\w{1,3}|zna\w{1,3}|najmanj|je|in|ter|pa|na|oz\.?|oziroma|[eoO©•])(?=\W|$)[\s:,]*", re.I)
TRAIL = re.compile(r"(?:\s+(?:pa|in|ter|od|po|je|znaša))+$", re.I)


def _junk(token: str) -> bool:
    """OCR pikčastih vodil (»........«) da besede iz črk n, a, e, o."""
    letters = [c for c in token.lower() if c.isalpha()]
    if len(letters) >= 15 and len(set(letters)) / len(letters) < 0.35:   # »ississicissssevsacv…«
        return True
    return len(letters) >= 3 and sum(c in "naeo" for c in letters) / len(letters) >= 0.75


# Šum OCR v besedi: »StrojNo<OPreMO«, »GaE5« (velika črka sredi male besede, znaki < > | { }).
GARBLE = re.compile(r"[<>{}|\\]|(?<=[a-zčšž])[A-ZČŠŽ]")


def _clean_tail(text: str) -> str:
    """Odreže predmet pri prvem očitnem šumu OCR in kratke ostanke na koncu."""
    match = GARBLE.search(text)
    if match and match.start() >= 3:
        text = text[: match.start()]
    words = text.split()
    while words and len(re.sub(r"\W", "", words[-1])) <= 2 and not re.search(r"\d", words[-1]):
        words.pop()
    return " ".join(words).strip(" ,;:-–—(.")


def _subject(raw: str) -> str:
    text = " ".join(t for t in NOISE.sub(" ", raw).split() if not _junk(t))
    text = re.sub(r"\s+[A-Za-z]$", "", text).strip(" ,;:-–—()")
    # Predmet je za zadnjim koncem stavka in za zadnjim »za« (»… del, za debeloslojne označbe pa«).
    parts = re.split(r"(?<=[a-zčšž)]{3}[.!?])\s+", text)
    if len(parts[-1]) >= 3:
        text = parts[-1]
    cut = text.lower().rfind(" za ")
    if cut > 0:
        text = text[cut + 1:]
    for _ in range(4):
        text = LEAD.sub("", text.strip(" ,;:-–—()"))
    text = re.sub(r"^za\s+", "", text, flags=re.I)
    text = _clean_tail(TRAIL.sub("", text))
    return text[:90].strip(" ,;:-–—(")


def _clauses(text: str):
    """Kandidati za člen o garancijskem roku po prednosti: (predmet pred glagolom, besedilo člena)."""
    for rx in ANCHORS:
        # Za naslovom člena je pogosto »16. člen«, ki ni konec člena.
        skip = 25 if rx is ANCHORS[-1] else 0
        for start in rx.finditer(text):
            body_from = start.end()
            end = END.search(text, body_from + skip)
            stop = min(end.start() if end else len(text), body_from + 1800)
            yield start.groupdict().get("pre") or "", text[body_from:stop]


def _terms(pre: str, clause: str) -> list[list]:
    terms: list[list] = []
    previous = 0
    for match in DURATION.finditer(clause):
        value = WORDS[match.group("w").lower()] if match.group("w") else float(match.group("n").replace(",", "."))
        years = value / 12 if match.group("u").lower().startswith("mesec") else value
        subject = _subject(clause[previous:match.start()])
        if not terms and len(subject) < 3 and pre.strip():
            subject = _subject(pre)
        previous = match.end()
        if not 0.5 <= years <= 30:
            continue
        years = int(years) if float(years).is_integer() else round(years, 1)
        if len(subject) < 3:
            subject = "vsa dela" if not terms else terms[-1][0]
        if [subject, years] not in terms:
            terms.append([subject, years])
    return terms[:12]


HAS_SUBJECT = re.compile(r"\bza\s+\w{3,}", re.I)
ITEM = re.compile(r"^\s*(?:[-–•·©*eoa]|\d{1,2}[.)])\s+za\s+\w{3,}", re.I)


def _realign(clause: str) -> str:
    """Pri skenih z besedilnim slojem je rok včasih vrstico nad svojo alinejo:

        e 3 leta,
        e za prometno signalizacijo ...
          razreda RA3 ........ 10 let,
        e za portalno konstrukcijo ... folijo

    Vrstico z rokom brez predmeta pripnemo naslednji alineji, če ta nima svojega roka in prejšnja
    vrstica ne čaka na rok (sicer je rok le nadaljevanje prelomljene prejšnje alineje).
    """
    lines = clause.split("\n")
    out: list[str] = []
    waiting = False   # prejšnja vrstica ima predmet brez roka
    i = 0
    while i < len(lines):
        line = lines[i]
        duration = DURATION.search(line)
        if duration and not waiting and not HAS_SUBJECT.search(line[: duration.start()]):
            j = i + 1
            while j < min(len(lines), i + 3) and not lines[j].strip():
                j += 1
            if j < len(lines) and ITEM.match(lines[j]) and not DURATION.search(lines[j]):
                out.append(lines[j].rstrip() + " " + line.strip())
                waiting = False
                i = j + 1
                continue
        if line.strip():
            waiting = bool(HAS_SUBJECT.search(line)) and not duration
        out.append(line)
        i += 1
    return "\n".join(out)


def parse_warranty(text: str) -> list[list]:
    """Seznam [predmet, leta] iz člena o garancijskem roku; prazen, če člena ni ali ni rokov."""
    if not text:
        return []
    text = SPELLED.sub(r"\1", re.sub(r"[ \t\xa0]+", " ", text))
    for pre, clause in _clauses(text):
        terms = _terms(pre, _realign(clause))
        if terms:
            return terms
    return []


# Vrsta dela, na katero se garancija nanaša (ključi kot v build.CATEGORIES).
SUBJECT_CATS = [   # predmet roka dobi prvo ujemajočo se vrsto
    ("oprema", re.compile(r"ozna[čc]b|signaliz|portal|folij|\bRA\s?\d|znak|razsvetl", re.I)),
    ("hrup", re.compile(r"hrup", re.I)),
    ("ograje", re.compile(r"ograj|JVO|BVO", re.I)),
    ("predori", re.compile(r"predor", re.I)),
    ("vozisce", re.compile(r"asfalt|obrabn|vozi[sš][čc]n\w* konstr|zgornj\w* ustroj|bitumen|plast|vozi[sš][čc]e\b", re.I)),
    ("objekti", re.compile(r"objekt|most|nadvoz|podvoz|viadukt|konstrukc|hidroizol|beton|zid|prepust|galerij|dilatac|le[žz]i[šs][čc]|protikoroz", re.I)),
    ("odvodnjavanje", re.compile(r"odvodnj|kanaliz|odcejal|lovil", re.I)),
    ("oprema", re.compile(r"elektro|oprem|naprav|sistem|strojn", re.I)),
]
GENERAL = re.compile(r"ostal|\bvs[ae]\b|celotn|drug|dela\b", re.I)


def subject_category(subject: str) -> str | None:
    return next((key for key, rx in SUBJECT_CATS if rx.search(subject)), None)


def term_for(terms: list[list], category: str) -> float | None:
    """Rok, ki velja za dano vrsto dela: ujemanje po predmetu, sicer splošni rok, sicer najkrajši rok."""
    if not terms:
        return None
    matched = [y for s, y in terms if subject_category(s) == category]
    if matched:
        return max(matched)
    general = [y for s, y in terms if GENERAL.search(s) and subject_category(s) is None]
    if general:
        return max(general)
    return min(y for _, y in terms)
