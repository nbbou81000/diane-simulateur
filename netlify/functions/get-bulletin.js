/**
 * get-bulletin.js — Netlify Function
 * Lit les données du dernier bulletin OSCOUR® depuis Netlify Blobs
 * et les sert à encyclopedie.html
 */

const { getStore } = require('@netlify/blobs');

const CORS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'public, max-age=3600',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const store = getStore('oscour-bulletin');
    const raw   = await store.get('latest');

    if (!raw) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ ok: false, reason: 'Aucun bulletin stocké — première exécution du cron en attente' }),
      };
    }

    const data = JSON.parse(raw);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, ...data }),
    };

  } catch (err) {
    console.error('[get-bulletin]', err.message);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
