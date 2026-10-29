'use strict';

/* Section 19 — génération mensuelle en un clic.
   Règles vérifiées ici : aucune saisie répétitive, aucun formulaire intermédiaire,
   un lot groupé idempotent, jamais de quittance pour un loyer non encaissé,
   et une contrainte de base contre les quittances définitives en double. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const ejs = require('ejs');
const { loadApp, seedTenant } = require('./helpers');

const { db, config, services } = loadApp();
const { rent, share, tenants } = services;

const Y = 2026, M = 10;

const activeReceipts = async (tenancyId) =>
  db.prepare('SELECT * FROM receipts WHERE tenancy_id = ? AND cancelled = FALSE').all(tenancyId);
const fullCount = async (tenancyId) =>
  (await activeReceipts(tenancyId)).filter(r => r.type === 'quittance' || r.type === 'quittance_definitive').length;

test('un loyer non encaissé ne produit jamais une quittance : un avis de loyer est préparé', async () => {
  const { tenancy } = await seedTenant(services, { name: 'AVIS1', rent: 25000 });
  const result = await rent.generateOne(tenancy.id, Y, M);

  assert.strictEqual(result.kind, 'avis');
  assert.strictEqual(result.created, true);
  assert.strictEqual(result.receipt.type, 'avis_loyer');
  assert.strictEqual(result.receipt.is_avis, true);
  assert.strictEqual(result.receipt.is_full, false,
    'le document ne doit pas attester un paiement reçu');
  assert.strictEqual(result.receipt.amount_this, 0);
  assert.strictEqual(result.receipt.balance, 25000);
  assert.match(result.receipt.number, /^AL-\d{4}-\d+$/);
  assert.strictEqual(await fullCount(tenancy.id), 0, 'aucune quittance ne doit exister pour une période non réglée');

  const again = await rent.generateOne(tenancy.id, Y, M);
  assert.strictEqual(again.created, false, 'un second clic remplace le document, il ne le duplique pas');
  assert.strictEqual((await activeReceipts(tenancy.id)).filter(r => r.type === 'avis_loyer').length, 1);
});

test('l\'avis de loyer refuse une période déjà réglée et la quittance le rend caduc sans effacer l\'historique', async () => {
  const { tenancy } = await seedTenant(services, { name: 'AVIS2', rent: 30000 });
  const avis = (await rent.generateOne(tenancy.id, Y, M)).receipt;
  assert.strictEqual(avis.is_avis, true);

  const paid = await rent.recordPayment({ tenancy_id: tenancy.id, amount: 30000, paid_at: '2026-10-12',
    period_year: Y, period_month: M });
  assert.strictEqual(paid.receipt.is_full, true);

  await assert.rejects(() => rent.issueAvisLoyer(tenancy.id, Y, M), /réglé/,
    'un avis ne peut plus être émis alors que le loyer est payé');

  assert.strictEqual(await rent.getReceipt(avis.id), null, 'l\'avis n\'est plus le document valable');
  const raw = await db.prepare('SELECT cancelled FROM receipts WHERE id = ?').get(avis.id);
  assert.strictEqual(raw.cancelled, true, 'l\'avis est conservé dans l\'historique, pas supprimé');
  assert.strictEqual(await fullCount(tenancy.id), 1);
});

test('un paiement partiel génère un reçu partiel, pas une quittance', async () => {
  const { tenancy } = await seedTenant(services, { name: 'PART2', rent: 40000 });
  await rent.recordPayment({ tenancy_id: tenancy.id, amount: 12000, paid_at: '2026-10-04',
    period_year: Y, period_month: M }, { generate: 'none' });

  const result = await rent.generateOne(tenancy.id, Y, M);
  assert.strictEqual(result.receipt.type, 'recu_partiel');
  assert.strictEqual(result.receipt.balance, 28000);
  assert.strictEqual(await fullCount(tenancy.id), 0);
});

test('la génération en un clic ouvre la quittance définitive d\'une période réglée, sans doublon', async () => {
  const { tenancy } = await seedTenant(services, { name: 'CLIC1', rent: 20000 });
  await rent.recordPayment({ tenancy_id: tenancy.id, amount: 20000, paid_at: '2026-10-01',
    period_year: Y, period_month: M }, { generate: 'none' });

  const first = await rent.generateOne(tenancy.id, Y, M);
  assert.strictEqual(first.kind, 'quittance');
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.receipt.balance, 0);

  const second = await rent.generateOne(tenancy.id, Y, M);
  assert.strictEqual(second.created, false, 'la ligne est « Déjà générée » : réimpression, pas re-création');
  assert.strictEqual(second.receipt.id, first.receipt.id);
  assert.strictEqual((await activeReceipts(tenancy.id)).length, 1);
});

test('deux quittances définitives pour la même période sont refusées par la base', async () => {
  const { tenancy } = await seedTenant(services, { name: 'DUP1', rent: 50000 });
  await rent.recordPayment({ tenancy_id: tenancy.id, amount: 50000, paid_at: '2026-10-08',
    period_year: Y, period_month: M });

  await assert.rejects(() => rent.issueFinalReceipt(tenancy.id, Y, M), /déjà/i);

  await assert.rejects(
    () => db.prepare(`INSERT INTO receipts (number, type, tenancy_id, period_year, period_month)
                      VALUES ('DUP-TEST-01', 'quittance', ?, ?, ?)`).run(tenancy.id, Y, M),
    e => e.code === '23505' && e.constraint === 'uq_receipts_full_period',
    'l\'index partiel uq_receipts_full_period bloque au niveau de la base');

  // réédition volontaire : l'ancienne quittance est remplacée, jamais accumulée
  const reissued = await rent.issueFinalReceipt(tenancy.id, Y, M, { allow_full_reissue: true });
  assert.strictEqual(await fullCount(tenancy.id), 1);
  assert.notStrictEqual(reissued.number, 'DUP-TEST-01');
});

test('le lot mensuel traite toutes les locations en une passe groupée et reste idempotent', async () => {
  const paid = await seedTenant(services, { name: 'LOT1', rent: 40000 });
  const partial = await seedTenant(services, { name: 'LOT2', rent: 20000 });
  const pending = await seedTenant(services, { name: 'LOT3', rent: 25000 });
  await rent.recordPayment({ tenancy_id: paid.tenancy.id, amount: 40000, paid_at: '2026-10-02',
    period_year: Y, period_month: M }, { generate: 'none' });
  await rent.recordPayment({ tenancy_id: partial.tenancy.id, amount: 5000, paid_at: '2026-10-02',
    period_year: Y, period_month: M }, { generate: 'none' });

  const lot = await rent.generateMonth(Y, M);
  const byTenancy = new Map(lot.board.map(r => [r.tenancy_id, r]));
  assert.ok(byTenancy.has(paid.tenancy.id) && byTenancy.has(partial.tenancy.id) && byTenancy.has(pending.tenancy.id),
    'toutes les locations de la période sont traitées ensemble');

  const docOf = async id => (await activeReceipts(id))[0];
  assert.match((await docOf(paid.tenancy.id)).type, /quittance/);
  assert.strictEqual((await docOf(partial.tenancy.id)).type, 'recu_partiel');
  assert.strictEqual((await docOf(pending.tenancy.id)).type, 'avis_loyer');

  const documents = await Promise.all(lot.board.map(r => docOf(r.tenancy_id)));
  const numbers = documents.filter(Boolean).map(r => r.number);
  assert.strictEqual(new Set(numbers).size, numbers.length, 'les numéros restent uniques');

  const before = (await activeReceipts(paid.tenancy.id)).length + (await activeReceipts(partial.tenancy.id)).length
    + (await activeReceipts(pending.tenancy.id)).length;
  const rerun = await rent.generateMonth(Y, M);
  assert.strictEqual(rerun.created.length, 0, 'un second clic ne recrée rien');
  const after = (await activeReceipts(paid.tenancy.id)).length + (await activeReceipts(partial.tenancy.id)).length
    + (await activeReceipts(pending.tenancy.id)).length;
  assert.strictEqual(after, before);
  for (const row of rerun.board) {
    if ([paid, partial, pending].some(t => t.tenancy.id === row.tenancy_id)) {
      assert.notStrictEqual(row.doc_status, 'À générer', 'les lignes affichent « Déjà générée »');
    }
  }
});

test('le tableau du mois décrit chaque ligne sans redemander les informations de la fiche', async () => {
  const { tenancy, tenant } = await seedTenant(services, { name: 'BOARD', rent: 30000,
    first_name: 'Mariama', last_name: 'Fall', phone: '771234567', email: 'mariama@exemple.sn' });
  let row = (await rent.monthBoard(Y, M)).find(r => r.tenancy_id === tenancy.id);

  assert.strictEqual(row.tenant_name, 'Mariama Fall');
  assert.strictEqual(row.unit_name, 'BOARD');
  assert.strictEqual(row.floor_label, 'Premier étage');
  assert.strictEqual(row.email, 'mariama@exemple.sn');
  assert.strictEqual(row.payment_label, 'En attente de paiement');
  assert.strictEqual(row.doc_status, 'À générer');
  assert.strictEqual(row.action_label, 'Générer l\'avis de loyer');
  assert.strictEqual(row.action_kind, 'generate');
  assert.strictEqual((await tenants.currentTenancy(tenant.id)).monthly_rent, 30000,
    'le loyer convenu est réutilisé tel quel');

  await rent.recordPayment({ tenancy_id: tenancy.id, amount: 30000, paid_at: '2026-10-20',
    period_year: Y, period_month: M });
  row = (await rent.monthBoard(Y, M)).find(r => r.tenancy_id === tenancy.id);
  assert.strictEqual(row.payment_label, 'Intégralement payé');
  assert.strictEqual(row.doc_status, 'Quittance générée');
  assert.strictEqual(row.action_label, 'Réimprimer la quittance');
  assert.strictEqual(row.action_kind, 'reprint');
});

test('les partages ne préparent que des brouillons et disparaissent sans contact', async () => {
  const { tenancy } = await seedTenant(services, { name: 'SHARE', rent: 20000,
    phone: '+221 77 123 45 67', email: 'locataire@exemple.sn' });
  const doc = await rent.getReceipt((await rent.generateOne(tenancy.id, Y, M)).receipt.id);

  assert.strictEqual(share.internationalNumber('771234567'), '221771234567');
  assert.strictEqual(share.internationalNumber('+221 77 123 45 67'), '221771234567');
  assert.strictEqual(share.internationalNumber('00221771234567'), '221771234567');
  assert.strictEqual(share.internationalNumber('077 12 34 56 78'), '2217712345678');
  assert.strictEqual(share.internationalNumber(''), null);
  assert.strictEqual(share.internationalNumber('12345'), null);
  assert.strictEqual(share.internationalNumber('22177'), null, 'indicatif + numéro trop court');

  const wa = share.whatsappLink(doc.snap.tenant_phone || '+221 77 123 45 67', doc);
  assert.match(wa, /^https:\/\/wa\.me\/221771234567\?text=/);
  assert.ok(decodeURIComponent(wa).includes('avis de loyer'),
    'le brouillon signale un avis, pas un paiement reçu');
  const mail = share.emailLink('locataire@exemple.sn', doc);
  assert.match(mail, /^mailto:locataire@exemple\.sn\?subject=/);
  assert.match(decodeURIComponent(mail), /Avis de loyer/);

  assert.strictEqual(share.whatsappLink('', doc), null);
  assert.strictEqual(share.whatsappLink('numéro invalide', doc), null);
  assert.strictEqual(share.emailLink('pas-une-adresse', doc), null);

  const withoutContact = await seedTenant(services, { name: 'SHARE2', rent: 20000 });
  const doc2 = await rent.getReceipt((await rent.generateOne(withoutContact.tenancy.id, Y, M)).receipt.id);
  assert.strictEqual(share.whatsappLink(withoutContact.tenant.phone, doc2), null);
  assert.strictEqual(share.emailLink(withoutContact.tenant.email, doc2), null);
});

/* ---------- parcours HTTP réel ---------- */

