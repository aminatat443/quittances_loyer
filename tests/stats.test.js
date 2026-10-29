'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadApp, seedTenant, seedFloorAndUnit } = require('./helpers');

const { db, services } = loadApp();
const { rent, stats, units, settings } = services;

const Y = 2026, M = 10;

test('le tableau de bord agrège des statistiques réellement issues de la base', () => {
  const a = seedTenant(services, { name: 'ST1', rent: 40000 });
  const b = seedTenant(services, { name: 'ST2', rent: 20000 });
  seedFloorAndUnit(services, { name: 'ST3', code: 'B', rent: 20000 });

  const occ = stats.occupancyCounts();
  assert.strictEqual(occ.total_units, 3);
  assert.strictEqual(occ.occupied, 2);
  assert.strictEqual(occ.available, 1);
  assert.strictEqual(occ.tenants, 2);

  const totals = stats.monthTotals(Y, M);
  assert.strictEqual(totals.expected, 60000, 'seules les locations actives sont attendues');
  assert.strictEqual(totals.collected, 0);

  rent.recordPayment({ tenancy_id: a.tenancy.id, amount: 40000, paid_at: '2026-10-01',
    period_year: Y, period_month: M });
  rent.recordPayment({ tenancy_id: b.tenancy.id, amount: 5000, paid_at: '2026-10-01',
    period_year: Y, period_month: M });

  assert.deepStrictEqual(stats.monthTotals(Y, M), { expected: 60000, collected: 45000 });
  assert.deepStrictEqual(stats.paidCounts(Y, M), { paid: 1, partial: 1 });
  assert.deepStrictEqual(stats.pendingCount(Y, M), { pending: 1, due: 2 },
    'seul le locataire partiellement payé reste en attente');
});

test('aucun loyer n\'est considéré payé au changement de mois', () => {
  const { tenancy } = seedTenant(services, { name: 'MOIS', rent: 30000 });
  rent.recordPayment({ tenancy_id: tenancy.id, amount: 30000, paid_at: '2026-10-01',
    period_year: Y, period_month: M });

  assert.strictEqual(rent.periodSummary(tenancy.id, Y, M + 1).status, rent.STATUS.PENDING);
  assert.strictEqual(rent.periodSummary(tenancy.id, Y, M - 1).status, rent.STATUS.PENDING);
  const board = stats.monthlyBoard(Y, M + 1).filter(r => r.tenancy_id === tenancy.id)[0];
  assert.strictEqual(board.paid, 0);
  assert.strictEqual(board.status, 'pending');
});

test('la vue mensuelle couvre les occupations passées et à venir', () => {
  const { tenancy, tenant } = seedTenant(services, { name: 'OCC', rent: 25000, start_date: '2026-03-01' });
  rent.recordPayment({ tenancy_id: tenancy.id, amount: 25000, paid_at: '2026-04-05',
    period_year: Y, period_month: 4 });
  services.tenants.endTenancy(tenant.id, '2026-06-15');

  assert.strictEqual(stats.monthlyBoard(Y, 2).some(r => r.tenancy_id === tenancy.id), false,
    'avant l\'entrée du locataire');
  const april = stats.monthlyBoard(Y, 4).find(r => r.tenancy_id === tenancy.id);
  assert.strictEqual(april.status, 'paid');
  assert.strictEqual(april.has_full_receipt, 1);
  const june = stats.monthlyBoard(Y, 6).find(r => r.tenancy_id === tenancy.id);
  assert.strictEqual(june.status, 'pending', 'le mois du départ reste dû');
  assert.strictEqual(stats.monthlyBoard(Y, 7).some(r => r.tenancy_id === tenancy.id), false);
});

test('les loyers attendus ne changent pas quand un tarif de référence est modifié', () => {
  const { tenancy } = seedTenant(services, { name: 'TARIF', code: 'B', rent: 20000 });
  rent.recordPayment({ tenancy_id: tenancy.id, amount: 20000, paid_at: '2026-10-01',
    period_year: Y, period_month: M });

  units.updateFloorTypeDefaultRent('B', 27500);
  const doc = db.prepare('SELECT * FROM receipts ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(rent.getReceipt(doc.id).expected, 20000);
  assert.strictEqual(stats.monthlyBoard(Y, M).find(r => r.tenancy_id === tenancy.id).expected, 20000,
    'la location en cours conserve le loyer convenu');
  units.updateFloorTypeDefaultRent('B', 20000);
});

test('les filtres de l\'historique retrouvent un locataire pour un mois donné', () => {
  const base = stats.receiptHistory({}).length;
  const a = seedTenant(services, { name: 'FILT1', rent: 40000 });
  const b = seedTenant(services, { name: 'FILT2', rent: 40000 });
  rent.recordPayment({ tenancy_id: a.tenancy.id, amount: 40000, paid_at: '2026-09-01',
    period_year: Y, period_month: 9 });
  rent.recordPayment({ tenancy_id: b.tenancy.id, amount: 20000, paid_at: '2026-10-01',
    period_year: Y, period_month: M });

  assert.strictEqual(stats.receiptHistory({}).length, base + 2);
  assert.strictEqual(stats.receiptHistory({ year: Y, month: 9 }).length, 1);
  assert.strictEqual(stats.receiptHistory({ year: Y, month: M, tenant_id: b.tenant.id }).length, 1);
  assert.strictEqual(stats.receiptHistory({ tenant_id: a.tenant.id }).length, 1);
  assert.strictEqual(stats.receiptHistory({ tenant_id: b.tenant.id, type: 'partial' }).length, 1);
  assert.strictEqual(stats.receiptHistory({ tenant_id: a.tenant.id, type: 'full' }).length, 1);
  assert.strictEqual(stats.paymentHistory({ year: Y, month: M, tenant_id: b.tenant.id })[0].amount, 20000);
});

test('les paramètres par défaut reprennent l\'identité du propriétaire', () => {
  assert.strictEqual(settings.get('owner_name'), 'Bamby Sidibé');
  assert.strictEqual(settings.get('receipt_prefix'), 'QL');
  const types = services.units.listUnitTypes().reduce((m, t) => ({ ...m, [t.code]: t.default_rent }), {});
  assert.deepStrictEqual(types, { A: 40000, B: 20000, C: 25000 });
  assert.strictEqual(services.units.listFloors().length, 3);
});

test('un seul logement de type C peut exister', () => {
  const floor = units.listFloors()[2];
  units.createUnit({ floor_id: floor.id, unit_type_code: 'C', name: 'Terrasse', default_rent: 25000 });
  assert.throws(() => units.createUnit({ floor_id: floor.id, unit_type_code: 'C',
    name: 'Seconde terrasse', default_rent: 25000 }), e => e.validation === true);
});

test('un logement occupé ne peut pas être attribué deux fois', () => {
  const unit = seedFloorAndUnit(services, { name: 'OCCupe', code: 'B', rent: 20000 });
  services.tenants.createTenant({ first_name: 'Premier', last_name: 'Loc', unit_id: unit.id,
    start_date: '2026-01-01', monthly_rent: 0 });
  assert.throws(() => services.tenants.createTenant({ first_name: 'Second', last_name: 'Loc',
    unit_id: unit.id, start_date: '2026-02-01', monthly_rent: 0 }), e => e.validation === true);
});
