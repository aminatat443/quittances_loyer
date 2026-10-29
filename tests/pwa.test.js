'use strict';

/* Section 20 — application installable (PWA).
   Ce qui est vérifié ici : un manifest complet servi à la racine du scope, des
   icônes PNG réellement aux tailles annoncées, un service worker qui ne precache
   que des ressources accessibles sans session, une page « hors ligne » qui
   n'affirme jamais que les données le sont, et un gabarit d'impression qui reste
   étranger à tout cela (le PDF est produit par Chromium, pas par le navigateur). */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { loadApp, seedTenant } = require('./helpers');

const { db, config, services } = loadApp();
// Après loadApp() : src/services/pdf tire sa configuration de src/config, qui n'est
// rechargé sur la base de test qu'à partir de cet instant.
const pdf = require('../src/services/pdf');
const PUBLIC = path.join(__dirname, '..', 'src', 'public');

let server;
let base;
let cookie = '';

async function startServer() {
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

test.before(startServer);

async function send(url, { method = 'GET', form } = {}) {
  const headers = { Cookie: cookie };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(base + url, { method, headers, body, redirect: 'manual' });
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
  return { status: res.status, type: res.headers.get('content-type'),
    location: res.headers.get('location'), body: await res.text() };
}

const tokenOf = html => {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  assert.ok(m, 'un formulaire avec jeton CSRF est attendu');
  return m[1];
};

async function login() {
  const loginPage = await send('/login');
  const posted = await send('/login', { method: 'POST', form: {
    _csrf: tokenOf(loginPage.body), username: config.admin.username, password: 'test-motdepasse' } });
  assert.strictEqual(posted.status, 302, 'la connexion ouvre la session avant de tester les pages');
}

test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

/* ------------------------------------------------------------------ manifest */

test('le manifest est public, enraciné au scope de l\'application et complet', async () => {
  const res = await send('/manifest.webmanifest');
  assert.strictEqual(res.status, 200, 'accessible sans être connecté : l\'installation le précède');
  assert.match(res.type, /application\/manifest\+json/);

  const m = JSON.parse(res.body);
  assert.strictEqual(m.name, 'Gestion des quittances de loyer');
  assert.strictEqual(m.short_name, 'Loyers');
  assert.strictEqual(m.start_url, '/');
  assert.strictEqual(m.scope, '/');
  assert.strictEqual(m.display, 'standalone', 'fenêtre autonome, sans barre d\'adresse');
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);

  const any = m.icons.filter(i => i.purpose !== 'maskable').map(i => i.sizes);
  const maskable = m.icons.filter(i => i.purpose === 'maskable').map(i => i.sizes);
  assert.ok(any.includes('192x192') && any.includes('512x512'), 'icônes 192 et 512 en purpose any');
  assert.ok(maskable.length, 'une icône maskable est déclarée pour Android');
});

test('les icônes annoncées existent aux tailles exactes', () => {
  const m = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  for (const icon of m.icons) {
    const file = path.join(PUBLIC, icon.src.replace('/static', ''));
    assert.ok(fs.existsSync(file), `${icon.src} doit être généré`);
    const head = fs.readFileSync(file).subarray(0, 24);
    assert.strictEqual(head.readUInt32BE(16), Number(icon.sizes.split('x')[0]), `${icon.src} largeur`);
    assert.strictEqual(head.readUInt32BE(20), Number(icon.sizes.split('x')[1]), `${icon.src} hauteur`);
  }
  assert.ok(fs.existsSync(path.join(PUBLIC, 'icons', 'apple-touch-icon.png')), 'icône iOS');
});

/* ----------------------------------------------------------- service worker */

