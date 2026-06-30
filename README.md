# Calculator Alocare BET

Aplicație web care distribuie o sumă în RON pe primii **10 constituenți ai indicelui BET** (Bursa de Valori București), proporțional cu ponderile oficiale din indice. Calculează câte acțiuni întregi poți cumpăra din fiecare (minim 1/companie), costul real, restul nealocat și permite exportul unui raport Excel.

Prețurile sunt aduse **live de pe [bvb.ro](https://bvb.ro)**, fără chei API și fără dependențe externe de scraping.

---

## Cum funcționează prețurile

La apăsarea butonului **„Actualizează"**, API-ul `/api/prices`:

1. Citește **compoziția + ponderile** indicelui din pagina oficială `IndicesProfiles` (sursa autoritară pentru *care* sunt cele 10 companii din top).
2. Pentru fiecare companie, citește **„Ultimul pret"** (ultimul preț tranzacționat) de pe pagina ei de detaliu — în paralel.
3. Dacă o acțiune nu a avut tranzacții, face **fallback** pe prețul de referință și o marchează ca non-live.

> Coloana „Preț ref." din tabelul indicelui este prețul de *referință* (închiderea anterioară), **nu** prețul curent din piață. De aceea prețurile reale se iau din „Ultimul pret" = prețul `Last` pe care îl vede investitorul.

Prețurile pot fi și **editate manual** (click pe orice preț din tabel).

---

## Stack tehnic

- **Next.js 14** (App Router) + React 18
- **xlsx** pentru export Excel
- Scraping cu regex pur (zero dependențe externe), `output: standalone`
- Docker multi-stage + docker-compose

---

## Rulare locală (dezvoltare)

```bash
npm install
npm run dev
# http://localhost:3000
```

---

## Deploy cu Docker (recomandat pentru producție)

### Prima dată

```bash
git clone https://github.com/dragosnimu/bet-calculator.git
cd bet-calculator
docker compose up -d --build
```

### La fiecare update ulterior

```bash
git pull
docker compose up -d --build
```

`--build` reconstruiește imaginea cu codul nou. Containerul rulează cu `restart: unless-stopped`, limite de 512 MB RAM / 1 CPU și healthcheck integrat.

> Pentru a forța ignorarea cache-ului de build:
> ```bash
> docker compose build --no-cache && docker compose up -d
> ```

### Verificare după deploy

```bash
# health check (din folderul aplicației)
node scripts/health-check.mjs http://localhost:3000

# sau direct API-ul — trebuie să vezi "live":10 și prețuri reale
curl -s http://localhost:3000/api/prices
```

---

## Variabile de mediu

| Variabilă  | Default      | Descriere                      |
|------------|--------------|--------------------------------|
| `PORT`     | `3000`       | Portul pe care rulează app-ul  |
| `NODE_ENV` | `production` | Mediul de execuție             |

**Nu este nevoie de nicio cheie API.** Copiază `.env.example` în `.env` dacă vrei să schimbi portul.

> ⚠️ Serverul de producție trebuie să poată ieși la internet către `bvb.ro` (scraping-ul rulează la fiecare „Actualizează").

---

## Teste

```bash
npm test          # teste pre-deploy (structură, deps, Docker, securitate)
npm run test:health   # health check pe o instanță pornită
```

---

## Disclaimer

Ponderile provin din compoziția oficială BET (bvb.ro), normalizate la 100% pentru top 10. **Acest instrument nu constituie sfat de investiții.**
