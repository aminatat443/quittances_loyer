'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadApp, seedTenant } = require('./helpers');

const { services } = loadApp();
const { rent, tenants, stats } = services;

const Y = 2026, M = 10;

test('loyer attendu et solde calculés depuis les paiements réels', () => {
  const { tenancy } = seedTenant(services, { name: 'CALC1', rent: 40000 });

  let s = rent.periodSummary(tenancy.id, Y, M);
  assert.strictEqual(s.expected, 40000);
  assert.strictEqual(s.paid, 0);
  assert.strictEqual(s.balance, 40000);
  assert.strictEqual(s.status, rent.STATUS.PENDING, 'un nouveau mois ne doit pas être réputé payé');

  rent.recordPayment({ tenancy_id: tenancy.id, amount: 15000, paid_at: '2026-10-03',
    period_year: Y, period_month: M }, { generate: 'none' });
  s = rent.periodSummary(tenancy.id, Y, M);
  assert.strictEqual(s.paid, 15000);
  assert.strictEqual(s.balance, 25000);
  assert.strictEqual(s.status, rent.STATUS.PARTIAL);

  rent.recordPayment({ tenancy_id: tenancy.id, amount: 25000, paid_at: '2026-10-18',
    period_year: Y, period_month: M }, { generate: 'none' });
  s = rent.periodSummary(tenancy.id, Y, M);
  assert.strictEqual(s.paid, 40000);
  assert.strictEqual(s.balance, 0);
  assert.strictEqual(s.status, rent.STATUS.PAID);
});

test('un paiement inférieur au loyer produit un reçu partiel, jamais une quittance', () => {
  const { tenancy } = seedTenant(services, { name: 'PART1', rent: 40000 });
  const r = rent.recordPayment({ tenancy_id: tenancy.id, amount: 10000, paid_at: '2026-10-05',
    period_year: Y, period_month: M });

  assert.strictEqual(r.receipt.type, 'recu_partiel');
  assert.strictEqual(r.receipt.balance, 30000);
  assert.strictEqual(r.receipt.total_paid, 10000);
  assert.match(r.receipt.type_label, /partiel/i);
  assert.strictEqual(r.receipt.is_full, false);
  assert.match(r.receipt.amount_this_in_words, /^Dix mille francs CFA$/);
});

test('le paiement intégral déclenche une quittance, et une quittance définitive après partiels', () => {
  const a = seedTenant(services, { name: 'FULL1', rent: 20000 });
  const direct = rent.recordPayment({ tenancy_id: a.tenancy.id, amount: 20000, paid_at: '2026-10-01',
    period_year: Y, period_month: M });
  assert.strictEqual(direct.receipt.type, 'quittance');
  assert.strictEqual(direct.receipt.balance, 0);
  assert.strictEqual(direct.receipt.is_full, true);

  const b = seedTenant(services, { name: 'FULL2', rent: 20000 });
  rent.recordPayment({ tenancy_id: b.tenancy.id, amount: 8000, paid_at: '2026-10-02',
    period_year: Y, period_month: M });
  const second = rent.recordPayment({ tenancy_id: b.tenancy.id, amount: 12000, paid_at: '2026-10-20',
    period_year: Y, period_month: M });
  assert.strictEqual(second.receipt.type, 'quittance_definitive',
    'le solde réglé doit produire une quittance récapitulative');
  assert.strictEqual(second.receipt.total_paid, 20000);
  assert.strictEqual(second.receipt.amount_this, 12000);
});

test('les doublons de quittance intégrale sont refusés, la réémission reste possible', () => {
  const { tenancy } = seedTenant(services, { name: 'DUP1', rent: 30000 });
  rent.recordPayment({ tenancy_id: tenancy.id, amount: 30000, paid_at: '2026-10-01',
    period_year: Y, period_month: M });

  assert.throws(() => rent.recordPayment({ tenancy_id: tenancy.id, amount: 30000, paid_at: '2026-10-02',
    period_year: Y, period_month: M }), e => e.duplicate === true);

  const forced = rent.recordPayment({ tenancy_id: tenancy.id, amount: 1, paid_at: '2026-10-02',
    period_year: Y, period_month: M }, { allow_full_reissue: true });
  assert.ok(forced.receipt, 'une réémission explicite doit rester possible');
});