test('le service worker ne precache que des ressources accessibles sans connexion', async () => {
  const res = await send('/sw.js');
  assert.strictEqual(res.status, 200);
  assert.match(res.type, /javascript/);

  const source = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const offline = source.match(/const OFFLINE_URL = '([^']+)'/)[1];
  const list = [offline, ...source.match(/const SHELL = \[([\s\S]*?)\];/)[1]
    .match(/'([^']+)'/g).map(s => s.slice(1, -1))];
  assert.ok(list.length >= 7, 'la coquille precache les styles, les scripts et les icônes');
  for (const url of list) {
    const asset = await send(url);
    assert.strictEqual(asset.status, 200, `${url} doit être reachable hors session, sinon le cache échoue`);
  }
});

test('la mise en cache refuse les pages, les API, les signatures et les PDF', () => {
  const source = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
  const pattern = source.match(/const CACHEABLE = (\/.*\/);/)[1];
  const cacheable = new RegExp(pattern.slice(1, -1));
  for (const url of ['/static/css/app.css', '/static/js/pwa.js', '/manifest.webmanifest', '/hors-ligne']) {
    assert.ok(cacheable.test(url), `${url} : ressource de coquille`);
  }
  for (const url of ['/quittances/mois', '/api/periode', '/paiements/12/pdf', '/signatures/x.png', '/parametres']) {
    assert.ok(!cacheable.test(url), `${url} : données du serveur, jamais un vieux brouillon local`);
  }
  assert.match(source, /request\.method !== 'GET'/, 'aucune saisie (POST) n\'est rejouée plus tard');
  assert.match(source, /cache\.match\(OFFLINE_URL\)/, 'une navigation impossible retombe sur la page d\'avertissement');
});

test('la page hors ligne dit la vérité sur les données', async () => {
  const res = await send('/hors-ligne');
  assert.strictEqual(res.status, 200);
  assert.match(res.body, /ne sont pas enregistrées sur cet appareil/);
  assert.match(res.body, /PostgreSQL/);
  assert.match(res.body, /Aucun document n'a été envoyé, imprimé ni modifié/,
    'rien ne doit laisser croire qu\'un envoi a eu lieu pendant la coupure');
});

/* ------------------------------------------------------------------- vues */

test('les pages publient le manifest, les métadonnées mobiles et le bouton caché', async () => {
  await login();
  const page = await send('/parametres');
  assert.match(page.body, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(page.body, /<meta name="theme-color" content="#256343">/);
  assert.match(page.body, /rel="apple-touch-icon"/);
  assert.strictEqual((page.body.match(/apple-touch-startup-image/g) || []).length, 13,
    'les écrans de démarrage iOS sont déclarés pour chaque taille générée');
  assert.match(page.body, /src="\/static\/js\/pwa\.js"/);

  const buttons = page.body.match(/<[^>]*data-pwa-button[^>]*>/g) || [];
  assert.ok(buttons.length >= 2, 'un bouton dans le menu latéral et un dans Paramètres');
  for (const tag of buttons) {
    assert.match(tag, /\bhidden\b/, 'aucun faux bouton : masqué tant que le navigateur n\'a rien demandé');
  }
  assert.match(page.body, /Installer l'application/);
  assert.match(page.body, /Sur l'écran d'accueil/, 'la marche à suivre iOS est écrite noir sur blanc');
});

test('le gabarit d\'impression reste étranger à la PWA', async () => {
  const { tenancy } = await seedTenant(services, { name: 'PWA-IMP', rent: 40000 });
  const paid = await services.rent.recordPayment({ tenancy_id: tenancy.id, amount: 40000,
    paid_at: '2026-10-15', period_year: 2026, period_month: 10 });
  const html = await pdf.sheetsHtml([paid.receipt], 'trio');
  assert.doesNotMatch(html, /manifest|serviceWorker|pwa\.js/,
    'Chromium ne doit pas enregistrer de service worker ni afficher d\'invite d\'installation sur une quittance');
  assert.match(html, /print\.css/);
  await db.prepare('DELETE FROM receipts WHERE id = ?').run(paid.receipt.id);
});
