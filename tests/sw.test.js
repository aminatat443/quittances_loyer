'use strict';

/* Section 20 — logique du service worker, exécutée hors navigateur.
   src/public/sw.js est chargé dans un contexte isolé avec de faux `caches`,
   `fetch` et `Response` : on vérifie ce que le worker renverrait réellement,
   sans dépendre d'un Chrome de test. C'est le point sensible de la PWA — une page
   métier servie depuis le cache afficherait de vieilles quittances en faisant
   croire qu'elles sont à jour. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ORIGIN = 'http://localhost:3000';
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'sw.js'), 'utf8');

const SHELL_URLS = ['/hors-ligne', '/manifest.webmanifest', '/static/css/app.css', '/static/css/print.css',
  '/static/js/app.js', '/static/js/pwa.js', '/static/vendor/tailwind.js', '/static/vendor/lucide.min.js',
  '/static/icons/icon.svg', '/static/icons/icon-192.png', '/static/icons/icon-512.png'];

const body = (text) => ({ ok: true, type: 'basic', status: 200, body: text, clone() { return this; } });
const req = (url, { method = 'GET', mode = 'no-cors' } = {}) => ({ method, mode, url });

/** Charge sw.js dans un bac à sable. `state.online` et `state.served` se pilotent au fil du test. */
function loadWorker() {
  const state = { online: true, served: {} };
  const listeners = {};
  const store = new Map();
  const fetched = [];

  async function doFetch(request) {
    fetched.push(request.url);
    if (!state.online) throw new TypeError('Failed to fetch');
    return state.served[request.url]
      || { ok: false, status: 404, type: 'basic', body: 'introuvable', clone() { return this; } };
  }

  function cacheFor(name) {
    if (!store.has(name)) store.set(name, new Map());
    const map = store.get(name);
    const key = (k) => (typeof k === 'string' ? new URL(k, ORIGIN).href : k.url);
    return {
      put: async (k, res) => map.set(key(k), res),
      match: async (k) => map.get(key(k)),
      add: async (k) => {
        const res = await doFetch(req(key(k)));
        if (!res.ok) throw new Error(`${key(k)} n'est pas disponible`);
        map.set(key(k), res);
      },
      keys: async () => [...map.keys()].map(url => ({ url })),
    };
  }

  const sandbox = {
    URL, console, Promise, Response, TypeError, Error,
    fetch: (input) => doFetch(typeof input === 'string' ? req(new URL(input, ORIGIN).href) : input),
    caches: {
      open: async (name) => cacheFor(name),
      keys: async () => [...store.keys()],
      delete: async (name) => store.delete(name),
    },
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
      clients: { matchAll: async () => [], claim: async () => {} },
      skipWaiting: () => { sandbox.skipped = true; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const event = (extra) => ({
    __waits: [],
    waitUntil(p) { this.__waits.push(p); },
    respondWith(p) { this.__response = p; },
    ...extra,
  });

  const fire = async (type, evt) => {
    for (const fn of listeners[type] || []) await fn(evt);
    await Promise.all(evt.__waits);
    return evt;
  };

  return { fire, event, state, store, fetched, sandbox, cache: () => store.get([...store.keys()][0]) };
}

/** Installe le worker avec la coquille complète en cache. */
async function installed() {
  const w = loadWorker();
  for (const u of SHELL_URLS) w.state.served[ORIGIN + u] = body('coquille ' + u);
  await w.fire('install', w.event());
  return w;
}

test('l\'installation precache la coquille, y compris la page d\'avertissement', async () => {
  const w = await installed();
  assert.ok(w.cache().size >= SHELL_URLS.length, 'les ressources de lancement sont en cache');
  assert.ok(w.cache().has(ORIGIN + '/hors-ligne'), 'la page d\'avertissement est disponible sans serveur');
});

test('une ressource absente n\'interrompt pas l\'installation du worker', async () => {
  const w = loadWorker();
  w.state.served[ORIGIN + '/hors-ligne'] = body('ok');
  await w.fire('install', w.event());
  assert.strictEqual(w.store.size, 1, 'le cache est créé malgré les entrées manquantes');
  assert.strictEqual(w.cache().size, 1);
});

test('un fichier de coquille est servi depuis le cache puis réactualisé en arrière-plan', async () => {
  const w = await installed();
  w.cache().set(ORIGIN + '/static/css/app.css', body('style en cache'));
  w.fetched.length = 0;

  const evt = await w.fire('fetch', w.event({ request: req(ORIGIN + '/static/css/app.css') }));
  assert.strictEqual((await evt.__response).body, 'style en cache',
    'l\'interface s\'ouvre sans attendre le réseau');
  assert.deepStrictEqual(w.fetched, [ORIGIN + '/static/css/app.css'], 'une réactualisation est demandée');
});

test('une page vient toujours du serveur et n\'est jamais archivée', async () => {
  const w = await installed();
  const url = ORIGIN + '/quittances/mois';
  w.state.served[url] = body('page du serveur');

  const evt = await w.fire('fetch', w.event({ request: req(url, { mode: 'navigate' }) }));
  assert.strictEqual((await evt.__response).body, 'page du serveur');
  assert.strictEqual(w.cache().has(url), false,
    'rien d\'archive : une quittance émise entre-temps ne peut pas ressurgir périmée');
});

test('serveur injoignable : la navigation retombe sur la page qui dit la vérité', async () => {
  const w = await installed();
  w.state.online = false;

  const evt = await w.fire('fetch', w.event({ request: req(ORIGIN + '/parametres', { mode: 'navigate' }) }));
  const res = await evt.__response;
  assert.strictEqual(res.body, 'coquille /hors-ligne', 'c\'est la page d\'avertissement, pas une ancienne vue');
});

test('sans cache ni serveur, une navigation échoue franchement plutôt que de mentir', async () => {
  const w = loadWorker();
  w.state.online = false;

  const evt = await w.fire('fetch', w.event({ request: req(ORIGIN + '/', { mode: 'navigate' }) }));
  const res = await evt.__response;
  assert.strictEqual(res.status, 504);
  assert.match(await res.text(), /aucune donnée n'est stockée dans le navigateur/,
    'le texte dit exactement ce qui manque, sans laisser croire à un mode hors ligne complet');
});

test('POST, API, signatures et liens externes ne sont jamais interceptés', async () => {
  const w = await installed();
  const cases = [
    [req(ORIGIN + '/paiements/nouveau', { method: 'POST' }), 'une saisie n\'est pas rejouée plus tard'],
    [req(ORIGIN + '/api/periode?tenant_id=1&year=2026&month=10'), 'les données calculées viennent du serveur'],
    [req(ORIGIN + '/signatures/ma-signature.png'), 'une signature importée n\'est pas conservée en local'],
    [req(ORIGIN + '/quittances/2/pdf'), 'un document n\'est pas resservi hors ligne'],
    [req('https://wa.me/221771234567'), 'WhatsApp est transmis au réseau'],
    [req('https://graph.facebook.com/v20.0/1/messages'), 'l\'API Meta est transparente pour le worker'],
  ];
  for (const [request, why] of cases) {
    const evt = await w.fire('fetch', w.event({ request }));
    assert.strictEqual(evt.__response, undefined, `${request.url} : ${why}`);
  }
});

test('l\'activation supprime les caches des versions précédentes', async () => {
  const w = await installed();
  const obsolete = [...w.store.keys()][0].replace(/-coquille$/, '') + '-coquille-0';
  w.store.set(obsolete, new Map([['x', 'y']]));
  assert.strictEqual(w.store.size, 2);

  await w.fire('activate', w.event());
  assert.deepStrictEqual([...w.store.keys()].length, 1, 'un seul cache survit');
  assert.ok(!w.store.has(obsolete), 'la version obsolète a été effacée');
});

test('la mise à jour n\'est appliquée que sur demande de l\'utilisateur', async () => {
  const w = await installed();
  await w.fire('message', w.event({ data: 'skip-waiting' }));
  assert.strictEqual(w.sandbox.skipped, true, 'le worker attend bien un message explicite');

  const w2 = await installed();
  await w2.fire('install', w2.event());
  assert.strictEqual(w2.sandbox.skipped, undefined,
    'installer ne prend jamais la main sur une page ouverte : une saisie serait perdue');
});
