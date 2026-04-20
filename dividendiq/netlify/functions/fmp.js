/**
 * DividendIQ — Netlify Function: FMP Proxy (Stable API)
 * 
 * Neue FMP Stable API (ersetzt v3 die seit Aug 2025 deprecated ist)
 * Base URL: https://financialmodelingprep.com/stable/
 * 
 * Endpunkte:
 *   quote        → /stable/quote?symbol=ABBV
 *   bulk-quote   → /stable/quote?symbol=ABBV,KO,MO,...
 *   profile      → /stable/profile?symbol=ABBV
 *   dividends    → /stable/dividends?symbol=ABBV
 *   history      → /stable/historical-price-eod/full?symbol=ABBV&from=...&to=...
 *   search       → /stable/search-symbol?query=coca
 *   peers        → /stable/stock-peers?symbol=ABBV
 *   metrics      → /stable/key-metrics?symbol=ABBV&period=annual&limit=1
 */

const FMP_BASE = 'https://financialmodelingprep.com/stable';

const cache = new Map();
const TTL = {
  'quote':      60 * 1000,
  'bulk-quote': 60 * 1000,
  'profile':    24 * 60 * 60 * 1000,
  'dividends':  6  * 60 * 60 * 1000,
  'history':    60 * 60 * 1000,
  'search':     10 * 60 * 1000,
  'peers':      24 * 60 * 60 * 1000,
  'metrics':    12 * 60 * 60 * 1000,
};

function buildUrl(endpoint, params, apiKey) {
  const sym = params.symbol || '';
  switch (endpoint) {
    case 'quote':
    case 'bulk-quote':
      return `${FMP_BASE}/quote?symbol=${sym}&apikey=${apiKey}`;
    case 'profile':
      return `${FMP_BASE}/profile?symbol=${sym}&apikey=${apiKey}`;
    case 'dividends':
      return `${FMP_BASE}/dividends?symbol=${sym}&apikey=${apiKey}`;
    case 'history': {
      const from = params.from || '2023-01-01';
      const to   = params.to   || new Date().toISOString().slice(0, 10);
      return `${FMP_BASE}/historical-price-eod/full?symbol=${sym}&from=${from}&to=${to}&apikey=${apiKey}`;
    }
    case 'search':
      return `${FMP_BASE}/search-symbol?query=${encodeURIComponent(params.query||sym)}&limit=10&apikey=${apiKey}`;
    case 'peers':
      return `${FMP_BASE}/stock-peers?symbol=${sym}&apikey=${apiKey}`;
    case 'metrics':
      return `${FMP_BASE}/key-metrics?symbol=${sym}&period=annual&limit=1&apikey=${apiKey}`;
    default:
      throw new Error(`Unknown endpoint: ${endpoint}`);
  }
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const params   = event.queryStringParameters || {};
  const endpoint = params.endpoint;
  if (!endpoint) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing endpoint' }) };
  }

  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'FMP_API_KEY not configured' }) };
  }

  // Cache check
  const cacheKey = JSON.stringify(params);
  const cached   = cache.get(cacheKey);
  const ttl      = TTL[endpoint] || 60000;
  if (cached && Date.now() - cached.ts < ttl) {
    return { statusCode: 200, headers: { ...CORS, 'X-Cache': 'HIT' }, body: cached.body };
  }

  try {
    const url      = buildUrl(endpoint, params, apiKey);
    const response = await fetch(url);
    const body     = await response.text();

    if (!response.ok) {
      console.error(`FMP error ${response.status} for ${endpoint}:`, body.slice(0, 200));
      return { statusCode: response.status, headers: CORS, body: JSON.stringify({ error: `FMP returned ${response.status}` }) };
    }

    cache.set(cacheKey, { ts: Date.now(), body });
    return { statusCode: 200, headers: { ...CORS, 'X-Cache': 'MISS' }, body };
  } catch (err) {
    console.error('FMP proxy error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
