# Obnove avtocest

Interaktivni zemljevid javnih naročil DARS za dela na avtocestah in hitrih cestah od leta 2009: kaj se je delalo, kje, kdaj, kdo je delo izvedel, za koliko, kakšni so bili aneksi in kje so se ista dela ponovila.

**Stran:** https://uvampelj.github.io/obnove-avtocest/

- pogodbe za gradnje iz obvestil o oddaji, neposrednih oddajah in spremembah pogodb na portalu javnih naročil
- lega na avtocesti iz šifer odsekov, imen priključkov in kilometrov v objavah
- aneksi z zneski in razlogi, končna vrednost po aneksih
- ponovitve: pogodbe, katerih dela se na zemljevidu prekrivajo, z razmikom v letih in filtrom za isto vrsto dela
- filtri po vrsti dela, letu, cesti, izvajalcu in besedilu; povezava vsebuje filtre, izbor se prenese kot CSV
- vsak zapis ima povezavo na izvirno objavo, novejši tudi na razpisno dokumentacijo

Stran je neodvisen prikaz javnih podatkov in ni uradna storitev DARS. Ponovitev na istem mestu sama po sebi ni dokaz nepravilnosti: razlogi so opisani na strani pod gumbom **Metodologija**.

## Kako se osvežuje

[`refresh.yml`](.github/workflows/refresh.yml) vsak ponedeljek ob 5.10 UTC:

1. prenese seznam vseh objav DARS s portala javnih naročil in shrani nove objave o oddaji in spremembah v [`data/notices`](data/notices) (vsako enkrat, objave se ne spreminjajo),
2. zapiše stanje v [`status/latest.json`](status/latest.json) in nove objave shrani v repozitorij,
3. zgradi `web/data/obnove.json` in objavi stran.

Če portal vrne nenavadno malo objav ali spodleti več kot 10 % prenosov, se posel ustavi in prejšnja različica strani ostane objavljena. GitHub o neuspešnem zagonu pošlje e-pošto. Portal prosi, naj se avtomatizirano črpanje sproži največ dvakrat dnevno.

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
| `pipeline/parse.py` | razčlenitev treh oblik objav (2009-2015, 2016-2023, eForms od 2023) |
| `pipeline/locate.py` | umestitev odsekov in kilometrov na os ceste iz OpenStreetMap |
| `pipeline/build.py` | pogodbe z aneksi, vrste del, ponovitve, izhod v `web/data` |
| `pipeline/osm.py` | prenos osi avtocest, priključkov, objektov in naselij iz OpenStreetMap |
| `web/` | statična stran (MapLibre, brez gradnje) |

## Omejitve

- Lega je približna. Natančnost (km, cel odsek, objekt, kraj) je zapisana pri vsakem zapisu. Približno polovica pogodb ni umeščena, ker ne navaja odseka (npr. vzdrževanje na območju več AC baz).
- Zajeta so le naročila, objavljena na portalu. Dela lastnih vzdrževalnih baz DARS in evidenčna naročila niso zajeta.
- Garancijski roki niso v objavah. So v razpisni dokumentaciji (vzorec pogodbe) in v pogodbah; to je naslednji korak.

## Viri in licenca podatkov

Javne informacije Slovenije – portal javnih naročil (enarocanje.si). Os cest, priključki in naselja: © sodelavci OpenStreetMap, licenca ODbL. Podlaga zemljevida: © OpenStreetMap, OpenMapTiles, OpenFreeMap.
