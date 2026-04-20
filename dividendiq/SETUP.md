# DividendIQ — Setup & Deployment Guide

## Projektstruktur

```
dividendiq/
├── netlify.toml                  ← Netlify Konfiguration
├── package.json
├── public/
│   └── index.html                ← Die gesamte App (Single File)
└── netlify/
    └── functions/
        └── fmp.js                ← Sicherer FMP API Proxy
```

---

## Schritt 1: FMP API Key besorgen

1. Gehe zu https://financialmodelingprep.com/developer/docs
2. Kostenloser Account: 250 API Calls/Tag (zum Testen)
3. Paid Plan "Starter" ($15/Monat): 300 Calls/Minute, alle Endpunkte
   → Empfehlung für Produktion: **Basic Plan ($29/Monat)**
   → Liefert: Realtime-Kurse, Dividendenhistorie, Ex-Dates, Fundamentals, Peers

**Was FMP liefert (alles was DividendIQ braucht):**
- `/quote/{symbol}` — Aktueller Kurs, Tagesveränderung, Yield, PE, 52W High/Low
- `/profile/{symbol}` — Unternehmensinfo, Sektor, Beschreibung, Logo
- `/historical-price-full/stock_dividend/{symbol}` — Dividendenhistorie mit Ex-Dates
- `/historical-price-full/{symbol}?from=...&to=...` — Kursverlauf für Charts
- `/key-metrics/{symbol}` — Payout Ratio, Dividenden-Jahre, FCF Yield
- `/stock_peers?symbol={symbol}` — Wettbewerber für Competition Tab
- `/quote/ABBV,KO,MO,...` — Bulk-Quotes für alle Positionen auf einmal (1 API Call!)

---

## Schritt 2: Netlify Deployment

### Option A: Über Netlify Web UI (einfachster Weg)
1. Gehe zu https://app.netlify.com
2. "Add new site" → "Deploy manually"
3. Diesen Ordner (`dividendiq/`) hochladen oder per Drag & Drop
4. Site wird automatisch deployed

### Option B: Über GitHub (empfohlen für laufende Entwicklung)
```bash
# Repository erstellen
git init
git add .
git commit -m "Initial DividendIQ"

# Auf GitHub pushen, dann in Netlify:
# "Add new site" → "Import from Git" → dein Repository auswählen
```

---

## Schritt 3: API Key als Umgebungsvariable setzen

In Netlify Dashboard:
1. Site Settings → Environment Variables
2. "Add variable"
3. Key: `FMP_API_KEY`
4. Value: dein FMP API Key (z.B. `abc123xyz456...`)
5. Speichern → Site neu deployen

⚠️ Den API Key **niemals** direkt in den Code schreiben!
Der Netlify Function Proxy stellt sicher, dass der Key nur server-seitig verwendet wird.

---

## Schritt 4: Stripe für Freemium/Bezahlung

1. Stripe Account: https://stripe.com
2. Zwei Produkte anlegen:
   - **DividendIQ Pro Monatlich**: €9,99/Monat
   - **DividendIQ Pro Jährlich**: €89,99/Jahr
3. Payment Link erstellen (kein Code nötig!)
4. Link in `index.html` ersetzen (suche nach `→ Stripe Checkout (Demo)`)

Für vollständige Integration (Webhook, User-Status): 
→ Netlify Identity + Stripe Webhook Function (nächster Schritt)

---

## API Kosten-Übersicht

| Plan         | Preis     | Calls/Min | Reicht für              |
|--------------|-----------|-----------|-------------------------|
| Free         | $0        | 5         | Entwicklung/Testing     |
| Starter      | $15/Mo    | 300       | bis ~500 User           |
| Basic        | $29/Mo    | 300 + EOD | bis ~2.000 User         |
| Premium      | $89/Mo    | 750       | ab ~5.000 User          |

**Kostenoptimierung durch Caching (bereits eingebaut):**
- Quotes: 1 Minute gecacht
- Profile/Bio: 24 Stunden gecacht
- Dividendenhistorie: 6 Stunden gecacht
- Kursverlauf: 1 Stunde gecacht
- Bulk-Quote: 1 Call für alle 20 Positionen gleichzeitig!

Bei 500 täglichen Usern mit Caching: ~2.000-3.000 API Calls/Tag → Starter Plan ausreichend.

---

## Nächste Entwicklungsschritte

1. **User Authentifizierung** — Netlify Identity (kostenlos bis 1.000 User)
2. **Portfolio-Datenbank** — Fauna DB oder Supabase (jeder User hat sein eigenes Portfolio)
3. **Stripe Webhook** — automatisch Pro-Status aktivieren nach Zahlung
4. **Push Notifications** — Dividend Alerts per E-Mail wenn Ex-Date naht
5. **PWA** — Service Worker + Manifest für mobile Installation

---

## Lokale Entwicklung

```bash
npm install -g netlify-cli
netlify dev
# → App läuft auf http://localhost:8888
# → FMP Proxy läuft auf http://localhost:8888/.netlify/functions/fmp
```

Setze lokal eine `.env` Datei:
```
FMP_API_KEY=dein_key_hier
```
