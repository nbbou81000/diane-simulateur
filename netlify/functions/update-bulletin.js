/**
 * update-bulletin.js — Netlify Scheduled Function
 * Cron : mercredi 16h00 UTC, retry jeudi 10h UTC
 *
 * Stratégie : construction directe de l'URL du PDF par date
 * Pattern SPF : bullnat_oscour_YYYYMMDD.pdf
 * Publié le mardi ou mercredi suivant la semaine de référence
 */

const https = require('https');
const { getStore } = require('@netlify/blobs');

/* ── HTTP GET avec redirections ── */
function httpsGet(url, binary = false, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    try {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': binary ? 'application/pdf,application/octet-stream,*/*' : 'text/html,application/xhtml+xml,*/*;q=0.9',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Referer': 'https://www.santepubliquefrance.fr/',
          'Sec-Fetch-Dest': binary ? 'document' : 'navigate',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          ...extraHeaders,
        },
      }, (res) => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : 'https://www.santepubliquefrance.fr' + res.headers.location;
          /* Passer les cookies de session si présents */
          const cookies = res.headers['set-cookie'];
          const cookieHeader = cookies ? { 'Cookie': cookies.map(c => c.split(';')[0]).join('; ') } : {};
          return httpsGet(next, binary, cookieHeader).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => resolve({
          status:  res.statusCode,
          headers: res.headers,
          body:    binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf-8'),
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
      const req = https.request({
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
      }, (res) => {
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

/* ── Formater une date en YYYYMMDD ── */
function dateToStr(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/* ── Générer les dates candidates à tester ── */
function getCandidateDates() {
  const now = new Date();
  const candidates = [];

  /* Tester les 14 derniers jours (mardi et mercredi de chaque semaine) */
  for (let i = 0; i <= 14; i++) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    const dow = d.getUTCDay(); // 0=dim, 1=lun, 2=mar, 3=mer
    if (dow === 2 || dow === 3) { // mardi ou mercredi
      candidates.push(dateToStr(d));
    }
  }
  return candidates;
}

/* ── Trouver le dernier PDF disponible par force brute sur les dates ── */
async function findLatestPdf() {
  const BASE = 'https://www.santepubliquefrance.fr';

  /* URLs candidates construites à partir des dates récentes */
  const dates = getCandidateDates();
  console.log('[update-bulletin] Dates candidates:', dates.join(', '));

  /* Patterns d'URL connus pour les bulletins OSCOUR SPF */
  const patterns = [
    d => `${BASE}/content/download/bullnat_oscour_${d}.pdf`,
    d => `${BASE}/import/media/docs/bullnat_oscour_${d}.pdf`,
    d => `${BASE}/ftp/upload/published-report/doc/bullnat_oscour_${d}.pdf`,
    d => `${BASE}/surveillance-syndromique-sursaud-R/documents/bulletin-national/${d.slice(0,4)}/bulletin-national-d-information-oscour-du-${formatDateFr(d)}`,
  ];

  for (const date of dates) {
    for (const makeUrl of patterns) {
      const url = makeUrl(date);
      try {
        console.log('[update-bulletin] Test:', url);
        /* HEAD request pour vérifier existence sans télécharger */
        const check = await new Promise((resolve, reject) => {
          const parsed = new URL(url);
          const req = https.request({
            hostname: parsed.hostname,
            path: parsed.pathname,
            method: 'HEAD',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DIANE-Simulateur/1.0)' },
          }, res => {
            resolve({ status: res.statusCode, location: res.headers.location });
          });
          req.on('error', reject);
          req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });

        if (check.status === 200) {
          console.log('[update-bulletin] ✅ PDF trouvé:', url);
          return url;
        }
        if ([301,302].includes(check.status) && check.location) {
          const finalUrl = check.location.startsWith('http') ? check.location : BASE + check.location;
          if (finalUrl.endsWith('.pdf')) {
            console.log('[update-bulletin] ✅ PDF via redirect:', finalUrl);
            return finalUrl;
          }
        }
      } catch(_) { /* continuer */ }
    }
  }

  /* Fallback : scraping de la page de liste des bulletins */
  return await scrapeBulletinPage();
}

/* ── Formatter date YYYYMMDD en format français pour URL ── */
function formatDateFr(dateStr) {
  const months = ['janvier','fevrier','mars','avril','mai','juin','juillet','aout','septembre','octobre','novembre','decembre'];
  const y = dateStr.slice(0,4), m = parseInt(dateStr.slice(4,6))-1, d = parseInt(dateStr.slice(6,8));
  return `${d}-${months[m]}-${y}`;
}

/* ── Scraping page bulletins (fallback) ── */
async function scrapeBulletinPage() {
  const BASE = 'https://www.santepubliquefrance.fr';
  const listUrl = BASE + '/surveillance-syndromique-sursaud-R/documents/bulletin-national';

  console.log('[update-bulletin] Scraping page liste:', listUrl);
  const page = await httpsGet(listUrl);
  console.log('[update-bulletin] Status:', page.status, '— taille:', page.body.length);

  /* Chercher tous les liens PDF dans la page */
  const allPdfs = [...page.body.matchAll(/href="([^"]*bullnat[^"]*(?:\.pdf|bulletin[^"]*))"/gi)];
  if (allPdfs.length) {
    const raw = allPdfs[0][1];
    const url = raw.startsWith('http') ? raw : BASE + raw;
    console.log('[update-bulletin] PDF via scraping:', url);
    return url;
  }

  /* Dernier recours : page principale OSCOUR */
  const mainUrl = BASE + '/surveillance-syndromique-sursaud-R/reseau-oscour-R-organisation-de-la-surveillance-coordonnee-des-urgences';
  const main = await httpsGet(mainUrl);
  const pdfs = [...main.body.matchAll(/href="([^"]*\.pdf)"/gi)];
  if (pdfs.length) {
    const raw = pdfs[0][1];
    return raw.startsWith('http') ? raw : BASE + raw;
  }

  throw new Error('Impossible de trouver le bulletin PDF sur le site SPF');
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
    {"rang":1,"label":"Traumatisme","semaine":99623,"prec":91728,"var":8.61},
    {"rang":2,"label":"Douleurs abdominales non spécifiques","semaine":18245,"prec":18158,"var":0.48},
    {"rang":3,"label":"Douleur thoracique","semaine":13628,"prec":13310,"var":2.39},
    {"rang":4,"label":"Malaise","semaine":12896,"prec":12574,"var":2.56},
    {"rang":5,"label":"Infections ORL","semaine":11315,"prec":10097,"var":12.06},
    {"rang":6,"label":"Neurologie autre","semaine":10612,"prec":10365,"var":2.38},
    {"rang":7,"label":"Douleurs abdominales spécifiques","semaine":10036,"prec":10055,"var":-0.19},
    {"rang":8,"label":"Infection cutanée / sous-cutanée","semaine":6071,"prec":5832,"var":4.10},
    {"rang":9,"label":"Infection urinaire","semaine":5602,"prec":5293,"var":5.84},
    {"rang":10,"label":"Pneumopathie","semaine":4870,"prec":4862,"var":0.16}
  ],
  "points_cles": ["phrase 1","phrase 2","phrase 3","phrase 4"]
}
Extrais les vraies valeurs du PDF. JSON uniquement, pas de markdown.`;

  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
      { text: prompt },
    ]}],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await httpsPost(url, body);
  if (res.status !== 200) throw new Error(`Gemini HTTP ${res.status}: ${res.body.slice(0,300)}`);

  const json  = JSON.parse(res.body);
  const text  = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const clean = text.replace(/```(?:json)?/gi, '').trim();
  return JSON.parse(clean);
}

