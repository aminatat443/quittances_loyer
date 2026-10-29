'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadApp, seedTenant } = require('./helpers');

const { services } = loadApp();
const { rent, format } = services;

test('les quittances sont regroupées par lots de trois sur des feuilles A4', () => {
  const docs = [1, 2, 3].map(i => ({ id: i }));
  const one = rent.buildPrintSheets([docs[0]], 'trio');
  assert.strictEqual(one.length, 1);
  assert.deepStrictEqual(one[0].map(x => x && x.id), [1, null, null],
    'les emplacements inutilisés restent vides');

  const three = rent.buildPrintSheets(docs, 'trio');
  assert.strictEqual(three.length, 1);
  assert.strictEqual(three[0].filter(Boolean).length, 3);

  const four = rent.buildPrintSheets([...docs, { id: 4 }], 'trio');
  assert.strictEqual(four.length, 2, 'quatre documents exigent deux feuilles');
  assert.deepStrictEqual(four[1].map(x => x && x.id), [4, null, null]);

  const seven = rent.buildPrintSheets([...docs, 4, 5, 6, 7].map(x => ({ id: x })), 'trio');
  assert.strictEqual(seven.length, 3);
  assert.strictEqual(seven.flat().length, 9, 'chaque feuille compte toujours trois emplacements');
});

test('trois exemplaires d\'une même quittance n\'occupent qu\'une feuille', () => {
  const sheets = rent.buildPrintSheets([{ id: 42 }], 'copies');
  assert.strictEqual(sheets.length, 1);
  assert.deepStrictEqual(sheets[0].map(r => r.id), [42, 42, 42]);
});

test('conversion des montants en toutes lettres françaises', () => {
  const cases = [
    [40000, 'Quarante mille francs CFA'],
    [20000, 'Vingt mille francs CFA'],
    [25000, 'Vingt-cinq mille francs CFA'],
    [1000, 'Mille francs CFA'],
    [1100, 'Mille cent francs CFA'],
    [21, 'Vingt et un francs CFA'],
    [80, 'Quatre-vingts francs CFA'],
    [95, 'Quatre-vingt-quinze francs CFA'],
    [71, 'Soixante et onze francs CFA'],
    [61, 'Soixante et un francs CFA'],
    [91, 'Quatre-vingt-onze francs CFA'],
    [200, 'Deux cents francs CFA'],
    [300, 'Trois cents francs CFA'],
    [101, 'Cent un francs CFA'],
    [100000, 'Cent mille francs CFA'],
    [200000, 'Deux cent mille francs CFA'],
    [400000, 'Quatre cent mille francs CFA'],
    [80000, 'Quatre-vingt mille francs CFA'],
    [1000000, 'Un million de francs CFA'],
    [2000000, 'Deux millions de francs CFA'],
    [1500000, 'Un million cinq cent mille francs CFA'],
    [999990, 'Neuf cent quatre-vingt-dix-neuf mille neuf cent quatre-vingt-dix francs CFA'],
    [0, 'Zéro franc CFA'],
  ];
  for (const [amount, words] of cases) {
    assert.strictEqual(format.amountToFrenchWords(amount), words, `${amount}`);
  }
});

test('formatage des montants, dates et périodes en français', () => {
  assert.strictEqual(format.formatFcfa(1234567), '1 234 567 FCFA');
  assert.strictEqual(format.formatPeriode(2026, 10), 'octobre 2026');
  assert.strictEqual(format.formatDateFr('2026-10-05'), '05/10/2026');
  const doc = rent.recordPayment({
    tenancy_id: seedTenant(services, { name: 'LBL1', rent: 40000 }).tenancy.id,
    amount: 40000, paid_at: '2026-10-05', period_year: 2026, period_month: 2,
  }).receipt;
  assert.strictEqual(doc.period_label, 'février 2026');
  assert.strictEqual(doc.period_range, 'du 1er au 28 février 2026');
  assert.strictEqual(doc.payment_date_fr, '05/10/2026');
});

test('les années bissextiles ajustent la période du loyer', () => {
  const t = seedTenant(services, { name: 'LYP1', rent: 20000 });
  const leap = rent.recordPayment({ tenancy_id: t.tenancy.id, amount: 20000, paid_at: '2028-02-20',
    period_year: 2028, period_month: 2 }).receipt;
  assert.match(leap.period_range, /du 1er au 29 février 2028$/);
});
