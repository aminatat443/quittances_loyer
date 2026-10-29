'use strict';

const db = require('../db');
const settings = require('./settings');
const { formatFcfa, formatPeriode, formatDateFr, amountToFrenchWords } = require('../utils/format');

const STATUS = { PAID: 'paid', PARTIAL: 'partial', PENDING: 'pending', NA: 'na' };

function getTenancy(id) {
  return db.prepare('SELECT * FROM tenancies WHERE id = ?').get(id);
}

function getOpenTenancyForTenant(tenantId) {
  return db.prepare('SELECT * FROM tenancies WHERE tenant_id = ? AND end_date IS NULL ORDER BY id DESC LIMIT 1')
    .get(tenantId);
}

function getOpenTenancyForUnit(unitId) {
  return db.prepare('SELECT * FROM tenancies WHERE unit_id = ? AND end_date IS NULL LIMIT 1').get(unitId);
}

function tenancyCoversPeriod(t, year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const start = String(t.start_date).slice(0, 7);
  const end = t.end_date ? String(t.end_date).slice(0, 7) : null;
  return start <= key && (end === null || key <= end);
}

async function paidForPeriod(tenancyId, year, month) {
  const row = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments
                                WHERE tenancy_id = ? AND period_year = ? AND period_month = ?`)
    .get(tenancyId, year, month);
  return row.total;
}

async function periodSummary(tenancyId, year, month) {
  const t = await getTenancy(tenancyId);
  if (!t) throw new Error('Location inconnue');
  const expected = t.monthly_rent;
  if (!tenancyCoversPeriod(t, year, month)) {
    return { tenancy: t, expected: 0, paid: 0, balance: 0, status: STATUS.NA, notPaidFull: true };
  }
  const paid = await paidForPeriod(tenancyId, year, month);
  const balance = Math.max(expected - paid, 0);
  let status;
  if (expected > 0 && paid >= expected) status = STATUS.PAID;
  else if (paid > 0) status = STATUS.PARTIAL;
  else status = STATUS.PENDING;
  return { tenancy: t, expected, paid, balance, status };
}

async function fullReceiptForPeriod(tenancyId, year, month) {
  return await db.prepare(`SELECT * FROM receipts WHERE tenancy_id = ? AND period_year = ? AND period_month = ?
                     AND type IN ('quittance', 'quittance_definitive') AND cancelled = FALSE
                     ORDER BY id DESC LIMIT 1`).get(tenancyId, year, month) || null;
}

async function fullReceiptExists(tenancyId, year, month) {
  return !!(await fullReceiptForPeriod(tenancyId, year, month));
}

async function lastReceiptOfType(tenancyId, year, month, types) {
  const ph = types.map(() => '?').join(',');
  return await db.prepare(`SELECT * FROM receipts WHERE tenancy_id = ? AND period_year = ? AND period_month = ?
                     AND cancelled = FALSE AND type IN (${ph}) ORDER BY id DESC LIMIT 1`)
    .get(tenancyId, year, month, ...types) || null;
}

/**
 * Une réémission explicite remplace la quittance intégrale active : l'ancien
 * document est marqué annulé (il reste consultable) pour libérer la contrainte
 * d'unicité par période.
 */
async function cancelFullReceipts(tenancyId, year, month) {
  await db.prepare(`UPDATE receipts SET cancelled = TRUE WHERE tenancy_id = ? AND period_year = ? AND period_month = ?
              AND cancelled = FALSE AND type IN ('quittance', 'quittance_definitive')`)
    .run(tenancyId, year, month);
}

/**
 * Compteur annuel unique : quittances et avis partagent la même séquence,
 * donc un numéro n'est jamais émis deux fois ni réutilisé. L'incrément se fait
 * dans la base, deux émissions simultanées ne peuvent donc pas prendre le même
 * numéro.
 */
async function nextNumber(year, prefix) {
  const row = await db.prepare(`INSERT INTO receipt_sequences (year, last_value) VALUES (?, 1)
                                ON CONFLICT (year) DO UPDATE SET last_value = receipt_sequences.last_value + 1
                                RETURNING last_value`).get(year);
  return `${prefix}-${year}-${String(row.last_value).padStart(4, '0')}`;
}

async function nextReceiptNumber(year) {
  return nextNumber(year, settings.get('receipt_prefix') || 'QL');
}

function buildSnapshot(tenancy, tenant, unit, floor, typeLabel) {
  return {
    tenant_name: `${tenant.first_name} ${tenant.last_name}`.trim(),
    tenant_phone: tenant.phone || '',
    unit_name: unit ? unit.name : tenancy.unit_name,
    floor_label: floor ? floor.label : tenancy.floor_label,
    unit_type_label: typeLabel || tenancy.unit_type_label,
    building_name: settings.get('building_name'),
    building_address: settings.get('building_address'),
    owner_name: settings.get('owner_name'),
    owner_phone: settings.get('owner_phone'),
    city: settings.get('city'),
  };
}

const TYPE_LABELS = {
  quittance: 'Quittance de loyer — paiement intégral',
  quittance_definitive: 'Quittance définitive — paiement intégral',
  recu_partiel: 'Reçu de paiement partiel',
  avis_loyer: 'Avis de loyer — paiement non reçu',
};

function receiptLabel(type) {
  return TYPE_LABELS[type] || 'Reçu de paiement partiel';
}

function decorateReceipt(r) {
  // snapshot est du JSONB : déjà un objet côté PostgreSQL, en chaîne pour les
  // documents importés depuis l'ancienne base.
  const snap = typeof r.snapshot === 'string' ? JSON.parse(r.snapshot || '{}') : (r.snapshot || {});
  const period = formatPeriode(r.period_year, r.period_month);
  const firstDay = `${String(r.period_month).padStart(2, '0')}/01/${r.period_year}`;
  const monthDays = { 1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31 };
  let days = monthDays[r.period_month];
  if (r.period_month === 2) {
    const y = r.period_year;
    days = ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
  }
  const lastDay = `${String(r.period_month).padStart(2, '0')}/${String(days).padStart(2, '0')}/${r.period_year}`;
  return {
    ...r,
    snap,
    period_label: period,
    period_range: `du 1er au ${days} ${period}`,
    period_first_day: firstDay.slice(3),
    period_last_day: lastDay.slice(3),
    amount_this_fr: formatFcfa(r.amount_this),
    total_paid_fr: formatFcfa(r.total_paid),
    expected_fr: formatFcfa(r.expected),
    balance_fr: formatFcfa(r.balance),
    amount_in_words: amountToFrenchWords(r.total_paid),
    amount_this_in_words: amountToFrenchWords(r.amount_this),
    balance_in_words: amountToFrenchWords(r.balance),
    payment_date_fr: formatDateFr(r.payment_date),
    issued_at_fr: formatDateFr(String(r.issued_at).slice(0, 10)),
    method_label: METHOD_LABELS[r.method] || '',
    type_label: receiptLabel(r.type),
    is_avis: r.type === 'avis_loyer',
    is_full: r.type === 'quittance' || r.type === 'quittance_definitive',
  };
}

const METHOD_LABELS = {
  especes: 'Espèces',
  wave: 'Wave',
  orange_money: 'Orange Money',
  virement: 'Virement bancaire',
};

/**
 * Enregistre un paiement puis, si demandé, émet la quittance ou le reçu associé.
 * options: { generate: 'auto' | 'quittance' | 'recu_partiel' | 'none', allow_full_reissue: bool }
 */
async function recordPayment(input, options = {}) {
  const {
    tenancy_id, amount, paid_at, method = 'especes', period_year, period_month,
    note = '', observations = '', issued_place = '',
  } = input;

  const errors = [];
  const t = await getTenancy(tenancy_id);
  if (!t) errors.push('Location inconnue.');
  if (!Number.isInteger(amount) || amount <= 0) errors.push('Le montant doit être un entier positif en FCFA.');
  if (!paid_at) errors.push('La date de paiement est obligatoire.');
  if (!period_year || period_month < 1 || period_month > 12) errors.push('Mois ou année invalide.');
  if (errors.length) { const e = new Error(errors.join(' ')); e.validation = true; throw e; }

  return db.tx(async () => {
    const payment = await db.prepare(`INSERT INTO payments
      (tenancy_id, period_year, period_month, expected_amount, amount, paid_at, method, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .run(tenancy_id, period_year, period_month, t.monthly_rent, amount, paid_at, method, note);

    const summary = await periodSummary(tenancy_id, period_year, period_month);
    const mode = options.generate || 'auto';
    if (mode === 'none') return { payment_id: payment.lastInsertRowid, summary, receipt: null };

    if (summary.status === STATUS.PAID) {
      if (await fullReceiptExists(tenancy_id, period_year, period_month)) {
        if (!options.allow_full_reissue) {
          const e = new Error('Une quittance de paiement intégral existe déjà pour cette période. '
            + 'Utilisez la réimpression ou confirmez la réémission si nécessaire.');
          e.duplicate = true;
          throw e;
        }
        await cancelFullReceipts(tenancy_id, period_year, period_month);
      }
      const type = summary.paid > amount ? 'quittance_definitive' : 'quittance';
      return { payment_id: payment.lastInsertRowid, summary,
        receipt: await issueReceipt({
          tenancy_id, period_year, period_month, type,
          amount_this: amount, total_paid: summary.paid, expected: summary.expected,
          balance: 0, payment_date: paid_at, method, observations, issued_place,
        }) };
    }
    // paiement partiel
    return { payment_id: payment.lastInsertRowid, summary,
      receipt: await issueReceipt({
        tenancy_id, period_year, period_month, type: 'recu_partiel',
        amount_this: amount, total_paid: summary.paid, expected: summary.expected,
        balance: summary.balance, payment_date: paid_at, method, observations, issued_place,
      }) };
  });
}

