/**
 * get-urgences.js — v7 EXPLORATION CATALOGUE
 * Cherche les datasets Odissé contenant des données
 * de passages aux urgences toutes causes.
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
      headers: { 'User-Agent': 'DIANE-Simulateur/7.0', 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const mode = event.queryStringParameters?.mode || 'catalogue';

  /* ── Mode 1 : recherche dans le catalogue ── */
  if (mode === 'catalogue') {
    const searches = [
      'toutes+causes+urgences',
      'passages+urgences+france',
      'activite+urgences',
      'sursaud+passages',
    ];
    const results = {};
    for (const q of searches) {
      const url = `https://odisse.santepubliquefrance.fr/api/explore/v2.1/catalog/datasets?limit=5&search=${q}&select=dataset_id,metas.title,metas.modified`;
      try {
        const r = await httpsGet(url);
        const j = JSON.parse(r.body);
        results[q] = (j.datasets || j.results || []).map(d => ({
          id:       d.dataset_id || d.datasetid,
          title:    d.metas?.title || d.dataset?.metas?.title,
          modified: d.metas?.modified || d.dataset?.metas?.modified,
        }));
      } catch(e) {
        results[q] = { error: e.message };
      }
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ mode, results }, null, 2) };
  }

  /* ── Mode 2 : inspecter un dataset précis ── */
  if (mode === 'inspect') {
    const ds = event.queryStringParameters?.ds || '';
    if (!ds) return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'Paramètre ds manquant' }) };
    const url = `https://odisse.santepubliquefrance.fr/api/explore/v2.1/catalog/datasets/${ds}/records?limit=2&order_by=date_complet+desc,semaine+desc`;
    try {
      const r = await httpsGet(url);
      const j = JSON.parse(r.body);
      const first = (j.results || [])[0] || null;
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        mode, dataset: ds,
        total_count: j.total_count,
        fields: first ? Object.keys(first) : [],
        first_record: first,
        second_record: (j.results || [])[1] || null,
      }, null, 2) };
    } catch(e) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: 'mode inconnu — utilise ?mode=catalogue ou ?mode=inspect&ds=DATASET_ID' }) };
};
