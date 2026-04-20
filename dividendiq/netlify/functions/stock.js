/**
 * DividendIQ — Netlify Function: Finnhub Proxy
 * Kostenlos: 60 Calls/Minute, kein Kreditkarte nötig
 * Docs: https://finnhub.io/docs/api
 */

const BASE = 'https://finnhub.io/api/v1';
const cache = new Map();
const TTL = {
  quote:     2  * 60 * 1000,
  profile:   24 * 60 * 60 * 1000,
  dividends: 6  * 60 * 60 * 1000,
  history:   60 * 60 * 1000,
  search:    10 * 60 * 1000,
  metrics:   12 * 60 * 60 * 1000,
};

async function fhFetch(path, apiKey) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}token=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${res.status}: ${res.statusText}`);
  return res.json();
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: 'FINNHUB_API_KEY not set in environment variables' }) };
  }

  const params   = event.queryStringParameters || {};
  const endpoint = params.endpoint || '';
  const symbol   = (params.symbol || '').toUpperCase().trim();

  if (!endpoint) {
    return { statusCode: 400, headers: CORS,
      body: JSON.stringify({ error: 'Missing endpoint parameter' }) };
  }

  // Cache check
  const cacheKey = JSON.stringify(params);
  const cached   = cache.get(cacheKey);
  const ttl      = TTL[endpoint] || 120000;
  if (cached && Date.now() - cached.ts < ttl) {
    return { statusCode: 200, headers: { ...CORS, 'X-Cache': 'HIT' }, body: cached.body };
  }

  try {
    let result;

    // ── QUOTE (single or bulk) ──────────────────────────────
    if (endpoint === 'quote' || endpoint === 'bulk-quote') {
      const tickers = symbol.split(',').map(s => s.trim()).filter(Boolean);
      const results = await Promise.all(tickers.map(async t => {
        try {
          const [q, p, m] = await Promise.all([
            fhFetch(`/quote?symbol=${t}`, apiKey),
            fhFetch(`/stock/profile2?symbol=${t}`, apiKey),
            fhFetch(`/stock/metric?symbol=${t}&metric=all`, apiKey),
          ]);
          const mt = m?.metric || {};
          // dividendYield from metrics — Finnhub gives it as % e.g. 2.72
          const divYieldPct = mt['dividendYieldIndicatedAnnual'] || mt['currentDividendYieldTTM'] || 0;
          const divYield = divYieldPct / 100; // convert to decimal e.g. 0.0272
          const annDivPS = mt['dividendsPerShareAnnual'] || mt['dividendsPerShareTTM'] || 0;
          return {
            symbol:           t,
            name:             p.name || t,
            price:            parseFloat((q.c || 0).toFixed(2)),
            change:           parseFloat((q.d || 0).toFixed(2)),
            changePercentage: parseFloat((q.dp || 0).toFixed(4)),
            dividendYield:    divYield,
            trailingDividend: annDivPS,
            marketCap:        p.marketCapitalization ? p.marketCapitalization * 1e6 : 0,
            pe:               mt['peTTM'] || mt['peNormalizedAnnual'] || 0,
            yearHigh:         mt['52WeekHigh'] || q.h || 0,
            yearLow:          mt['52WeekLow']  || q.l || 0,
            exchange:         p.exchange || '',
            sector:           p.finnhubIndustry || '',
          };
        } catch(e) {
          return { symbol: t, error: e.message, price: 0 };
        }
      }));
      result = results;
    }

    // ── PROFILE ─────────────────────────────────────────────
    else if (endpoint === 'profile') {
      const p = await fhFetch(`/stock/profile2?symbol=${symbol}`, apiKey);
      result = [{
        symbol,
        companyName:      p.name || symbol,
        sector:           p.finnhubIndustry || '',
        industry:         p.finnhubIndustry || '',
        country:          p.country || '',
        exchange:         p.exchange || '',
        exchangeShortName:p.exchange || '',
        description:      '', // Finnhub free plan doesn't include description
        website:          p.weburl || '',
        employees:        p.employeeTotal || 0,
        logo:             p.logo || '',
        dividendYield:    (p.dividendYield || 0) / 100,
        marketCap:        p.marketCapitalization ? p.marketCapitalization * 1e6 : 0,
      }];
    }

    // ── DIVIDENDS ────────────────────────────────────────────
    else if (endpoint === 'dividends') {
      const from = new Date(Date.now() - 5*365*86400000).toISOString().slice(0,10);
      const to   = new Date().toISOString().slice(0,10);
      const data = await fhFetch(`/stock/dividend?symbol=${symbol}&from=${from}&to=${to}`, apiKey);
      if (!Array.isArray(data) || !data.length) {
        result = [];
      } else {
        result = data
          .sort((a,b) => new Date(b.date) - new Date(a.date))
          .slice(0, 24)
          .map(d => ({
            date:        d.date,
            dividend:    parseFloat((d.amount || 0).toFixed(4)),
            adjDividend: parseFloat((d.adjustedAmount || d.amount || 0).toFixed(4)),
            recordDate:  d.recordDate  || d.date,
            paymentDate: d.payDate     || d.date,
            exDate:      d.date,
          }));
      }
    }

    // ── HISTORY ──────────────────────────────────────────────
    else if (endpoint === 'history') {
      const from = params.from || new Date(Date.now()-730*86400000).toISOString().slice(0,10);
      const to   = params.to   || new Date().toISOString().slice(0,10);
      // Finnhub candles uses unix timestamps
      const fromTs = Math.floor(new Date(from).getTime()/1000);
      const toTs   = Math.floor(new Date(to).getTime()/1000);
      const data = await fhFetch(
        `/stock/candle?symbol=${symbol}&resolution=D&from=${fromTs}&to=${toTs}`, apiKey);
      if (!data || data.s === 'no_data' || !data.c) {
        result = [];
      } else {
        result = data.t.map((ts, i) => ({
          date:  new Date(ts*1000).toISOString().slice(0,10),
          close: parseFloat((data.c[i] || 0).toFixed(2)),
          open:  parseFloat((data.o[i] || 0).toFixed(2)),
          high:  parseFloat((data.h[i] || 0).toFixed(2)),
          low:   parseFloat((data.l[i] || 0).toFixed(2)),
          volume:data.v[i] || 0,
        })).reverse(); // newest first
      }
    }

    // ── SEARCH ───────────────────────────────────────────────
    else if (endpoint === 'search') {
      const query = params.query || symbol;
      const data  = await fhFetch(`/search?q=${encodeURIComponent(query)}`, apiKey);
      const items = data?.result || [];
      result = items
        .filter(s => s.type === 'Common Stock' || s.type === 'EQS' || !s.type)
        .slice(0, 8)
        .map(s => ({
          symbol:           s.symbol,
          name:             s.description || s.symbol,
          exchange:         s.primaryExch || '',
          exchangeShortName:s.primaryExch || '',
          currency:         'USD',
        }));
    }

    // ── METRICS ──────────────────────────────────────────────
    else if (endpoint === 'metrics') {
      const data = await fhFetch(`/stock/metric?symbol=${symbol}&metric=all`, apiKey);
      const m = data?.metric || {};
      result = [{
        symbol,
        payoutRatio:  (m['payoutRatioTTM'] || 0) / 100,
        peRatio:      m['peTTM']     || 0,
        roe:          m['roeTTM']    || 0,
        debtToEquity: m['totalDebt/totalEquityAnnual'] || 0,
        eps:          m['epsTTM']    || 0,
        revenueGrowth:m['revenueGrowthTTMYoy'] || 0,
        dividendYield:(m['dividendYieldIndicatedAnnual'] || 0) / 100,
        dividendPerShare: m['dividendsPerShareAnnual'] || 0,
      }];
    }

    // ── PEERS ────────────────────────────────────────────────
    else if (endpoint === 'peers') {
      const data = await fhFetch(`/stock/peers?symbol=${symbol}`, apiKey);
      result = [{ peersList: Array.isArray(data) ? data.slice(0,6) : [] }];
    }

    else {
      return { statusCode: 400, headers: CORS,
        body: JSON.stringify({ error: `Unknown endpoint: ${endpoint}` }) };
    }

    const body = JSON.stringify(result);
    cache.set(cacheKey, { ts: Date.now(), body });
    return { statusCode: 200, headers: { ...CORS, 'X-Cache': 'MISS' }, body };

  } catch(err) {
    console.error(`Finnhub error [${endpoint}] [${symbol}]:`, err.message);
    return { statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: err.message }) };
  }
};