async function lastPaymentOfPeriod(tenancyId, year, month) {
  return db.prepare(`SELECT * FROM payments WHERE tenancy_id = ? AND period_year = ? AND period_month = ?
                     ORDER BY paid_at DESC, id DESC LIMIT 1`).get(tenancyId, year, month);
}

async function issueReceipt(data) {
  const t = await getTenancy(data.tenancy_id);
  const tenant = await db.prepare('SELECT * FROM tenants WHERE id = ?').get(t.tenant_id);
  const unit = await db.prepare(`SELECT u.*, f.label AS floor_label_name FROM units u
                           JOIN floors f ON f.id = u.floor_id WHERE u.id = ?`).get(t.unit_id);
  const floor = unit ? await db.prepare('SELECT * FROM floors WHERE id = ?').get(unit.floor_id) : null;
  const typeRow = unit ? await db.prepare('SELECT label FROM unit_types WHERE code = ?').get(unit.unit_type_code) : null;
  const snap = buildSnapshot(t, tenant, unit, floor, typeRow && typeRow.label);

  const number = data.type === 'avis_loyer'
    ? await nextNumber(data.period_year, settings.get('notice_prefix') || 'AL')
    : await nextNumber(data.period_year, settings.get('receipt_prefix') || 'QL');
  const issued_place = data.issued_place || settings.get('city');
  const info = await db.prepare(`INSERT INTO receipts
    (number, type, tenancy_id, period_year, period_month, amount_this, total_paid, expected, balance,
     payment_date, method, observations, issued_place, snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb) RETURNING id`)
    .run(number, data.type, data.tenancy_id, data.period_year, data.period_month,
      data.amount_this, data.total_paid, data.expected, data.balance,
      data.payment_date, data.method, data.observations || '', issued_place, JSON.stringify(snap));
  // une quittance intégrale rend l'avis de loyer de la même période caduc
  if (data.type === 'quittance' || data.type === 'quittance_definitive') {
    await db.prepare(`UPDATE receipts SET cancelled = TRUE WHERE tenancy_id = ? AND period_year = ? AND period_month = ?
                AND cancelled = FALSE AND type = 'avis_loyer'`)
      .run(data.tenancy_id, data.period_year, data.period_month);
  }
  return decorateReceipt(await db.prepare('SELECT * FROM receipts WHERE id = ?').get(info.lastInsertRowid));
}

