'use strict';

/* Parcours de démonstration : alimente la base avec deux locataires fictifs,
   des paiements partiels puis complets, et vérifie l'aperçu d'impression A4.
   Usage : node scripts/smoke.js  (serveur démarré sur PORT, .env lu automatiquement)
   Les données créées sont explicitement marquées "Demo" et peuvent être archivées. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const db = require('../src/db');
const { purgeUnitsLike } = require('./purge-demo');

const BASE = process.env.SMOKE_BASE || `http://localhost:${config.port}`;
let cookie = '';

async function send(url, { method = 'GET', form } = {}) {
  const headers = { Cookie: cookie };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(BASE + url, { method, headers, body, redirect: 'manual' });
  const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}

const tokenOf = html => {
  const m = /name="_csrf" value="([0-9a-f]+)"/.exec(html);
  if (!m) throw new Error('Jeton CSRF introuvable');
  return m[1];
};

async function main() {
  await db.assertReachable();
  await purgeUnitsLike(db, 'Demo %');
  await db.close();
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  let r = await send('/login');
  r = await send('/login', { method: 'POST', form: {
    _csrf: tokenOf(r.body), username: config.admin.username, password: config.admin.password } });
  console.log('connexion:', r.status);

  // 1. logements (idempotent : l'unicité étage+nom protège des doublons)
  r = await send('/logements/nouveau');
  const token = tokenOf(r.body);
  const floorId = Number(/name="floor_id"[^>]*>\s*<option value="(\d+)"/.exec(r.body)[1]);
  for (const [name, code, rent] of [['Demo A1', 'A', 40000], ['Demo B1', 'B', 20000]]) {
    const res = await send('/logements/nouveau', { method: 'POST', form: {
      _csrf: token, name, floor_id: floorId, unit_type_code: code, default_rent: rent, status: 'available', notes: '' } });
    console.log(`logement ${name}:`, res.status);
  }

  r = await send('/locataires/nouveau');
  const tkLoc = tokenOf(r.body);
  const units = [...r.body.matchAll(/<option value="(\d+)"[^>]*>\s*([^<]*Demo[^<]*)/g)]
    .map(m => ({ id: Number(m[1]), label: m[2].trim() }));
  console.log('logements disponibles:', units.map(u => u.label).join(' | '));

  // 2. deux locataires fictifs
  const demoTenants = [['Awa', 'Ndiaye', units[0]], ['Fatou', 'Sow', units[1]]];
  for (const [first, last, unit] of demoTenants) {
    const res = await send('/locataires/nouveau', { method: 'POST', form: {
      _csrf: tkLoc, first_name: first, last_name: last, phone: '', address: '', notes: 'Dossier de démonstration',
      unit_id: unit.id, start_date: `${year}-01-05`, monthly_rent: '' } });
    console.log(`locataire ${first} ${last}:`, res.status, res.location);
  }

  // 3. encaissements : partiel puis solde, pour chaque locataire
  r = await send('/quittances/nouvelle');
  const tk = tokenOf(r.body);
  // Seules les locations « Demo » sont ciblées : une base réelle contient déjà des
  // locataires dont la période est quittancée, et le parcours doit rester rejouable.
  const options = [...r.body.matchAll(/<option value="(\d+)" data-tenant-id="(\d+)"[^>]*>\s*([^<]*)/g)]
    .map(m => ({ tenancy: Number(m[1]), tenant: Number(m[2]), label: m[3].trim() }))
    .filter(o => /Demo/i.test(o.label));
  console.log('locations facturables:', options.map(o => o.label).join(' | '));
  if (options.length < 2) throw new Error('Les deux locations de démonstration sont introuvables');

  const plan = [
    [options[0], 15000, 'especes', 'Acompte sur le mois en cours'],
    [options[0], 25000, 'wave', 'Solde du mois'],
    [options[1], 20000, 'orange_money', 'Loyer réglé en une fois'],
  ];
  const docUrls = [];
  for (const [opt, amount, method, note] of plan) {
    const res = await send('/paiements', { method: 'POST', form: {
      _csrf: tk, tenancy_id: opt.tenancy, amount, paid_at: `${year}-${month}-10`,
      method, period_year: year, period_month: Number(month), observations: note, generate: 'auto' } });
    console.log(`paiement ${amount} FCFA (${note}):`, res.status, res.location);
    if (res.location) docUrls.push(res.location);
  }

  // 4. tentative de doublon : doit être refusée (le message est porté par la page suivante)
  const dup = await send('/paiements', { method: 'POST', form: {
    _csrf: tk, tenancy_id: options[0].tenancy, amount: 40000, paid_at: `${year}-${month}-11`,
    method: 'especes', period_year: year, period_month: Number(month), observations: 'test doublon', generate: 'auto' } });
  const afterDup = dup.location ? await send(dup.location) : dup;
  console.log('doublon de quittance intégrale:', dup.status,
    /déjà/i.test(afterDup.body) ? 'refusé et signalé' : 'MESSAGE ATTENDU INTROUVABLE');

  // 5. historique + aperçu A4 (les liens d'impression de groupe sont sur la page du mois)
  r = await send(`/quittances/mois?year=${year}&month=${Number(month)}`);
  const ids = [...new Set([...r.body.matchAll(/\/impression\/apercu\?ids=(\d+)/g)].map(m => m[1]))];
  console.log('documents du mois:', ids.length);

  r = await send(`/impression/apercu?ids=${ids.slice(0, 3).join(',')}&mode=trio`);
  console.log('aperçu trio:', r.status,
    '| feuilles:', (r.body.match(/class="a4-sheet"/g) || []).length,
    '| blocs:', (r.body.match(/class="rent-receipt/g) || []).length);
  fs.writeFileSync(path.join(os.tmpdir(), 'apercu-quittances.html'), r.body);

  r = await send(`/impression/apercu?ids=${ids[0]}&mode=copies`);
  console.log('aperçu 3 exemplaires:', r.status, '| blocs:', (r.body.match(/class="rent-receipt/g) || []).length);

  r = await send(`/export/quittances.csv?year=${year}&month=${Number(month)}`);
  console.log('export CSV:', r.status, '| lignes:', r.body.trim().split('\n').length);
  console.log(`\nAperçu enregistré : ${path.join(os.tmpdir(), 'apercu-quittances.html')}`);
}

main().catch(e => { console.error('ÉCHEC:', e.message); process.exit(1); });
