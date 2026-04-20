
"""
DividendIQ — Netlify Python Function: Yahoo Finance Proxy
Komplett kostenlos, kein API Key nötig.

Endpunkte:
  quote        → Aktueller Kurs, Yield, Change
  bulk-quote   → Mehrere Ticker auf einmal (comma-separated)
  profile      → Unternehmensinfo, Sektor, Beschreibung
  dividends    → Dividendenhistorie
  history      → Kursverlauf für Charts
  search       → Aktiensuche nach Name/Ticker
  metrics      → KGV, Payout Ratio, etc.
"""

import json
import os
import re
from datetime import datetime, timedelta

# Netlify Python functions entry point
def handler(event, context):
    CORS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Content-Type": "application/json",
    }

    if event.get("httpMethod") == "OPTIONS":
        return {"statusCode": 200, "headers": CORS, "body": ""}

    params = event.get("queryStringParameters") or {}
    endpoint = params.get("endpoint", "")
    symbol = params.get("symbol", "").upper().strip()

    if not endpoint:
        return {"statusCode": 400, "headers": CORS,
                "body": json.dumps({"error": "Missing endpoint"})}

    try:
        import yfinance as yf

        if endpoint in ("quote", "bulk-quote"):
            tickers = [s.strip() for s in symbol.split(",") if s.strip()]
            results = []
            for t in tickers:
                try:
                    tk = yf.Ticker(t)
                    info = tk.info
                    price = (info.get("currentPrice")
                             or info.get("regularMarketPrice")
                             or info.get("navPrice") or 0)
                    prev  = info.get("previousClose") or price
                    chg   = price - prev
                    chgPct = (chg / prev * 100) if prev else 0
                    divYield = info.get("dividendYield") or 0
                    results.append({
                        "symbol":           t,
                        "name":             info.get("longName") or info.get("shortName") or t,
                        "price":            round(price, 2),
                        "change":           round(chg, 2),
                        "changePercentage": round(chgPct, 4),
                        "dividendYield":    divYield,          # decimal e.g. 0.0286
                        "volume":           info.get("volume") or 0,
                        "marketCap":        info.get("marketCap") or 0,
                        "pe":               info.get("trailingPE") or 0,
                        "yearHigh":         info.get("fiftyTwoWeekHigh") or 0,
                        "yearLow":          info.get("fiftyTwoWeekLow") or 0,
                        "exchange":         info.get("exchange") or "",
                    })
                except Exception as e:
                    results.append({"symbol": t, "error": str(e)})
            return {"statusCode": 200, "headers": CORS, "body": json.dumps(results)}

        elif endpoint == "profile":
            tk = yf.Ticker(symbol)
            info = tk.info
            return {"statusCode": 200, "headers": CORS, "body": json.dumps([{
                "symbol":          symbol,
                "companyName":     info.get("longName") or symbol,
                "sector":          info.get("sector") or "",
                "industry":        info.get("industry") or "",
                "country":         info.get("country") or "",
                "exchange":        info.get("exchange") or "",
                "exchangeShortName": info.get("exchange") or "",
                "description":     info.get("longBusinessSummary") or "",
                "website":         info.get("website") or "",
                "employees":       info.get("fullTimeEmployees") or 0,
            }])}

        elif endpoint == "dividends":
            tk = yf.Ticker(symbol)
            divs = tk.dividends
            if divs is None or len(divs) == 0:
                return {"statusCode": 200, "headers": CORS, "body": json.dumps([])}
            result = []
            for date, amount in divs.sort_index(ascending=False).head(24).items():
                result.append({
                    "date":        str(date.date()),
                    "dividend":    round(float(amount), 4),
                    "adjDividend": round(float(amount), 4),
                    "recordDate":  str(date.date()),
                    "paymentDate": str(date.date()),
                })
            return {"statusCode": 200, "headers": CORS, "body": json.dumps(result)}

        elif endpoint == "history":
            from_date = params.get("from", (datetime.now() - timedelta(days=730)).strftime("%Y-%m-%d"))
            to_date   = params.get("to",   datetime.now().strftime("%Y-%m-%d"))
            tk   = yf.Ticker(symbol)
            hist = tk.history(start=from_date, end=to_date)
            if hist is None or len(hist) == 0:
                return {"statusCode": 200, "headers": CORS, "body": json.dumps([])}
            result = []
            for date, row in hist.iterrows():
                result.append({
                    "date":   str(date.date()),
                    "open":   round(float(row["Open"]), 2),
                    "high":   round(float(row["High"]), 2),
                    "low":    round(float(row["Low"]), 2),
                    "close":  round(float(row["Close"]), 2),
                    "volume": int(row["Volume"]),
                })
            # Return newest first
            result.reverse()
            return {"statusCode": 200, "headers": CORS, "body": json.dumps(result)}

        elif endpoint == "search":
            query = params.get("query", symbol).strip()
            # yfinance doesn't have search — use a curated approach
            # Try direct ticker lookup first
            results = []
            try:
                tk = yf.Ticker(query.upper())
                info = tk.info
                if info and info.get("longName"):
                    results.append({
                        "symbol":          query.upper(),
                        "name":            info.get("longName") or query.upper(),
                        "exchange":        info.get("exchange") or "NYSE",
                        "exchangeShortName": info.get("exchange") or "NYSE",
                        "currency":        info.get("currency") or "USD",
                    })
            except:
                pass
            # Also search via yfinance search if available
            try:
                import yfinance as yf2
                search_results = yf2.Search(query, max_results=8)
                quotes = search_results.quotes
                for q in quotes:
                    sym = q.get("symbol","")
                    if sym and sym not in [r["symbol"] for r in results]:
                        results.append({
                            "symbol":          sym,
                            "name":            q.get("longname") or q.get("shortname") or sym,
                            "exchange":        q.get("exchange") or "",
                            "exchangeShortName": q.get("exchDisp") or q.get("exchange") or "",
                            "currency":        q.get("currency") or "USD",
                        })
            except:
                pass
            return {"statusCode": 200, "headers": CORS, "body": json.dumps(results[:8])}

        elif endpoint == "metrics":
            tk = yf.Ticker(symbol)
            info = tk.info
            return {"statusCode": 200, "headers": CORS, "body": json.dumps([{
                "symbol":      symbol,
                "payoutRatio": info.get("payoutRatio") or 0,
                "peRatio":     info.get("trailingPE") or 0,
                "roe":         info.get("returnOnEquity") or 0,
                "debtToEquity":info.get("debtToEquity") or 0,
                "freeCashflow":info.get("freeCashflow") or 0,
                "grossMargins":info.get("grossMargins") or 0,
                "revenueGrowth":info.get("revenueGrowth") or 0,
            }])}

        elif endpoint == "peers":
            tk = yf.Ticker(symbol)
            info = tk.info
            # yfinance doesn't have direct peers — return sector info
            return {"statusCode": 200, "headers": CORS,
                    "body": json.dumps([{"peersList": []}])}

        else:
            return {"statusCode": 400, "headers": CORS,
                    "body": json.dumps({"error": f"Unknown endpoint: {endpoint}"})}

    except ImportError:
        return {"statusCode": 500, "headers": CORS,
                "body": json.dumps({"error": "yfinance not installed. Add to requirements.txt"})}
    except Exception as e:
        return {"statusCode": 500, "headers": CORS,
                "body": json.dumps({"error": str(e)})}