async function getReceipt(id) {
  const r = await db.prepare('SELECT * FROM receipts WHERE id = ? AND cancelled = FALSE').get(id);
  return r ? decorateReceipt(r) : null;
}

function getReceiptRaw(id) {
  return db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
}

/**
 * Réédition d'une quittance définitive après paiements partiels successifs,
 * lorsque le solde vient d'atteindre zéro.
 */
async function issueFinalReceipt(tenancyId, year, month, opts = {}) {
  const summary = await periodSummary(tenancyId, year, month);
  if (summary.status !== STATUS.PAID) {
    const e = new Error('Le loyer de cette période n\'est pas encore intégralement réglé.');
    e.validation = true;
    throw e;
  }
  if (await fullReceiptExists(tenancyId, year, month)) {
    if (!opts.allow_full_reissue) {
      const e = new Error('Une quittance intégrale existe déjà pour cette période.');
      e.duplicate = true;
      throw e;
    }
    await cancelFullReceipts(tenancyId, year, month);
  }
  const lastPayment = await lastPaymentOfPeriod(tenancyId, year, month);
  return issueReceipt({
    tenancy_id: tenancyId, period_year: year, period_month: month,
    type: 'quittance_definitive',
    amount_this: summary.paid, total_paid: summary.paid, expected: summary.expected, balance: 0,
    payment_date: lastPayment ? lastPayment.paid_at : new Date().toISOString().slice(0, 10),
    method: lastPayment ? lastPayment.method : 'especes',
    observations: opts.observations || '', issued_place: opts.issued_place || '',
  });
}

