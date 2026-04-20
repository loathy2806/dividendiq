/**
 * DividendIQ — Netlify Function: FMP Proxy
 * 
 * Keeps your FMP API key secret on the server.
 * All frontend calls go through /.netlify/functions/fmp?endpoint=...
 * 
 * Set FMP_API_KEY in Netlify environment variables (never in code).
 * 
 * Endpoints this proxy supports:
 *   quote          → /quote/{symbol}
 *   profile        → /profile/{symbol}
 *   dividends      → /historical-price-full/stock_dividend/{symbol}
 *   history        → /historical-price-full/{symbol}?from=...&to=...
 *   metrics        → /key-metrics/{symbol}?period=annual&limit=1
 *   income         → /income-statement/{symbol}?period=annual&limit=1
 *   peers          → /stock_peers?symbol={symbol}
 *   bulk-quote     → /quote/{sym1,sym2,...}  (comma-separated tickers)
 * 
 * Usage from frontend:
 *   fetch('/.netlify/functions/fmp?endpoint=quote&symbol=ABBV')
 *   fetch('/.netlify/functions/fmp?endpoint=bulk-quote&symbol=ABBV,KO,MO')
 *   fetch('/.netlify/functions/fmp?endpoint=history&symbol=ABBV&from=2024-01-01&to=2026-04-20')
 */

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

// Simple in-memory cache to reduce API calls (resets on cold start)
const cache = new Map();
const CACHE_TTL = {
  quote:     60 * 1000,          // 1 minute  — prices change fast
  'bulk-quote': 60 * 1000,
  profile:   24 * 60 * 60 * 1000, // 24 hours — company info rarely changes
  dividends: 6  * 60 * 60 * 1000, // 6 hours
  history:   60 * 60 * 1000,      // 1 hour
  metrics:   12 * 60 * 60 * 1000, // 12 hours
  income:    12 * 60 * 60 * 1000,
  peers:     24 * 60 * 60 * 1000,
};

function buildUrl(endpoint, params) {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error('FMP_API_KEY not set in environment variables');

  const symbol = params.symbol || '';

  switch (endpoint) {
    case 'quote':
      return `${FMP_BASE}/quote/${symbol}?apikey=${apiKey}`;
    case 'bulk-quote':
      return `${FMP_BASE}/quote/${symbol}?apikey=${apiKey}`;
    case 'profile':
      return `${FMP_BASE}/profile/${symbol}?apikey=${apiKey}`;
    case 'dividends':
      return `${FMP_BASE}/historical-price-full/stock_dividend/${symbol}?apikey=${apiKey}`;
    case 'history': {
      const from = params.from || '2024-01-01';
      const to   = params.to   || new Date().toISOString().slice(0,10);
      return `${FMP_BASE}/historical-price-full/${symbol}?from=${from}&to=${to}&apikey=${apiKey}`;
    }
    case 'metrics':
      return `${FMP_BASE}/key-metrics/${symbol}?period=annual&limit=1&apikey=${apiKey}`;
    case 'income':
      return `${FMP_BASE}/income-statement/${symbol}?period=annual&limit=1&apikey=${apiKey}`;
    case 'peers':
      return `${FMP_BASE}/stock_peers?symbol=${symbol}&apikey=${apiKey}`;
    default:
      throw new Error(`Unknown endpoint: ${endpoint}`);
  }
}

exports.handler = async (event) => {
  // Handle preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
      body: '',
    };
  }

  const params = event.queryStringParameters || {};
  const { endpoint } = params;

  if (!endpoint) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing endpoint parameter' }) };
  }

  // Check cache
  const cacheKey = JSON.stringify(params);
  const cached = cache.get(cacheKey);
  const ttl = CACHE_TTL[endpoint] || 60000;
  if (cached && Date.now() - cached.ts < ttl) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'HIT',
      },
      body: cached.body,
    };
  }

  try {
    const url = buildUrl(endpoint, params);
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`FMP returned ${response.status}: ${response.statusText}`);
    }

    const body = await response.text();

    // Store in cache
    cache.set(cacheKey, { ts: Date.now(), body });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'MISS',
      },
      body,
    };
  } catch (err) {
    console.error('FMP proxy error:', err.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
