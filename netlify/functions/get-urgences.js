/**
 * get-urgences.js — v8 LISTING CATALOGUE COMPLET
 * Liste tous les datasets Odissé pour trouver celui
 * qui contient les passages toutes causes aux urgences.
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
      headers: { 'User-Agent': 'DIANE-Simulateur/8.0', 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const mode   = event.queryStringParameters?.mode || 'list';
  const offset = parseInt(event.queryStringParameters?.offset || '0');
  const ds     = event.queryStringParameters?.ds || '';

  /* ── Mode LIST : tous les datasets paginés ── */
  if (mode === 'list') {
    const url = `https://odisse.santepubliquefrance.fr/api/explore/v2.1/catalog/datasets?limit=50&offset=${offset}&order_by=dataset_id&select=dataset_id,metas.title,metas.modified`;
    try {
      const r = await httpsGet(url);
      const j = JSON.parse(r.body);
      const datasets = (j.datasets || j.results || []).map(d => ({
        id:       d.dataset_id || d.datasetid || d.id,
        title:    d.metas?.title || d.dataset?.metas?.title || '',
        modified: d.metas?.modified || '',
      }));
      /* Filtrer ceux qui contiennent "urgence" ou "passage" dans l'id ou le titre */
      const filtered = datasets.filter(d =>
        /urgence|passage|sursaud|oscour/i.test(d.id + ' ' + d.title)
      );
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          total: j.total_count,
          offset,
          all_count: datasets.length,
          filtered_urgences: filtered,
          all_ids: datasets.map(d => d.id),
        }, null, 2),
      };
    } catch(e) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  /* ── Mode INSPECT : voir les champs d'un dataset ── */
  if (mode === 'inspect' && ds) {
    const url = `https://odisse.santepubliquefrance.fr/api/explore/v2.1/catalog/datasets/${ds}/records?limit=3&order_by=date_complet+desc,semaine+desc,date+desc`;
    try {
      const r = await httpsGet(url);
      const j = JSON.parse(r.body);
      const rows = j.results || [];
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          dataset: ds,
          total_count: j.total_count,
          fields: rows[0] ? Object.keys(rows[0]) : [],
          records: rows,
        }, null, 2),
      };
    } catch(e) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: e.message, dataset: ds }) };
    }
  }

  return {
    statusCode: 200, headers: CORS,
    body: JSON.stringify({ usage: '?mode=list | ?mode=list&offset=50 | ?mode=inspect&ds=DATASET_ID' }),
  };
};