test('les numéros de quittance sont uniques et jamais réutilisés', () => {
  const { tenancy } = seedTenant(services, { name: 'NUM1', rent: 40000 });
  const numbers = [];
  for (const amount of [10000, 10000, 20000]) {
    const r = rent.recordPayment({ tenancy_id: tenancy.id, amount, paid_at: '2026-10-10',
      period_year: Y, period_month: M });
    numbers.push(r.receipt.number);
  }
  assert.strictEqual(new Set(numbers).size, 3, 'aucun numéro ne doit être répété');
  numbers.forEach(n => assert.match(n, /^QL-2026-\d{4}$/, 'format préfixe-année-série'));

  const other = seedTenant(services, { name: 'NUM2', rent: 40000 });
  const r2 = rent.recordPayment({ tenancy_id: other.tenancy.id, amount: 40000, paid_at: '2026-10-11',
    period_year: 2027, period_month: 1 });
  assert.match(r2.receipt.number, /^QL-2027-0001$/, 'la série redémarre chaque année');

  const total = require('../src/db').prepare('SELECT COUNT(*) AS c FROM receipts').get().c;
  assert.ok(total >= 4);
});

test('l\'instantané de la quittance résiste aux modifications ultérieures', () => {
  const { tenancy, tenant } = seedTenant(services, { name: 'SNAP1', rent: 40000, last_name: 'Ancien' });
  const doc = rent.recordPayment({ tenancy_id: tenancy.id, amount: 40000, paid_at: '2026-10-01',
    period_year: Y, period_month: M }).receipt;
  assert.strictEqual(doc.snap.tenant_name, 'Awa Ancien');
  assert.strictEqual(doc.snap.unit_name, 'SNAP1');

  require('../src/db').prepare('UPDATE tenants SET first_name = ?, last_name = ? WHERE id = ?')
    .run('Changée', 'Nommodifié', tenant.id);
  require('../src/db').prepare('UPDATE tenancies SET monthly_rent = ? WHERE id = ?').run(99999, tenancy.id);

  const reloaded = rent.getReceipt(doc.id);
  assert.strictEqual(reloaded.snap.tenant_name, 'Awa Ancien',
    'le document doit conserver le nom d\'origine à la réimpression');
  assert.strictEqual(reloaded.expected, 40000,
    'le montant attendu enregistré ne doit pas suivre le changement de loyer');
});

test('l\'archivage d\'un locataire conserve paiements et quittances', () => {
  const { tenancy, tenant } = seedTenant(services, { name: 'ARCH1', rent: 40000 });
  const doc = rent.recordPayment({ tenancy_id: tenancy.id, amount: 40000, paid_at: '2026-10-01',
    period_year: Y, period_month: M }).receipt;

  tenants.endTenancy(tenant.id, '2026-10-31');

  const db = require('../src/db');
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM payments WHERE tenancy_id = ?').get(tenancy.id).c, 1);
  assert.strictEqual(rent.getReceipt(doc.id).number, doc.number);
  assert.strictEqual(tenants.getTenant(tenant.id).status, 'archived');
  assert.ok(rent.periodSummary(tenancy.id, Y, M).status === rent.STATUS.PAID);

  // le logement est réattribuable sans perdre l'historique
  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(tenancy.unit_id);
  assert.strictEqual(unit.status, 'available');
  const nouveau = tenants.createTenant({ first_name: 'Nouvelle', last_name: 'Occupante',
    unit_id: unit.id, start_date: '2026-11-01', monthly_rent: 0 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM tenancies WHERE unit_id = ?').get(unit.id).c, 2);
  assert.strictEqual(stats.receiptHistory({}).filter(r => r.number === doc.number).length, 1);
});

test('les montants monétaires restent des entiers FCFA', () => {
  const { tenancy } = seedTenant(services, { name: 'INT1', rent: 33333 });
  const doc = rent.recordPayment({ tenancy_id: tenancy.id, amount: 33333, paid_at: '2026-10-01',
    period_year: Y, period_month: M }).receipt;
  assert.ok(Number.isInteger(doc.total_paid));
  assert.strictEqual(doc.total_paid_fr, '33 333 FCFA');
  assert.throws(() => rent.recordPayment({ tenancy_id: tenancy.id, amount: 12.5, paid_at: '2026-10-01',
    period_year: Y, period_month: M }), e => e.validation === true);
});
