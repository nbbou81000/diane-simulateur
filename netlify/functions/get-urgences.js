/**
 * get-urgences.js — v11 PRODUCTION — Dashboard multi-pathologies
 * Fetch 5 datasets Odissé SPF en parallèle, filtre "Tous âges",
 * retourne un JSON structuré par pathologie.
 * Mise à jour hebdomadaire automatique (cache CDN 1h).
 */
const https = require('https');

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3600',
};

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'DIANE-Simulateur/11.0', 'Accept': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout 12s')); });
  });
}

const DATASETS = [
  {
    key:     'trauma',
    label:   'Traumatismes',
    icon:    'trauma',
    dataset: 'traumatisme-passages-aux-urgences-et-actes-sos-medecins-france',
    fieldP:  'taux_passages_trauma_sau',
    fieldH:  'taux_hospit_trauma_sau',
  },
  {
    key:     'orl',
    label:   'Pathologies ORL',
    icon:    'orl',
    dataset: 'pathologies-orl-passages-aux-urgences-et-actes-sos-medecins-france',
    fieldP:  'taux_passages_orl_sau',
    fieldH:  'taux_hospit_orl_sau',
  },
  {
    key:     'grippe',
    label:   'Grippe / Syndrome grippal',
    icon:    'grippe',
    dataset: 'grippe-passages-aux-urgences-et-actes-sos-medecins-france',
    fieldP:  'taux_passages_grippe_sau',
    fieldH:  'taux_hospit_grippe_sau',
  },
  {
    key:     'asthme',
    label:   'Asthme',
    icon:    'asthme',
    dataset: 'asthme-passages-aux-urgences-et-actes-sos-medecins-france',
    fieldP:  'taux_passages_asthme_sau',
    fieldH:  'taux_hospit_asthme_sau',
  },
  {
    key:     'covid',
    label:   'Suspicion COVID-19',
    icon:    'covid',
    dataset: 'covid-19-passages-aux-urgences-et-actes-sos-medecins-france',
    fieldP:  'taux_passages_covid_sau',
    fieldH:  'taux_hospit_covid_sau',
  },
];

function formatSemaine(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(\d{4})-S(\d{1,2})/);
  if (m) return `Sem. ${m[2].padStart(2,'0')} — ${m[1]}`;
  return raw;
}

function calcTension(tauxGrippe) {
  if (tauxGrippe == null) return { label: 'INCONNU',    color: '#888888', level: 0 };
  if (tauxGrippe > 400)   return { label: 'CRITIQUE ⚠', color: '#ff3b3b', level: 3 };
  if (tauxGrippe > 150)   return { label: 'ÉLEVÉ ▲',   color: '#ffd600', level: 2 };
  if (tauxGrippe > 50)    return { label: 'MODÉRÉ',     color: '#ff9800', level: 1 };
  return                          { label: 'NORMAL ✓',  color: '#4caf50', level: 0 };
}

async function fetchOne(ds) {
  const qs = new URLSearchParams({
    limit:    '2',
    order_by: 'date_complet desc',
    where:    'sursaud_cl_age_gene = "Tous âges"',
    select:   `date_complet,semaine,${ds.fieldP},${ds.fieldH}`,
  });
  const url = `https://odisse.santepubliquefrance.fr/api/explore/v2.1/catalog/datasets/${ds.dataset}/records?${qs}`;
  const r   = await httpsGet(url);
  const j   = JSON.parse(r.body);
  const row = (j.results || [])[0] || null;
  if (!row) return { key: ds.key, label: ds.label, icon: ds.icon, error: 'no data' };
  return {
    key:         ds.key,
    label:       ds.label,
    icon:        ds.icon,
    tauxPassage: row[ds.fieldP] != null ? Math.round(row[ds.fieldP]) : null,
    tauxHostit:  row[ds.fieldH] != null ? Math.round(row[ds.fieldH]) : null,
    date:        formatSemaine(row.semaine) || row.date_complet,
    semaine:     row.semaine,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    /* Fetch tous les datasets en parallèle */
    const results = await Promise.allSettled(DATASETS.map(fetchOne));

    const pathologies = results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { ...DATASETS[i], error: r.reason?.message }
    );

    /* Date de référence = la plus récente disponible */
    const dates   = pathologies.map(p => p.semaine).filter(Boolean).sort().reverse();
    const refDate = formatSemaine(dates[0]) || '—';

    /* Tension basée sur grippe */
    const grippe  = pathologies.find(p => p.key === 'grippe');
    const tension = calcTension(grippe?.tauxPassage);

    return {
      statusCode: 200,
      headers:    CORS,
      body: JSON.stringify({
        ok:          true,
        date:        refDate,
        tension:     tension,
        pathologies: pathologies,
        source:      'SPF Odissé · OSCOUR® · SurSaUD® · ~700 services urgences France',
        fetchedAt:   new Date().toISOString(),
      }),
    };

  } catch (err) {
    console.error('[get-urgences]', err.message);
    return {
      statusCode: 200,
      headers:    CORS,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