/* ── Handler ── */
exports.handler = async function () {
  console.log('[update-bulletin] Démarrage —', new Date().toISOString());
  try {
    const pdfUrl = await findLatestPdf();
    console.log('[update-bulletin] PDF:', pdfUrl);

    /* Warm-up : visiter la page principale pour récupérer les cookies de session */
    console.log('[update-bulletin] Warm-up session SPF…');
    let sessionCookies = {};
    try {
      const warmup = await httpsGet('https://www.santepubliquefrance.fr/surveillance-syndromique-sursaud-R');
      const setCookie = warmup.headers && warmup.headers['set-cookie'];
      if (setCookie) {
        const cookieStr = (Array.isArray(setCookie) ? setCookie : [setCookie])
          .map(c => c.split(';')[0]).join('; ');
        sessionCookies = { 'Cookie': cookieStr };
        console.log('[update-bulletin] Cookies session récupérés');
      }
    } catch(e) { console.warn('[update-bulletin] Warm-up échoué (non bloquant):', e.message); }

    const pdf = await httpsGet(pdfUrl, true, sessionCookies);
    if (pdf.status !== 200) throw new Error(`PDF download HTTP ${pdf.status}`);
    /* Vérifier que c'est bien un PDF (commence par %PDF) */
    const pdfHeader = pdf.body.slice(0, 10).toString('ascii');
    console.log(`[update-bulletin] PDF header: "${pdfHeader}" — taille: ${Math.round(pdf.body.length / 1024)} Ko`);
    if (!pdfHeader.startsWith('%PDF')) {
      const preview = pdf.body.slice(0, 300).toString('utf-8').replace(/[\n\r]/g, ' ');
      throw new Error(`Contenu non-PDF. Header: "${pdfHeader}". Aperçu: ${preview.slice(0, 150)}`);
    }

    const data = await extractWithGemini(pdf.body.toString('base64'));
    console.log('[update-bulletin] Extrait:', data.semaine);

    const store = getStore('oscour-bulletin');
    await store.set('latest', JSON.stringify({ ...data, pdf_url: pdfUrl, updated_at: new Date().toISOString() }));
    console.log('[update-bulletin] ✅ Stocké');

    return { statusCode: 200, body: JSON.stringify({ ok: true, semaine: data.semaine }) };
  } catch(err) {
    console.error('[update-bulletin] ❌', err.message);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