let server, base, cookie = '';

async function startServer() {
  if (base) return;
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

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
  return { status: res.status, location: res.headers.get('location'), body: await res.text() };
}

const tokenOf = html => {
  const m = /name="_csrf" value="([0-9a-f]+)"/.exec(html);
  assert.ok(m, 'un formulaire avec jeton CSRF est attendu');
  return m[1];
};

test('la page du mois mémorise la dernière période consultée pendant la session', async () => {
  await startServer();
  const login = await send('/login');
  await send('/login', { method: 'POST', form: {
    _csrf: tokenOf(login.body), username: config.admin.username, password: 'test-motdepasse' } });

  let page = await send('/quittances/mois?year=2026&month=9');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /septembre 2026/);

  page = await send('/quittances/mois');
  assert.match(page.body, /septembre 2026/, 'la période revient sans ressaisie');

  page = await send('/quittances/mois?year=2026&month=12');
  assert.match(page.body, /décembre 2026/);
  page = await send('/quittances/mois?month=99');
  assert.match(page.body, /décembre 2026/, 'une période invalide retombe sur la dernière consultée');
  assert.match(page.body, /Quittances de loyer/);
});

test('un clic sur « Générer » ouvre directement le document final', async () => {
  await startServer();
  const { tenancy } = await seedTenant(services, { name: 'HTTP1', rent: 40000,
    first_name: 'Awa', last_name: 'Ndiaye', phone: '771234567', email: 'awa@exemple.sn' });
  await rent.recordPayment({ tenancy_id: tenancy.id, amount: 40000, paid_at: '2026-10-05',
    period_year: Y, period_month: M }, { generate: 'none' });

  const page = await send(`/quittances/mois?year=${Y}&month=${M}`);
  const form = await send('/quittances/mois/generer', { method: 'POST', form: {
    _csrf: tokenOf(page.body), tenancy_id: tenancy.id, period_year: Y, period_month: M } });

  assert.strictEqual(form.status, 302);
  assert.match(form.location, /^\/quittances\/\d+$/, 'aucun formulaire intermédiaire : l\'aperçu s\'ouvre');
  const doc = await send(form.location);
  assert.strictEqual(doc.status, 200);
  assert.match(doc.body, /QUITTANCE DE LOYER/);
  assert.match(doc.body, /Awa Ndiaye/);
  assert.ok(doc.body.includes(services.format.formatFcfa(40000)), 'le loyer réglé apparaît sur le document');
  assert.match(doc.body, /Envoyer par WhatsApp/);
  assert.match(doc.body, /Envoyer par e-mail|Préparer l&#39;e-mail/);
  assert.match(doc.body, /Imprimer la quittance/);
  assert.match(doc.body, /Télécharger le PDF/);
  assert.match(doc.body, /name="phone" value="771234567"/, 'le numéro enregistré est repris, modifiable avant envoi');
  assert.match(doc.body, /name="to" value="awa@exemple\.sn"/, "l'adresse enregistrée est reprise");
  assert.match(doc.body, /Historique des transmissions/);
});

test('la génération groupée, le récapitulatif et l\'impression par lots de trois', async () => {
  await startServer();
  const partial = await seedTenant(services, { name: 'HTTP2', rent: 20000,
    first_name: 'Fatou', last_name: 'Diop' });
  const pending = await seedTenant(services, { name: 'HTTP3', rent: 25000,
    first_name: 'Mariama', last_name: 'Fall', phone: '77 123 45 67' });
  await rent.recordPayment({ tenancy_id: partial.tenancy.id, amount: 5000, paid_at: '2026-10-06',
    period_year: Y, period_month: M }, { generate: 'none' });

  const page = await send(`/quittances/mois?year=${Y}&month=${M}`);
  const batch = await send('/quittances/mois/toutes', { method: 'POST', form: {
    _csrf: tokenOf(page.body), period_year: Y, period_month: M } });
  assert.strictEqual(batch.status, 302);
  assert.match(batch.location, /^\/quittances\/mois\/recap\?year=2026&month=10$/);

  const recap = await send(batch.location);
  assert.strictEqual(recap.status, 200);
  assert.match(recap.body, /Aucun paiement n&#39;a été enregistré/);
  assert.match(recap.body, /Imprimer les sélectionnés/);
  assert.match(recap.body, /Télécharger en PDF/);
  assert.match(recap.body, /E-mail à renseigner/, 'Fatou Diop sans e-mail : aucun lien de partage inventé');
  assert.ok(!recap.body.includes('mailto:'), 'aucune adresse devinée dans le récapitulatif');
  assert.ok(!/wa\.me\/\d/.test(recap.body), 'aucun numéro deviné dans le récapitulatif');

  const ids = [...new Set([...recap.body.matchAll(/name="ids" value="(\d+)"/g)].map(m => m[1]))];
  assert.ok(ids.length >= 3, 'les documents du mois sont proposés au lot');

  const sheets = await send(`/impression/apercu?ids=${ids.slice(0, 3).join(',')}&mode=trio`);
  assert.strictEqual(sheets.status, 200);
  assert.strictEqual((sheets.body.match(/class="a4-sheet"/g) || []).length, 1, '3 documents = 1 feuille A4');
  assert.strictEqual((sheets.body.match(/class="rent-receipt/g) || []).length, 3);

  const pdf = await send(`/impression/apercu?ids=${ids[0]}&mode=trio&pdf=1`);
  assert.match(pdf.body, /window\.print\(\)/, 'le téléchargement PDF passe par la boîte du navigateur');

  const before = (await db.prepare('SELECT COUNT(*) AS c FROM receipts WHERE cancelled = FALSE').get()).c;
  const again = await send('/quittances/mois/toutes', { method: 'POST', form: {
    _csrf: tokenOf((await send(`/quittances/mois?year=${Y}&month=${M}`)).body),
    period_year: Y, period_month: M } });
  const recapAgain = await send(again.location);
  assert.match(recapAgain.body, /déjà émis/);
  assert.strictEqual((await db.prepare('SELECT COUNT(*) AS c FROM receipts WHERE cancelled = FALSE').get()).c, before,
    'relancer la génération n\'ajoute aucun document');

  assert.strictEqual(await fullCount(pending.tenancy.id), 0,
    'un loyer non encaissé reste sans quittance après le lot');
  assert.strictEqual((await activeReceipts(pending.tenancy.id))[0].type, 'avis_loyer');
});

test('tous les modèles EJS compilent', () => {
  const views = path.join(__dirname, '..', 'src', 'views');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  const templates = walk(views).filter(f => f.endsWith('.ejs'));
  assert.ok(templates.length > 20, `${templates.length} modèles trouvés`);
  for (const file of templates) {
    ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
  }
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});
