/**
 * update-bulletin.js — Netlify Scheduled Function
 * Cron : mercredi 16h00 UTC (~18h France)
 *
 * Pipeline :
 *   1. Scrape la page SPF OSCOUR → URL du dernier bulletin PDF
 *   2. Télécharge le PDF
 *   3. Envoie à l'API Google Gemini (vision PDF) pour extraction
 *   4. Stocke le JSON dans Netlify Blobs
 */

const https = require('https');
const { getStore } = require('@netlify/blobs');

/* ── HTTP helpers ── */
function httpsGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'DIANE-Simulateur/1.0 (nb.bouteiller@gmail.com)',
        'Accept': opts.binary ? 'application/pdf' : 'text/html,application/json',
      },
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return httpsGet(res.headers.location, opts).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: opts.binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout 30s')); });
  });
}

function httpsPost(url, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const urlObj  = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout 60s')); });
    req.write(bodyStr);
    req.end();
  });
}

/* ── Trouver l'URL du dernier bulletin PDF sur SPF ── */
async function findLatestBulletinUrl() {
  const page = await httpsGet(
    'https://www.santepubliquefrance.fr/surveillance-syndromique-sursaud-R/reseau-oscour-R-organisation-de-la-surveillance-coordonnee-des-urgences'
  );
  if (page.status !== 200) throw new Error(`SPF page HTTP ${page.status}`);

  /* Chercher les liens PDF des bulletins nationaux directement */
  const pdfMatches = [...page.body.matchAll(/href="([^"]*bullnat[^"]*oscour[^"]*\.pdf[^"]*)"/gi)];
  if (pdfMatches.length) {
    let url = pdfMatches[0][1];
    if (!url.startsWith('http')) url = 'https://www.santepubliquefrance.fr' + url;
    return url;
  }

  /* Fallback : chercher une page intermédiaire du bulletin */
  const pageMatches = [...page.body.matchAll(/href="([^"]*bulletin-national[^"]*oscour[^"]*)"/gi)];
  if (!pageMatches.length) throw new Error('Aucun lien bulletin trouvé sur la page SPF');

  let bulletinPage = pageMatches[0][1];
  if (!bulletinPage.startsWith('http')) bulletinPage = 'https://www.santepubliquefrance.fr' + bulletinPage;

  /* Charger la page du bulletin pour trouver le PDF */
  const bPage = await httpsGet(bulletinPage);
  const pdf = [...bPage.body.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)];
  if (!pdf.length) throw new Error('Aucun PDF sur la page du bulletin');

  let pdfUrl = pdf[0][1];
  if (!pdfUrl.startsWith('http')) pdfUrl = 'https://www.santepubliquefrance.fr' + pdfUrl;
  return pdfUrl;
}

/* ── Extraction via Google Gemini ── */
async function extractWithGemini(pdfBase64) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY non définie dans les variables Netlify');

  const prompt = `Tu es un extracteur de données médicales expert. Analyse ce bulletin OSCOUR® de Santé Publique France.
Extrais UNIQUEMENT les données suivantes et retourne un JSON valide, sans balises markdown, sans texte supplémentaire :

{
  "semaine": "ex: S12 — 2026",
  "periode": "ex: 16 au 22 mars 2026",
  "numero": "ex: 1093",
  "date_publication": "ex: 24.03.2026",
  "passages_total": <nombre entier tous âges toutes causes>,
  "passages_moins15": <nombre entier moins de 15 ans>,
  "passages_15_74": <nombre entier 15-74 ans>,
  "passages_75plus": <nombre entier 75 ans et plus>,
  "hospit_total": <nombre entier tous âges>,
  "hospit_moins2": <nombre entier moins de 2 ans>,
  "hospit_2_14": <nombre entier 2-14 ans>,
  "hospit_15_74": <nombre entier 15-74 ans>,
  "hospit_75plus": <nombre entier 75 ans et plus>,
  "hospit_evol_total": <pourcentage décimal ex: 3.02>,
  "top10": [
    { "rang": 1, "label": "nom pathologie", "semaine": <nombre>, "prec": <nombre>, "var": <pourcentage décimal> },
    ... 10 entrées au total
  ],
  "points_cles": ["phrase courte 1", "phrase courte 2", "phrase courte 3", "phrase courte 4"]
}

Si une valeur est absente, mets null. Retourne uniquement le JSON brut.`;

  const body = {
    contents: [{
      parts: [
        {
          inline_data: {
            mime_type: 'application/pdf',
            data: pdfBase64,
          },
        },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res  = await httpsPost(url, body);

  if (res.status !== 200) throw new Error(`Gemini API HTTP ${res.status}: ${res.body.slice(0, 300)}`);

  const json = JSON.parse(res.body);
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```(?:json)?/gi, '').trim();

  return JSON.parse(clean);
}

/* ── Handler principal ── */
exports.handler = async function () {
  console.log('[update-bulletin-retry] Démarrage —', new Date().toISOString());

  /* Skip si bulletin déjà mis à jour il y a moins de 5 jours */
  try {
    const { getStore } = require('@netlify/blobs');
    const store = getStore('oscour-bulletin');
    const existing = await store.get('latest');
    if (existing) {
      const data = JSON.parse(existing);
      const ageHours = (Date.now() - new Date(data.updated_at).getTime()) / 3600000;
      if (ageHours < 120) {
        console.log('[update-bulletin-retry] Bulletin frais (' + Math.round(ageHours) + 'h) — skip');
        return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: true }) };
      }
    }
  } catch (_) {}


  try {
    /* 1. Trouver l'URL du PDF */
    console.log('[update-bulletin-retry] Recherche du dernier bulletin SPF…');
    const pdfUrl = await findLatestBulletinUrl();
    console.log('[update-bulletin-retry] PDF trouvé :', pdfUrl);

    /* 2. Télécharger le PDF */
    console.log('[update-bulletin-retry] Téléchargement…');
    const pdf = await httpsGet(pdfUrl, { binary: true });
    if (pdf.status !== 200) throw new Error(`PDF download HTTP ${pdf.status}`);
    const pdfBase64 = pdf.body.toString('base64');
    console.log(`[update-bulletin] PDF OK (${Math.round(pdf.body.length / 1024)} Ko)`);

    /* 3. Extraction via Gemini */
    console.log('[update-bulletin-retry] Extraction via Gemini…');
    const extracted = await extractWithGemini(pdfBase64);
    console.log('[update-bulletin-retry] Données :', JSON.stringify({ semaine: extracted.semaine, passages_total: extracted.passages_total }));

    /* 4. Stocker dans Netlify Blobs */
    const store   = getStore('oscour-bulletin');
    const payload = { ...extracted, pdf_url: pdfUrl, updated_at: new Date().toISOString() };
    await store.set('latest', JSON.stringify(payload));
    console.log('[update-bulletin-retry] ✅ Stocké dans Netlify Blobs');

    return { statusCode: 200, body: JSON.stringify({ ok: true, semaine: extracted.semaine }) };

  } catch (err) {
    console.error('[update-bulletin-retry] ❌', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
