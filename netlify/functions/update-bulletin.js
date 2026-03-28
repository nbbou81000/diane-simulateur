/**
 * update-bulletin.js — Netlify Scheduled Function
 * Cron : mercredi 16h00 UTC, retry jeudi 10h UTC
 */

const https = require('https');
const { getStore } = require('@netlify/blobs');

/* ── HTTP GET avec suivi redirections ── */
function httpsGet(url, binary = false) {
  return new Promise((resolve, reject) => {
    try {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DIANE-Simulateur/1.0)',
          'Accept': binary ? 'application/pdf,*/*' : 'text/html,*/*',
        },
      }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : 'https://www.santepubliquefrance.fr' + res.headers.location;
          return httpsGet(redirectUrl, binary).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf-8'),
        }));
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout 30s')); });
    } catch(e) { reject(e); }
  });
}

/* ── HTTP POST JSON ── */
function httpsPost(url, bodyObj) {
  return new Promise((resolve, reject) => {
    try {
      const bodyStr = JSON.stringify(bodyObj);
      const parsed  = new URL(url);
      const options = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      };
      const req = https.request(options, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout POST 60s')); });
      req.write(bodyStr);
      req.end();
    } catch(e) { reject(e); }
  });
}

/* ── Trouver l'URL directe du dernier PDF OSCOUR ── */
async function findPdfUrl() {
  const BASE = 'https://www.santepubliquefrance.fr';

  /* Étape 1 : page principale OSCOUR */
  const mainPage = await httpsGet(BASE + '/surveillance-syndromique-sursaud-R/reseau-oscour-R-organisation-de-la-surveillance-coordonnee-des-urgences');
  console.log('[update-bulletin] Page SPF status:', mainPage.status, '— taille:', mainPage.body.length, 'chars');

  /* Chercher PDF directement */
  const directPdf = [...mainPage.body.matchAll(/href="([^"]*bullnat[^"]*\.pdf)"/gi)];
  if (directPdf.length) {
    const raw = directPdf[0][1];
    const url = raw.startsWith('http') ? raw : BASE + raw;
    console.log('[update-bulletin] PDF direct trouvé:', url);
    return url;
  }

  /* Chercher lien vers page bulletin */
  const bulletinLinks = [...mainPage.body.matchAll(/href="([^"]*bulletin[^"]*oscour[^"]*)"/gi)];
  console.log('[update-bulletin] Liens bulletin trouvés:', bulletinLinks.length);

  if (!bulletinLinks.length) {
    /* Chercher n'importe quel PDF SPF lié à OSCOUR */
    const anyPdf = [...mainPage.body.matchAll(/href="([^"]*oscour[^"]*\.pdf[^"]*)"/gi)];
    if (anyPdf.length) {
      const raw = anyPdf[0][1];
      return raw.startsWith('http') ? raw : BASE + raw;
    }
    throw new Error('Aucun lien bulletin ni PDF trouvé sur la page SPF OSCOUR');
  }

  /* Charger la page intermédiaire du bulletin */
  const raw0 = bulletinLinks[0][1];
  const bulletinPageUrl = raw0.startsWith('http') ? raw0 : BASE + raw0;
  console.log('[update-bulletin] Page bulletin intermédiaire:', bulletinPageUrl);

  const bulletinPage = await httpsGet(bulletinPageUrl);
  const pdfs = [...bulletinPage.body.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)];
  console.log('[update-bulletin] PDFs trouvés sur page bulletin:', pdfs.length);

  if (!pdfs.length) throw new Error('Aucun PDF sur la page du bulletin: ' + bulletinPageUrl);

  const rawPdf = pdfs[0][1];
  return rawPdf.startsWith('http') ? rawPdf : BASE + rawPdf;
}

/* ── Extraction via Google Gemini ── */
async function extractWithGemini(pdfBase64) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY non définie');

  const prompt = `Tu es un extracteur de données médicales. Analyse ce bulletin OSCOUR® SPF.
Retourne UNIQUEMENT un JSON brut valide (sans markdown, sans texte avant/après) :
{
  "semaine": "ex: S12 — 2026",
  "periode": "ex: 16 au 22 mars 2026",
  "numero": "1093",
  "date_publication": "24.03.2026",
  "passages_total": 361245,
  "passages_moins15": 83030,
  "passages_15_74": 220797,
  "passages_75plus": 57418,
  "hospit_total": 79125,
  "hospit_moins2": 3193,
  "hospit_2_14": 5629,
  "hospit_15_74": 42265,
  "hospit_75plus": 28035,
  "hospit_evol_total": 3.02,
  "top10": [
    {"rang":1,"label":"Traumatisme","semaine":99623,"prec":91728,"var":8.61}
  ],
  "points_cles": ["phrase 1","phrase 2","phrase 3","phrase 4"]
}
Si une valeur est absente du bulletin, mets null. JSON uniquement.`;

  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { text: prompt },
    ]}],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  };

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const res = await httpsPost(geminiUrl, body);

  if (res.status !== 200) throw new Error(`Gemini HTTP ${res.status}: ${res.body.slice(0,300)}`);

  const json  = JSON.parse(res.body);
  const text  = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```(?:json)?/gi, '').trim();
  return JSON.parse(clean);
}

/* ── Handler principal ── */
exports.handler = async function () {
  console.log('[update-bulletin] Démarrage —', new Date().toISOString());

  try {
    /* 1. Trouver le PDF */
    const pdfUrl = await findPdfUrl();
    console.log('[update-bulletin] PDF URL finale:', pdfUrl);

    /* 2. Télécharger */
    const pdf = await httpsGet(pdfUrl, true);
    if (pdf.status !== 200) throw new Error(`PDF download HTTP ${pdf.status}`);
    console.log(`[update-bulletin] PDF téléchargé: ${Math.round(pdf.body.length / 1024)} Ko`);

    /* 3. Extraire via Gemini */
    const data = await extractWithGemini(pdf.body.toString('base64'));
    console.log('[update-bulletin] Extrait:', data.semaine, '— passages:', data.passages_total);

    /* 4. Stocker */
    const store = getStore('oscour-bulletin');
    await store.set('latest', JSON.stringify({ ...data, pdf_url: pdfUrl, updated_at: new Date().toISOString() }));
    console.log('[update-bulletin] ✅ Stocké');

    return { statusCode: 200, body: JSON.stringify({ ok: true, semaine: data.semaine }) };

  } catch (err) {
    console.error('[update-bulletin] ❌', err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
