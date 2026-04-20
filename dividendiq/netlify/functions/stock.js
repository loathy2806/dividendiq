/**
 * DividendIQ — Yahoo Finance Proxy (JavaScript)
 * Kostenlos, kein API Key, schnell.
 * Verwendet Yahoo Finance v8 API (inoffiziell aber sehr stabil)
 */

const cache = new Map();
const TTL = {
  quote:    2  * 60 * 1000,   // 2 min
  search:   5  * 60 * 1000,   // 5 min
  history:  60 * 60 * 1000,   // 1 hour
  dividends:6  * 60 * 60 * 1000,
  profile:  24 * 60 * 60 * 1000,
};

const YF_BASE = 'https://query1.finance.yahoo.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
};

async function yfFetch(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);
  return res.json();
}

async function getQuote(symbol) {
  const url = `${YF_BASE}/v8/finance/quote?symbols=${symbol}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,dividendYield,trailingAnnualDividendRate,marketCap,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,longName,shortName,fullExchangeName`;
  const data = await yfFetch(url);
  const results = data?.quoteResponse?.result || [];
  return results.map(q => ({
    symbol:           q.symbol,
    name:             q.longName || q.shortName || q.symbol,
    price:            parseFloat((q.regularMarketPrice || 0).toFixed(2)),
    change:           parseFloat((q.regularMarketChange || 0).toFixed(2)),
    changePercentage: parseFloat((q.regularMarketChangePercent || 0).toFixed(4)),
    dividendYield:    q.dividendYield || 0,          // already decimal e.g. 0.0272
    trailingDividend: q.trailingAnnualDividendRate || 0,
    marketCap:        q.marketCap || 0,
    pe:               q.trailingPE || 0,
    yearHigh:         q.fiftyTwoWeekHigh || 0,
    yearLow:          q.fiftyTwoWeekLow  || 0,
    exchange:         q.fullExchangeName || '',
  }));
}

async function getProfile(symbol) {
  const url = `${YF_BASE}/v10/finance/quoteSummary/${symbol}?modules=assetProfile,summaryDetail`;
  const data = await yfFetch(url);
  const profile = data?.quoteSummary?.result?.[0]?.assetProfile || {};
  const summary = data?.quoteSummary?.result?.[0]?.summaryDetail || {};
  return [{
    symbol,
    companyName:      profile.longName || symbol,
    sector:           profile.sector || '',
    industry:         profile.industry || '',
    country:          profile.country || '',
    exchange:         profile.exchange || '',
    exchangeShortName:profile.exchange || '',
    description:      profile.longBusinessSummary || '',
    website:          profile.website || '',
    employees:        profile.fullTimeEmployees || 0,
    dividendYield:    summary.dividendYield?.raw || 0,
    payoutRatio:      summary.payoutRatio?.raw || 0,
  }];
}

async function getDividends(symbol) {
  const url = `${YF_BASE}/v8/finance/chart/${symbol}?range=5y&interval=3mo&events=div`;
  const data = await yfFetch(url);
  const events = data?.chart?.result?.[0]?.events?.dividends || {};
  const divs = Object.values(events)
    .sort((a,b) => b.date - a.date)
    .slice(0, 24)
    .map(d => ({
      date:        new Date(d.date * 1000).toISOString().slice(0,10),
      dividend:    parseFloat((d.amount || 0).toFixed(4)),
      adjDividend: parseFloat((d.amount || 0).toFixed(4)),
      recordDate:  new Date(d.date * 1000).toISOString().slice(0,10),
      paymentDate: new Date(d.date * 1000).toISOString().slice(0,10),
    }));
  return divs;
}

async function getHistory(symbol, from, to) {
  const fromTs = Math.floor(new Date(from).getTime() / 1000);
  const toTs   = Math.floor(new Date(to).getTime()   / 1000);
  const url = `${YF_BASE}/v8/finance/chart/${symbol}?period1=${fromTs}&period2=${toTs}&interval=1d`;
  const data = await yfFetch(url);
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp || [];
  const closes     = result.indicators?.quote?.[0]?.close || [];
  return timestamps
    .map((ts, i) => ({
      date:  new Date(ts * 1000).toISOString().slice(0,10),
      close: parseFloat((closes[i] || 0).toFixed(2)),
    }))
    .filter(d => d.close > 0)
    .reverse();
}

async function search(query) {
  const url = `${YF_BASE}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&listsCount=0`;
  const data = await yfFetch(url);
  const quotes = data?.quotes || [];
  return quotes
    .filter(q => q.quoteType === 'EQUITY' || q.quoteType === 'ETF')
    .slice(0, 8)
    .map(q => ({
      symbol:           q.symbol,
      name:             q.longname || q.shortname || q.symbol,
      exchange:         q.exchange || '',
      exchangeShortName:q.exchDisp || q.exchange || '',
      currency:         q.currency || 'USD',
    }));
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

  const params   = event.queryStringParameters || {};
  const endpoint = params.endpoint;
  const symbol   = (params.symbol || '').toUpperCase().trim();

  if (!endpoint) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing endpoint' }) };
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
    const today = new Date().toISOString().slice(0,10);
    const from2Y = new Date(Date.now() - 730*86400000).toISOString().slice(0,10);

    switch(endpoint) {
      case 'quote':
      case 'bulk-quote':
        result = await getQuote(symbol);
        break;
      case 'profile':
        result = await getProfile(symbol);
        break;
      case 'dividends':
        result = await getDividends(symbol);
        break;
      case 'history':
        result = await getHistory(symbol, params.from || from2Y, params.to || today);
        break;
      case 'search':
        result = await search(params.query || symbol);
        break;
      case 'metrics':
        const pr = await getProfile(symbol);
        result = [{ symbol, payoutRatio: pr[0]?.payoutRatio || 0 }];
        break;
      default:
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Unknown endpoint: ${endpoint}` }) };
    }

    const body = JSON.stringify(result);
    cache.set(cacheKey, { ts: Date.now(), body });
    return { statusCode: 200, headers: { ...CORS, 'X-Cache': 'MISS' }, body };

  } catch(err) {
    console.error(`Yahoo Finance error [${endpoint}]:`, err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
