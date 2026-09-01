# Ghid de dezvoltare — aplicația BET

## Metoda default de dezvoltare: echipa adversarială `dev-team`

**Pentru orice schimbare substanțială de cod** (feature nou, logică nouă, refactor, fix de bug sau
de securitate, optimizare) folosește **workflow-ul `dev-team`** — o echipă de trei agenți care
lucrează adversarial:

1. **scriitor** (`dev-writer`) — implementează / optimizează / repară codul;
2. **tester** (`dev-tester`) — rulează suita și încearcă activ să spargă codul nou;
3. **verificator** (`code-auditor`) — audit QA + securitate, dă un GATE PASS/FAIL.

Raportul testerului și al verificatorului se întoarce la scriitor pentru reparare. Bucla iterează
**până când testele-s verzi ȘI GATE = PASS fără findings High/Critical**, maxim **3 runde**.

### Cum îl rulezi
```
Workflow({ scriptPath: ".claude/workflows/dev-team.js", args: { task: "<descrierea sarcinii>" } })
```
Rulează autonom în fundal. Când termină, **prezintă utilizatorului** rezumatul (ce s-a schimbat,
rezultatul testelor, GATE) și **oprește-te înainte de commit** — așteaptă OK-ul explicit pentru
`git commit` / `push` / deploy. Dacă bucla nu converge în 3 runde, raportează ce a rămas și cere
decizia utilizatorului.

### Când NU se folosește echipa
Schimbări **triviale** (typo, o linie, comentariu, doc, bump de versiune izolat) — fă-le direct,
fără workflow. Întrebările/analizele care nu ating codul — direct.

### Reguli ale buclei
- Scriitorul repară întâi Critical/High și eșecurile de teste, apoi Medium; fără rescrieri masive.
- Testerul modifică doar fișiere de test, niciodată cod de producție.
- Verificatorul e read-only.
- Niciun agent nu face `git commit/push` sau deploy — asta rămâne decizia utilizatorului, după review.

## Constrângeri de proiect (valabile pentru orice cod scris aici)
- **Zero dependențe runtime** în afară de `xlsx`. Preferă `fetch`/`zlib`/`fs` native. O dependență
  nouă trebuie justificată explicit.
- **Secrete niciodată în cod/git:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`,
  PAT-uri. Fișiere locale gitignorate: `.env`, `token*.txt`, `telegram*.txt`. `git status` înainte
  de orice commit.
- **Surse externe permise (allowlist):** `bvb.ro`, `news.google.com`, `api.telegram.org`,
  `api.anthropic.com`. Fără fetch către alte host-uri sau URL-uri din input necontrolat.
- **Fără execuție de tranzacții și fără sfaturi personalizate de investiții** — output-urile sunt
  informative (decision-support).
- **Prețuri BVB:** prețul de cumpărare e **Ask** („Bid / Ask", a doua valoare), nu „Ultimul pret".
- La orice schimbare de comportament vizibil, **bump `APP_VERSION`** în
  `components/BETCalculator.jsx` și `app/api/prices/route.js` (badge de verificare deploy).

## Deploy (context)
Producție pe server (fără SSH din partea mea): utilizatorul rulează manual
`git fetch origin && git reset --hard origin/main && docker compose up -d --build`.
Verificarea deploy-ului se face după badge-ul `v<APP_VERSION>` din header. Detalii în
`DOCUMENTATIE.md` și `README.md`.
