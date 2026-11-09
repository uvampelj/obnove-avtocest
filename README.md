# Obnove avtocest

Interaktivni zemljevid javnih naročil DARS za dela na avtocestah in hitrih cestah od leta 2009: kaj se je delalo, kje, kdaj, kdo je delo izvedel, za koliko, kakšni so bili aneksi in kje so se ista dela ponovila.

**Stran:** https://uvampelj.github.io/obnove-avtocest/

- pogodbe za gradnje iz obvestil o oddaji, neposrednih oddajah in spremembah pogodb na portalu javnih naročil
- lega na avtocesti iz šifer odsekov, imen priključkov in kilometrov v objavah; smeri vožnje ločeno
- garancijski roki, partnerji v skupni ponudbi, podizvajalci in dodatki iz podpisanih pogodb v registru pogodb (od 2015, skenirane z OCR)
- aneksi z zneski in razlogi, končna vrednost po aneksih
- ponovitve: pogodbe, katerih dela se na zemljevidu prekrivajo, z razmikom v letih in filtrom za isto vrsto dela
- nekonsistentnosti: delo v garancijski dobi prejšnjega (tudi isti izvajalec), ponovna dela kmalu po rekonstrukciji, ista dela pod drugim imenom, sočasna ločena naročila
- toplotna karta ponovitev in časovnica (prostorsko-časovni diagram) po kilometrih ceste z garancijskimi sencami
- zemljevid 3D: vsaka pogodba je plast nad osjo ceste, višina kupa pokaže, kolikokrat se je delalo na istem mestu (od blizu ločeno po smereh vožnje)
- mreža izvajalcev, partnerjev, podizvajalcev in naročnikov
- forenzični kazalniki: najpogosteje obnovljena mesta, pogodbena proti ocenjeni vrednosti in po številu ponudb, ena ponudba, cena obnove vozišča na km, Benfordov zakon, neposredne oddaje, rast z aneksi in čas do prvega aneksa, kopičenje pod pragovi, zaporedna naročila istemu izvajalcu, mesec podpisa, koncentracija trga (HHI), delitev trga po cestah, rotacija zmagovalcev
- vsak stolpec, točka in številka v forenziki odpre seznam pogodb, iz katerih je izračunana, s potjo na zemljevid, objavo in PDF pogodbe (tudi kot CSV)
- filtri po vrsti dela, letu, cesti, izvajalcu in besedilu; povezava vsebuje filtre, izbor se prenese kot CSV
- vsak zapis ima povezavo na izvirno objavo in pogodbo v PDF

Stran je neodvisen prikaz javnih podatkov in ni uradna storitev DARS. Ponovitev na istem mestu sama po sebi ni dokaz nepravilnosti: razlogi so opisani na strani pod gumbom **Metodologija**.

## Kako se osvežuje

[`refresh.yml`](.github/workflows/refresh.yml) vsak dan ob 3.10 UTC:

1. prenese seznam vseh objav DARS s portala javnih naročil in shrani nove objave o oddaji in spremembah v [`data/notices`](data/notices) (vsako enkrat, objave se ne spreminjajo),
2. prenese nove zapise iz registra pogodb v [`data/contracts`](data/contracts); pri pogodbah za gradnje prebere PDF (pdftotext, pri skeniranih tesseract OCR) in shrani odlomke o garanciji in podizvajalcih,
3. nove podatke shrani v repozitorij,
4. zgradi `web/data/obnove.json`, `web/data/forenzika.json` in `web/data/osi.json` (os cest po 200 m za 3D) ter objavi stran.

Če portal vrne nenavadno malo objav ali spodleti več kot 10 % prenosov, se zbiranje ustavi; že prenesene objave se shranijo, stran se zgradi iz shranjenih podatkov. Branje pogodb ima časovno omejitev (300 min), preostanek se nadaljuje ob naslednjem zagonu; prvi zajem registra (okoli 3300 zapisov, polovica skeniranih pogodb za gradnje) zato traja nekaj dni, potem vsak zagon prenese le novosti. Ročni zagon (*Run workflow*) lahko z vnosom `pogodbe` znova prenese samo izbrane pogodbe. GitHub o neuspešnem zagonu pošlje e-pošto. Portal prosi, naj se avtomatizirano črpanje sproži največ dvakrat dnevno, zato ob spremembi kode (push) teče le gradnja strani.

Ročni zagon: **Actions → Osveži podatke → Run workflow**.

## Lokalni zagon

```bash
pip install -r pipeline/requirements.txt
python -m pipeline.collect
python -m pipeline.build
python -m http.server 8791 --directory web
```

Os avtocest, priključki in naselja iz OpenStreetMap so v `data/osm.json`. Obnovite jih s `python -m pipeline.osm`.

## Struktura

| Pot | Vsebina |
|---|---|
| `pipeline/portal.py` | dostop do portala javnih naročil (seznam objav, JSON novih obrazcev, arhiv starih) |
| `pipeline/collect.py` | izbor in prenos objav o oddaji gradenj in spremembah pogodb v `data/notices` |
| `pipeline/contracts.py` | register pogodb, branje PDF in OCR pogodb za gradnje v `data/contracts` |
| `pipeline/parse.py` | razčlenitev treh oblik objav (2009-2015, 2016-2023, eForms od 2023) |
| `pipeline/warranty.py` | garancijski roki iz člena pogodbe |
| `pipeline/firms.py` | imena izvajalcev, podizvajalci iz pogodbe |
| `pipeline/locate.py` | umestitev odsekov in kilometrov na os ceste iz OpenStreetMap |
| `pipeline/linear.py` | kilometri vzdolž ceste za časovnico in smer črt |
| `pipeline/forensics.py` | povezava z registrom, nekonsistentnosti, statistični kazalniki, mreža |
| `pipeline/build.py` | pogodbe z aneksi, vrste del, ponovitve, izhod v `web/data` |
| `pipeline/osm.py` | prenos osi avtocest, priključkov, objektov in naselij iz OpenStreetMap |
| `web/` | statična stran (MapLibre, brez gradnje) |

## Omejitve

- Lega je približna. Natančnost (km, cel odsek, objekt, kraj) je zapisana pri vsakem zapisu. Približno polovica pogodb ni umeščena, ker ne navaja odseka (npr. vzdrževanje na območju več AC baz).
- Zajeta so le naročila, objavljena na portalu. Dela lastnih vzdrževalnih baz DARS in evidenčna naročila niso zajeta.
- Garancijski roki so znani le za pogodbe iz registra pogodb (od 2015), kjer je bilo člen mogoče prebrati; OCR se lahko zmoti, zato je ob vsakem roku povezava na PDF.
- Kazalniki in nekonsistentnosti so rdeče zastavice za pregled, ne dokaz nepravilnosti. Neuspešni ponudniki in lastniške povezave med podjetji niso v uporabljenih odprtih podatkih.

## Viri in licenca podatkov

Javne informacije Slovenije – portal javnih naročil (enarocanje.si). Os cest, priključki in naselja: © sodelavci OpenStreetMap, licenca ODbL. Podlaga zemljevida: © OpenStreetMap, OpenMapTiles, OpenFreeMap.
