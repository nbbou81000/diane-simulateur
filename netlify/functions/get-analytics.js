/**
 * get-analytics.js — Netlify Function
 * Récupère les données GA4 via le compte de service Google
 * Utilise l'API Google Analytics Data v1beta
 */

const https = require('https');
const crypto = require('crypto');

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=300', // Cache 5 min
};

const GA4_PROPERTY_ID = '529519661';
const SERVICE_ACCOUNT = {
  client_email: 'diane-analytics-reader@gen-lang-client-0493611279.iam.gserviceaccount.com',
  private_key: process.env.GA4_PRIVATE_KEY, // Stockée en variable d'environnement Netlify
  token_uri: 'https://oauth2.googleapis.com/token',
};

/* ── Créer un JWT signé pour l'auth Google ── */
function createJWT() {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud:   SERVICE_ACCOUNT.token_uri,
    exp:   now + 3600,
    iat:   now,
  };

  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const toSign  = `${header}.${payload}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(toSign);
  const signature = sign.sign(SERVICE_ACCOUNT.private_key, 'base64url');

  return `${toSign}.${signature}`;
}

/* ── Obtenir un Access Token OAuth2 ── */
async function getAccessToken() {
  const jwt  = createJWT();
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error(json.error_description || JSON.stringify(json)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout OAuth')); });
    req.write(body);
    req.end();
  });
}

/* ── Appel API GA4 ── */
async function ga4Request(accessToken, endpoint, body) {
  const bodyStr = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'analyticsdata.googleapis.com',
      path: `/v1beta/properties/${GA4_PROPERTY_ID}/${endpoint}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout GA4')); });
    req.write(bodyStr);
    req.end();
  });
}

/* ── Parser les rows GA4 ── */
function parseRows(response) {
  if (!response?.rows) return [];
  return response.rows.map(row => ({
    dimensions: (row.dimensionValues || []).map(d => d.value),
    metrics:    (row.metricValues    || []).map(m => parseFloat(m.value) || 0),
  }));
}

/* ── Handler ── */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    if (!SERVICE_ACCOUNT.private_key) throw new Error('GA4_PRIVATE_KEY non définie dans les variables Netlify');

    const token = await getAccessToken();

    /* Requêtes en parallèle */
    const [r7days, rRealtime, rPages] = await Promise.all([

      /* 1. Métriques 7 derniers jours */
      ga4Request(token, 'runReport', {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [
          { name: 'sessions' },
          { name: 'activeUsers' },
          { name: 'screenPageViews' },
          { name: 'bounceRate' },
        ],
        orderBys: [{ dimension: { orderType: 'ALPHANUMERIC', dimensionName: 'date' } }],
      }),

      /* 2. Visiteurs temps réel */
      ga4Request(token, 'runRealtimeReport', {
        metrics: [{ name: 'activeUsers' }],
      }),

      /* 3. Top pages */
      ga4Request(token, 'runReport', {
        dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 5,
      }),
    ]);

    if (r7days.status !== 200) throw new Error(`GA4 runReport: ${JSON.stringify(r7days.body?.error)}`);

    /* Parser 7 jours */
    const rows7  = parseRows(r7days.body);
    const totals = r7days.body.totals?.[0]?.metricValues || [];

    const days = rows7.map(r => ({
      date:      r.dimensions[0],
      sessions:  r.metrics[0],
      users:     r.metrics[1],
      pageviews: r.metrics[2],
    }));

    /* Top pages */
    const pages = parseRows(rPages.body).map(r => ({
      path:  r.dimensions[0],
      views: r.metrics[0],
    }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        realtime:   parseInt(rRealtime.body?.rows?.[0]?.metricValues?.[0]?.value || 0),
        totals: {
          sessions:   parseInt(totals[0]?.value || 0),
          users:      parseInt(totals[1]?.value || 0),
          pageviews:  parseInt(totals[2]?.value || 0),
          bounceRate: parseFloat(totals[3]?.value || 0).toFixed(1),
        },
        days,
        pages,
        fetchedAt: new Date().toISOString(),
      }),
    };

  } catch(err) {
    console.error('[get-analytics]', err.message);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