/**
 * Avis de loyer : document de suivi pour un locataire dont le loyer n'est pas
 * (ou pas entièrement) réglé. Il n'atteste d'aucun paiement reçu.
 */
async function issueAvisLoyer(tenancyId, year, month, opts = {}) {
  const summary = await periodSummary(tenancyId, year, month);
  if (summary.status === STATUS.PAID) {
    const e = new Error('Le loyer de cette période est déjà réglé : une quittance doit être générée à la place.');
    e.validation = true;
    throw e;
  }
  return db.tx(async () => {
    const existing = await lastReceiptOfType(tenancyId, year, month, ['avis_loyer']);
    if (existing) await db.prepare('UPDATE receipts SET cancelled = TRUE WHERE id = ?').run(existing.id);
    return issueReceipt({
      tenancy_id: tenancyId, period_year: year, period_month: month, type: 'avis_loyer',
      amount_this: 0, total_paid: summary.paid, expected: summary.expected, balance: summary.balance,
      payment_date: '', method: 'especes',
      observations: opts.observations || '', issued_place: opts.issued_place || '',
    });
  });
}

/**
 * Génère, sans aucune saisie, le document qui correspond à l'état réel de la
 * période pour une location : quittance si le loyer est réglé, reçu partiel si
 * des paiements existent, avis de loyer si rien n'est réglé.
 * Retourne { kind, created, receipt } — created=false signifie « déjà émis »,
 * donc réimpression plutôt que doublon.
 */
async function generateForPeriod(tenancyId, year, month) {
  const summary = await periodSummary(tenancyId, year, month);
  if (summary.status === STATUS.NA) {
    const e = new Error('Aucune location active ne couvre cette période.');
    e.validation = true;
    throw e;
  }

  if (summary.status === STATUS.PAID) {
    const existing = await fullReceiptForPeriod(tenancyId, year, month);
    if (existing) return { kind: 'quittance', created: false, receipt: decorateReceipt(existing), summary };
    const hadPartials = !!(await lastReceiptOfType(tenancyId, year, month, ['recu_partiel']));
    const lastPayment = await lastPaymentOfPeriod(tenancyId, year, month);
    const receipt = await issueReceipt({
      tenancy_id: tenancyId, period_year: year, period_month: month,
      type: hadPartials ? 'quittance_definitive' : 'quittance',
      amount_this: summary.paid, total_paid: summary.paid, expected: summary.expected, balance: 0,
      payment_date: lastPayment ? lastPayment.paid_at : new Date().toISOString().slice(0, 10),
      method: lastPayment ? lastPayment.method : 'especes',
    });
    return { kind: 'quittance', created: true, receipt, summary };
  }

  const existing = await lastReceiptOfType(tenancyId, year, month, ['recu_partiel']);
  if (existing && existing.total_paid === summary.paid) {
    return { kind: 'recu_partiel', created: false, receipt: decorateReceipt(existing), summary };
  }
  const alreadyDocumented = existing ? existing.total_paid : 0;
  const lastPayment = await lastPaymentOfPeriod(tenancyId, year, month);
  const receipt = await issueReceipt({
    tenancy_id: tenancyId, period_year: year, period_month: month, type: 'recu_partiel',
    amount_this: summary.paid - alreadyDocumented, total_paid: summary.paid,
    expected: summary.expected, balance: summary.balance,
    payment_date: lastPayment ? lastPayment.paid_at : '',
    method: lastPayment ? lastPayment.method : 'especes',
  });
  return { kind: 'recu_partiel', created: true, receipt, summary };
}

async function pendingAvisForPeriod(tenancyId, year, month) {
  const summary = await periodSummary(tenancyId, year, month);
  const existing = await lastReceiptOfType(tenancyId, year, month, ['avis_loyer']);
  if (existing && existing.expected === summary.expected && existing.balance === summary.balance) {
    return { kind: 'avis', created: false, receipt: decorateReceipt(existing), summary };
  }
  return { kind: 'avis', created: true, receipt: await issueAvisLoyer(tenancyId, year, month), summary };
}

/**
 * Le clic « Générer » de la page du mois : aucun formulaire intermédiaire.
 */
