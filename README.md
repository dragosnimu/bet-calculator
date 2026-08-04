# Calculator Alocare BET

Aplicație web care distribuie o sumă în RON pe primii **10 constituenți ai indicelui BET** (Bursa de Valori București), proporțional cu ponderile oficiale din indice. Calculează câte acțiuni întregi poți cumpăra din fiecare (minim 1/companie), costul real, restul nealocat și permite exportul unui raport Excel.

Prețurile sunt aduse **live de pe [bvb.ro](https://bvb.ro)**, fără chei API și fără dependențe externe de scraping.

> 📖 Pentru arhitectura completă, componente, fluxuri de date, modelul de stare și toate funcțiile
> worker-ului de alerte, vezi **[DOCUMENTATIE.md](DOCUMENTATIE.md)**.

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

## Alerte Telegram (scădere preț)

Un worker separat (`bet-alert-worker`, pornit automat de docker-compose) verifică prețurile
**la fiecare 15 minute cât e bursa deschisă** (Luni–Vineri, 10:00–18:00, ora României) și trimite
o alertă pe Telegram când o acțiune scade cu **≥1% față de închiderea de ieri**. Re-alertează la
fiecare treaptă suplimentară (−1%, −2%, −3%…), cu resetare automată la începutul fiecărei zile.
**Simetric**, primești o alertă și când o acțiune **crește cu ≥1%** față de închiderea de ieri
(+1%, +2%, +3%…). Pragul de creștere e reglabil separat din `.env` (`ALERT_RISE_STEP`, implicit `1`).

**Acknowledge / Reset (totul din Telegram):** fiecare alertă are un buton *„🔕 Oprește alertele"*
— după care nu mai primești nimic pentru acea acțiune. O reactivezi cu comanda **`/reset SIMBOL`**
(sau `/reset all` pentru toate). Comanda **`/status`** îți arată oricând starea celor 10 acțiuni
(variație % + trend + care sunt oprite). Alertele oprite se reactivează oricum automat la începutul
fiecărei zile de tranzacționare.

> Nota: controlul alertelor se face **exclusiv din Telegram** (privat). Site-ul public afișează
> doar calculatorul, fără date sau butoane de alerte.

### Alerte de trend intraday (cu grafic)

Pe lângă pragurile de scădere, worker-ul detectează și **trendul intraday** al fiecărei acțiuni.
Pe eșantioanele zilei (la 15 min) rulează o regresie liniară pe o fereastră glisantă (~2h) și
consideră trendul **clar ascendent** / **clar descendent** când mișcarea pe fereastră e ≥1%
**și** e suficient de „curată" (R² ≥ 0.6, adică nu zgomot). Când trendul devine clar — sau își
schimbă direcția — primești pe Telegram un mesaj **+ un grafic** (PNG generat local, fără servicii
externe) cu evoluția prețului din ziua curentă. Se trimite doar la **schimbarea de stare**, deci
fără spam. Parametrii se reglează din `.env` (`TREND_WINDOW`, `TREND_MIN_MOVE`, `TREND_MIN_R2`,
`TREND_ENABLED`).

### Configurare (o singură dată)

1. **Creează un bot:** scrie lui [@BotFather](https://t.me/BotFather) pe Telegram → `/newbot` →
   urmează pașii → primești un **token** (`123456:ABC...`).
2. **Află chat ID-ul tău:** scrie `/start` botului tău, apoi deschide (înlocuind `<TOKEN>`):
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → caută `"chat":{"id":<numărul tău>}`.
3. **Completează `.env`** pe server:
   ```bash
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=<numărul tău>
   ```
4. Reconstruiește: `docker compose up -d --build`.

Fără token, aplicația rulează normal, iar worker-ul intră în **mod dry-run** (alertele apar doar
în logul containerului: `docker compose logs -f bet-alert-worker`).

### Semnale tehnice (Faza 1)

Worker-ul acumulează prețurile ca **bare de 15 min** (buffer multi-zi) și rulează o baterie de
indicatori de analiză tehnică: **EMA 9/21/50, RSI(14), MACD(12,26,9), Bollinger(20,2), breakout pe
20 de bare, momentum (ROC)** și trendul din regresie. Le combină într-un **scor** de la −100 la +100.

Când scorul devine puternic și confirmat (implicit ≥ +55 cu ≥3 confirmări → **SEMNAL PUTERNIC DE
CUMPĂRARE**, sau ≤ −55 → **SEMNAL PUTERNIC DE VÂNZARE / RISC**) primești pe Telegram un mesaj cu
**motivele** (ce indicatori s-au aliniat) și un **grafic adnotat** (preț + liniile EMA). Există un
cooldown per acțiune (implicit 45 min) ca să nu spameze. Comanda **`/status`** arată scorul tehnic +
semnalul curent pentru toate cele 10 acțiuni. Praguri reglabile din `.env` (`SIGNAL_*`).

> Se „încălzește" în ~1–2 zile de tranzacționare (are nevoie de destule bare pentru EMA50/MACD).
> **Semnalele sunt informative — nu constituie recomandare de investiție.** Decizia și execuția
> rămân ale tale; aplicația nu execută ordine.

### Anunțuri oficiale & fundamentale (Faza 2)

- **Anunțuri emitenți (event-driven):** worker-ul monitorizează feed-ul oficial de **rapoarte
  curente** al BVB și, când apare un raport nou pentru una din cele 10 acțiuni urmărite (convocări
  AGA, rezultate financiare, tranzacții ale conducerii etc.), trimite **instant** o alertă pe
  Telegram cu titlul, data și emitentul. La prima pornire face „seed" (marchează tot ca văzut, fără
  să trimită backlog-ul). Rulează la fiecare tick, inclusiv în afara orelor de tranzacționare.
- **Fundamentale de bază (filtru de context):** din pagina fiecărui emitent se extrag **P/E (PER),
  P/BV, EPS, randament dividend (DIVY) și capitalizare**. Apar în `/status` și în alertele de semnal
  tehnic, ca context de calitate/valoare. (Se schimbă trimestrial, deci sunt context, nu declanșator.)

### Sentiment din știri (Faza 3)

Worker-ul caută periodic (implicit ~o dată pe oră) **știri financiare românești** despre fiecare
acțiune prin **Google News RSS** și le scorează sentimentul cu **Claude API** (un scor de la −1 la
+1). Când apar știri noi cu sentiment puternic (implicit |scor| ≥ 0.5) primești pe Telegram o alertă
cu rezumatul și linkurile. Sentimentul curent apare și în `/status` (📰🟢/📰🔴) și ca **context** în
alertele de semnal tehnic.

- Necesită **`ANTHROPIC_API_KEY`** în `.env` — fără ea, sentimentul e dezactivat curat (restul merge).
- Modelul e configurabil (`SENTIMENT_MODEL`). Referința Anthropic recomandă `claude-opus-5`; pentru
  cost redus la această sarcină simplă poți folosi **`claude-haiku-4-5`**.
- Doar știrile **noi** sunt scorate (dedup + seed la prima pornire), deci costul rămâne mic.
- **Analiza de sentiment e informativă — nu constituie recomandare de investiție.**

## Variabile de mediu

| Variabilă             | Default           | Descriere                                    |
|-----------------------|-------------------|----------------------------------------------|
| `PORT`                | `3000`            | Portul pe care rulează app-ul                |
| `NODE_ENV`            | `production`      | Mediul de execuție                           |
| `TELEGRAM_BOT_TOKEN`  | —                 | Tokenul botului de la @BotFather (alerte)    |
| `TELEGRAM_CHAT_ID`    | —                 | Chat ID-ul unde vin alertele                 |
| `ALERT_INTERVAL_MIN`  | `15`              | La câte minute se verifică prețurile         |
| `ALERT_DROP_STEP`     | `1`               | Pragul de scădere, în %                      |
| `ALERT_RISE_STEP`     | `1`               | Pragul de creștere, în %                     |
| `ALERT_TZ`            | `Europe/Bucharest`| Fusul orar pentru programul bursei           |
| `MARKET_OPEN_HOUR`    | `10`              | Ora de deschidere a bursei                   |
| `MARKET_CLOSE_HOUR`   | `18`              | Ora de închidere a bursei                    |
| `SIGNAL_ENABLED`      | `true`            | Activează semnalele tehnice                  |
| `SIGNAL_STRONG_BUY`   | `55`              | Prag scor pentru semnal puternic de cumpărare|
| `SIGNAL_STRONG_SELL`  | `-55`             | Prag scor pentru semnal puternic de vânzare  |
| `SIGNAL_COOLDOWN_MIN` | `45`              | Minute între semnale pentru aceeași acțiune  |

**Pentru calculator nu e nevoie de nicio cheie API.** Doar alertele Telegram cer token + chat ID (vezi mai sus). Copiază `.env.example` în `.env`.

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
