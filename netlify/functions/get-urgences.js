/**
 * get-urgences.js — v9 INSPECTION DIRECTE
 * Inspecte les datasets connus contenant nbre_pass / nbre_hospit
 * (totaux nationaux toutes causes OSCOUR®)
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
      headers: { 'User-Agent': 'DIANE-Simulateur/9.0', 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/* Datasets Odissé connus contenant nbre_pass + nbre_hospit toutes causes */
const CANDIDATES = [
  'grippe-passages-aux-urgences-et-actes-sos-medecins-france',
  'pathologies-orl-passages-aux-urgences-et-actes-sos-medecins-france',
  'traumatisme-passages-aux-urgences-et-actes-sos-medecins-france',
  'covid-19-passages-aux-urgences-et-actes-sos-medecins-france',
  'gastro-enterite-passages-aux-urgences-et-actes-sos-medecins-france',
  'bronchiolite-passages-aux-urgences-et-actes-sos-medecins-france',
  'asthme-passages-aux-urgences-et-actes-sos-medecins-france',
];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const results = [];

  for (const ds of CANDIDATES) {
    /* Filtre : tous âges, France entière, tri par date desc */
    const qs = new URLSearchParams({
      limit: '2',
      order_by: 'date_complet desc',
      where: 'sursaud_cl_age_gene = "Tous âges"',
    });
    const url = `https://odisse.santepubliquefrance.fr/api/explore/v2.1/catalog/datasets/${ds}/records?${qs}`;
    try {
      const r = await httpsGet(url);
      const j = JSON.parse(r.body);
      const rows = j.results || [];
      const first = rows[0] || null;
      results.push({
        dataset:     ds,
        total_count: j.total_count,
        fields:      first ? Object.keys(first) : [],
        last_date:   first?.date_complet || first?.semaine || null,
        nbre_pass:   first?.nbre_pass   ?? 'ABSENT',
        nbre_hospit: first?.nbre_hospit ?? 'ABSENT',
        sample:      first,
      });
    } catch(e) {
      results.push({ dataset: ds, error: e.message });
    }
  }

  /* Trouver le meilleur candidat : nbre_pass numérique + le plus récent */
  const valid = results.filter(r => typeof r.nbre_pass === 'number' && r.nbre_pass > 0);
  valid.sort((a, b) => (b.last_date || '').localeCompare(a.last_date || ''));

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      best_candidate: valid[0] || null,
      all_results: results,
    }, null, 2),
  };
};
