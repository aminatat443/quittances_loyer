'use strict';

/* Cas extrême pour valider la mise en page A4 :
   noms très longs, montant élevé converti en toutes lettres, observations longues,
   paiements partiels, puis trois quittances distinctes sur une même feuille.
   Usage : node scripts/stress-print.js */

const config = require('../src/config');
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

const { purgeUnitsLike } = require('./purge-demo');
const db = require('../src/db');

async function purge() {
  await purgeUnitsLike(db, 'Stress %');
}

async function main() {
  await purge();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  let r = await send('/login');
  r = await send('/login', { method: 'POST', form: {
    _csrf: tokenOf(r.body), username: config.admin.username, password: config.admin.password } });

  r = await send('/logements/nouveau');
  const t1 = tokenOf(r.body);
  const floor = Number(/name="floor_id"[^>]*>\s*<option value="(\d+)"/.exec(r.body)[1]);
  const names = ['Stress AAAA', 'Stress BBBB', 'Stress CCCC'];
  for (const n of names) {
    await send('/logements/nouveau', { method: 'POST', form: {
      _csrf: t1, name: n, floor_id: floor, unit_type_code: 'A', default_rent: 999990, status: 'available', notes: '' } });
  }
  r = await send('/locataires/nouveau');
  const t2 = tokenOf(r.body);
  const units = [...r.body.matchAll(/<option value="(\d+)"[^>]*>\s*([^<]*Stress[^<]*)/g)]
    .map(m => ({ id: Number(m[1]), label: m[2].trim() }));
  if (units.length < 3) throw new Error('Trois logements de test nécessaires, trouvés: ' + units.length);

  const longNames = [
    ['Mariame-Fatouma', 'Ndiaye-Diallo Bâ'],
    ['Cheikh-Ahmadou', 'Sow-Ba-Diallo'],
    ['Aminata-Djénaba', 'Diallo-Duval'],
  ];
  const createdIds = [];
  for (let i = 0; i < 3; i++) {
    const res = await send('/locataires/nouveau', { method: 'POST', form: {
      _csrf: t2, first_name: longNames[i][0], last_name: longNames[i][1],
      phone: '+221 77 123 45 67', address: 'Villa 12, rue 345, Almadies, Dakar 10800, Sénégal',
      notes: '', unit_id: units[i].id, start_date: `${year}-01-05`, monthly_rent: '' } });
    const id = /\/locataires\/(\d+)/.exec(res.location || '');
    if (id) createdIds.push(Number(id[1]));
    console.log('locataire', longNames[i].join(' '), '→', res.status);
  }

  r = await send('/quittances/nouvelle');
  const t3 = tokenOf(r.body);
  const opts = [...r.body.matchAll(/<option value="(\d+)" data-tenant-id="(\d+)"/g)]
    .map(m => ({ tenancy: Number(m[1]), tenant: Number(m[2]) }));
  const stress = opts.filter(o => createdIds.includes(o.tenant));
  if (stress.length !== 3) throw new Error('Locations de test incomplètes: ' + JSON.stringify(stress));

  const obs = 'Règlement en trois versements, dont un par Wave le 5 et un virement bancaire le 12, '
    + 'frais bancaires à la charge du locataire, état des lieux reporté, logement à rendre en parfait état';
  const plan = [
    [stress[0].tenancy, 499995, 'wave', `Acompte ${obs}`],
    [stress[0].tenancy, 499995, 'virement', 'Solde avec observations très longues : ' + obs],
    [stress[1].tenancy, 300000, 'especes', obs],
    [stress[1].tenancy, 699990, 'orange_money', 'Deuxième versement'],
    [stress[2].tenancy, 999990, 'especes', ''],
  ];
  const docs = [];
  for (const [tenancy, amount, method, note] of plan) {
    const res = await send('/paiements', { method: 'POST', form: {
      _csrf: t3, tenancy_id: tenancy, amount, paid_at: `${year}-${String(month).padStart(2, '0')}-10`,
      method, period_year: year, period_month: month, observations: note, generate: 'auto' } });
    const id = /\/quittances\/(\d+)/.exec(res.location || '');
    if (id) docs.push(Number(id[1]));
    console.log('paiement', amount, '→', res.status, res.location);
  }
  console.log('documents générés:', docs.join(', '));
  console.log(`\nVérifier dans le navigateur : ${BASE}/impression/apercu?ids=${docs.slice(-3).join(',')}&mode=trio`);
}

main().catch(e => { console.error('ÉCHEC:', e.message); process.exit(1); });
