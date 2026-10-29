'use strict';

/**
 * Service worker de la PWA « Loyers ».
 *
 * Périmètre volontairement limité : seule la COQUILLE (CSS, JS, icônes, manifest,
 * page d'accueil hors ligne) est mise en cache. Les pages, /api et les documents
 * sont toujours demandés au serveur Node.js, car les locataires, paiements et
 * quittances vivent dans PostgreSQL sur ce serveur — pas dans le navigateur.
 * Hors connexion, l'interface s'ouvre donc sur une page qui le dit, au lieu de
 * laisser croire que les données sont consultables.
 *
 * Version à incrémenter à chaque modification d'un fichier precaché : l'ancienne
 * cache est supprimé à l'activation, aucune version obsolète ne survit.
 */

const VERSION = 'quittances-pwa-v1';
const CACHE = `${VERSION}-coquille`;
const OFFLINE_URL = '/hors-ligne';

const SHELL = [
  OFFLINE_URL,
  '/manifest.webmanifest',
  '/static/css/app.css',
  '/static/css/print.css',
  '/static/js/app.js',
  '/static/js/pwa.js',
  '/static/vendor/tailwind.js',
  '/static/vendor/lucide.min.js',
  '/static/icons/icon.svg',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

/** Rien d'autre n'est caché : ni les pages, ni /api, ni /signatures, ni les PDF. */
const CACHEABLE = /^\/(static\/|manifest\.webmanifest$|hors-ligne$)/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const results = await Promise.allSettled(SHELL.map(url => cache.add(url)));
    const missing = SHELL.filter((url, i) => results[i].status === 'rejected');
    if (missing.length) console.warn('[sw] hors ligne partielle, ressources indisponibles :', missing);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
    for (const client of await self.clients.matchAll({ type: 'window' })) {
      client.postMessage({ type: 'sw-actived', version: VERSION });
    }
  })());
});

/**
 * Le nouveau service worker attend que l'utilisateur valide la mise à jour depuis
 * le bandeau « Nouvelle version disponible » : recharger d'autorité ferait perdre
 * une saisie de paiement en cours.
 */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Une requête POST (paiement, quittance, envoi) n'est jamais rejouée plus tard.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // wa.me, API WhatsApp, liens externes : transmis au réseau tels quels.
  if (url.origin !== self.location.origin) return;

  if (CACHEABLE.test(url.pathname)) {
    event.respondWith(cachedAsset(event));
  } else if (request.mode === 'navigate') {
    event.respondWith(navigated(request));
  }
});

async function navigated(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE);
    const shell = await cache.match(OFFLINE_URL);
    return shell || new Response(
      'Application hors ligne : le serveur Node.js est injoignable et aucune donnée n\'est stockée dans le navigateur.',
      { status: 504, headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  }
}

/** Cache d'abord, réutilisation en arrière-plan : la page se lance sans attendre le réseau. */
function cachedAsset(event) {
  return (async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request);
    const revalidation = fetch(event.request).then(async (response) => {
      if (response && response.ok && response.type === 'basic') {
        await cache.put(event.request, response.clone());
      }
      return response;
    }).catch(() => null);
    event.waitUntil(revalidation);
    if (hit) return hit;
    const fresh = await revalidation;
    // Une ressource jamais vue et inaccessible ne doit pas faire échouer la page entière.
    return fresh || new Response('', { status: 504 });
  })();
}
