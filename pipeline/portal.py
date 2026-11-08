"""Dostop do portala javnih naročil (enarocanje.si).

Portal ima tri vire, ki jih uporabljamo:
- seznam objav naročnika (isti klic kot iskalnik na strani »Pregled objav«),
- objavo v obliki JSON za obrazce, oddane po letu 2023 (eForms),
- arhivsko HTML stran za starejše obrazce (2009-2023).

Portal prosi, naj se avtomatizirano črpanje sproži največ dvakrat dnevno.
Pri ponovni uporabi je treba navesti vir: »Javne informacije Slovenije – portal javnih naročil«.
"""
from __future__ import annotations

import re
import time
from html.parser import HTMLParser

import requests

BASE = "https://www.enarocanje.si"
DARS = "5814251000"
USER_AGENT = "obnove-avtocest/0.1 (+https://github.com/uvampelj/obnove-avtocest)"
PAUSE = 0.5  # sekund med zahtevki


class Portal:
    def __init__(self, pause: float = PAUSE):
        self.pause = pause
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json, text/html"})
        self._last = 0.0
        self.requests = 0

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        for attempt in range(5):
            wait = self.pause - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.requests += 1
            try:
                response = self.session.request(method, BASE + path, timeout=60, **kwargs)
            except requests.RequestException:
                if attempt == 4:
                    raise
            else:
                if response.status_code < 500 and response.status_code != 429:
                    response.raise_for_status()
                    return response
                if attempt == 4:
                    response.raise_for_status()
            time.sleep(5 * (attempt + 1))
        raise RuntimeError("unreachable")

    def notices(self, maticna: str = DARS, page: int = 1000) -> list[dict]:
        """Vse objave naročnika od začetka portala, od najstarejše naprej."""
        rows: list[dict] = []
        start = 0
        while True:
            body = {
                "page": 1,
                "idSifCpv": [],
                "idSifPostopekFaza": [],
                "podrejeniCpv": True,
                "startRow": start,
                "endRow": start + page,
                "sortModel": [{"colId": "objavaDejanskaDatum", "sort": "asc"}],
                "datumPonudbaDo": None,
                "datumPonudbaOd": None,
                "narocnikMaticna": maticna,
            }
            data = self._request("POST", "/api/obrazec/objava/obrazecGetGrid", json=body).json()
            batch = data.get("data") or []
            rows.extend(batch)
            if len(batch) < page:
                break
            start += page
        return rows

    def form(self, id_obrazec: int) -> dict:
        return self._request("GET", "/api/obrazec/objava/obrazecget", params={"id": id_obrazec}).json()

    def archive(self, id_obrazec: int) -> str:
        response = self._request("GET", f"/arhiv/{id_obrazec}")
        return html_to_text(decode(response))


def decode(response: requests.Response) -> str:
    content_type = response.headers.get("Content-Type", "")
    match = re.search(r"charset=([\w-]+)", content_type, re.I)
    if not match:
        match = re.search(rb"charset=[\"']?([\w-]+)", response.content[:3000], re.I)
    charsets = []
    if match:
        found = match.group(1)
        charsets.append(found.decode() if isinstance(found, bytes) else found)
    charsets += ["utf-8", "cp1250"]
    for charset in charsets:
        try:
            return response.content.decode(charset)
        except (LookupError, UnicodeDecodeError):
            continue
    return response.content.decode("utf-8", errors="replace")


class _TextParser(HTMLParser):
    BLOCK = {"p", "div", "br", "tr", "li", "table", "h1", "h2", "h3", "h4", "h5", "td", "th", "dt", "dd", "section"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _TextParser()
    parser.feed(html)
    lines = (re.sub(r"[ \t\xa0]+", " ", line).strip() for line in "".join(parser.parts).splitlines())
    return "\n".join(line for line in lines if line)