async function generateOne(tenancyId, year, month) {
  const status = (await periodSummary(tenancyId, year, month)).status;
  return status === STATUS.PENDING ? pendingAvisForPeriod(tenancyId, year, month)
    : generateForPeriod(tenancyId, year, month);
}

/**
 * Lot mensuel : prépare le document de chaque location de la période.
 * Ne confirme aucun paiement : les locations non réglées reçoivent un avis.
 */
async function generateMonth(year, month) {
  const board = await require('./stats').monthlyBoard(year, month);
  const created = [];
  const already = [];
  const failed = [];
  for (const row of board) {
    try {
      const result = await generateOne(row.tenancy_id, year, month);
      (result.created ? created : already).push({ row, result });
    } catch (e) {
      failed.push({ row, message: e.message });
    }
  }
  return { board, created, already, failed };
}

/**
 * Board mensuel enrichi de l'état documentaire de chaque location :
 * c'est la source unique de la page « Quittances du mois ».
 */
async function monthBoard(year, month) {
  const board = await require('./stats').monthlyBoard(year, month);
  return Promise.all(board.map(async row => {
    const [full, partial, avis] = await Promise.all([
      fullReceiptForPeriod(row.tenancy_id, year, month),
      lastReceiptOfType(row.tenancy_id, year, month, ['recu_partiel']),
      lastReceiptOfType(row.tenancy_id, year, month, ['avis_loyer']),
    ]);
    const doc = full || partial || avis;
    const payment = row.status === STATUS.PAID ? 'Intégralement payé'
      : row.status === STATUS.PARTIAL ? `Partiel : ${formatFcfa(row.paid)} sur ${formatFcfa(row.expected)}`
      : 'En attente de paiement';
    let docStatus;
    if (full) docStatus = 'Quittance générée';
    else if (partial) docStatus = row.paid >= row.expected ? 'Reçu partiel à compléter' : 'Reçu partiel généré';
    else if (avis) docStatus = 'Avis de loyer généré';
    else docStatus = 'À générer';
    let action;
    if (full) action = { label: 'Réimprimer la quittance', kind: 'reprint' };
    else if (partial && row.paid >= row.expected) action = { label: 'Générer la quittance', kind: 'generate' };
    else if (partial) action = { label: 'Réimprimer le reçu', kind: 'reprint' };
    else if (avis) action = { label: 'Régénérer l\'avis de loyer', kind: 'generate' };
    else if (row.status === STATUS.PAID) action = { label: 'Générer la quittance', kind: 'generate' };
    else if (row.status === STATUS.PARTIAL) action = { label: 'Générer le reçu partiel', kind: 'generate' };
    else action = { label: 'Générer l\'avis de loyer', kind: 'generate' };
    return {
      ...row, payment_label: payment, doc_status: docStatus,
      doc_id: doc ? doc.id : null, doc_number: doc ? doc.number : null, doc_type: doc ? doc.type : null,
      has_full_receipt: !!full, has_avis: !!avis,
      action_label: action.label, action_kind: action.kind,
    };
  }));
}

/**
 * Regroupe des documents pour l'impression A4.
 * 'trio' : 3 documents distincts par feuille · 'copies' : 3 exemplaires du même
 * document · 'une' : un document par page, en pleine page.
 */
function buildPrintSheets(receipts, mode = 'trio') {
  const PER_SHEET = mode === 'une' ? 1 : 3;
  const items = [];
  if (mode === 'copies') {
    for (let i = 0; i < PER_SHEET; i++) items.push(receipts[0]);
  } else {
    for (const r of receipts) items.push(r);
  }
  const sheets = [];
  for (let i = 0; i < items.length; i += PER_SHEET) {
    const row = items.slice(i, i + PER_SHEET);
    while (row.length < PER_SHEET) row.push(null);
    sheets.push(row);
  }
  return sheets;
}

function decoratePeriodLabel(year, month) {
  return formatPeriode(year, month);
}

module.exports = {
  STATUS, METHOD_LABELS, TYPE_LABELS,
  getTenancy, getOpenTenancyForTenant, getOpenTenancyForUnit, tenancyCoversPeriod,
  paidForPeriod, periodSummary, fullReceiptExists, fullReceiptForPeriod, lastReceiptOfType,
  nextReceiptNumber, monthBoard,
  recordPayment, issueReceipt, issueFinalReceipt, issueAvisLoyer,
  generateOne, generateForPeriod, generateMonth,
  getReceipt, getReceiptRaw, decorateReceipt, decoratePeriodLabel, buildPrintSheets, buildSnapshot,
};
