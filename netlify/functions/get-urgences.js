/**
 * get-urgences.js — v5 DIAGNOSTIC
 * Dump complet de la réponse Odissé sans aucun filtre
 * pour identifier les vrais noms de champs côté serveur.
 */
const https = require('https');

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-cache',
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'DIANE-Simulateur/5.0', 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout 12s')); });
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const dataset = event.queryStringParameters?.ds
    || 'covid-19-passages-aux-urgences-et-actes-sos-medecins-france';

  const where  = event.queryStringParameters?.where  || '';
  const select = event.queryStringParameters?.select || '*';
  const order  = event.queryStringParameters?.order  || 'semaine desc';
  const limit  = event.queryStringParameters?.limit  || '3';

  const qs = new URLSearchParams({ limit, order_by: order, select });
  if (where) qs.set('where', where);

  const url = `https://odisse.santepubliquefrance.fr/api/explore/v2.1/catalog/datasets/${dataset}/records?${qs}`;

  try {
    const r = await httpsGet(url);
    let parsed = null;
    let parseErr = null;
    try { parsed = JSON.parse(r.body); } catch(e) { parseErr = e.message; }

    const results  = parsed?.results || [];
    const firstRow = results[0] || null;
    const fields   = firstRow ? Object.keys(firstRow) : [];

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        _diag: true,
        url_called:  url,
        http_status: r.status,
        total_count: parsed?.total_count ?? null,
        nb_results:  results.length,
        fields_found: fields,
        first_record: firstRow,
        parse_error:  parseErr,
        raw_body_preview: r.body.slice(0, 800),
      }, null, 2),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ _diag: true, error: err.message, url_called: url }),
    };
  }
};
