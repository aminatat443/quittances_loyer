'use strict';

const { Router } = require('../utils/router');
const rent = require('../services/rent');
const share = require('../services/share');
const pdf = require('../services/pdf');
const flash = require('../services/flash');
const { formatPeriode } = require('../utils/format');

const router = Router();

/**
 * Période affichée : celle demandée, sinon la dernière consultée pendant la
 * session, sinon le mois en cours.
 */
function parsePeriod(req) {
  const year = Number(req.query.year || (req.body && req.body.period_year));
  const month = Number(req.query.month || (req.body && req.body.period_month));
  if (Number.isInteger(year) && year >= 2000 && year <= 2100
      && Number.isInteger(month) && month >= 1 && month <= 12) {
    req.session.monthPeriod = { year, month };
    return { year, month };
  }
  const saved = req.session.monthPeriod;
  if (saved) return { year: saved.year, month: saved.month };
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function query(year, month) {
  return `year=${year}&month=${month}`;
}

function docLabel(type) {
  if (type === 'avis_loyer') return 'Avis de loyer';
  if (type === 'recu_partiel') return 'Reçu partiel';
  return 'Quittance';
}

router.get('/', async (req, res) => {
  const { year, month } = parsePeriod(req);
  const rows = await rent.monthBoard(year, month);
  const summary = {
    tenants: rows.length,
    paid: rows.filter(r => r.status === 'paid').length,
    partial: rows.filter(r => r.status === 'partial').length,
    pending: rows.filter(r => r.status === 'pending').length,
    toGenerate: rows.filter(r => r.action_kind === 'generate').length,
    remaining: rows.reduce((s, r) => s + r.balance, 0),
  };
  res.render('month/index', {
    title: `Quittances de loyer — ${formatPeriode(year, month)}`,
    year, month, rows, summary,
    methods: rent.METHOD_LABELS,
    periodLabel: formatPeriode(year, month),
  });
});

// Un clic : le document est préparé avec les données de la fiche, l'aperçu s'ouvre directement.
router.post('/generer', async (req, res) => {
  const { year, month } = parsePeriod(req);
  const tenancyId = Number(req.body.tenancy_id);
  if (!tenancyId) {
    flash(req, null, 'Location introuvable.');
    return res.redirect(`/quittances/mois?${query(year, month)}`);
  }
  try {
    const result = await rent.generateOne(tenancyId, year, month);
    const label = docLabel(result.receipt.type);
    flash(req, result.created
      ? `${label} généré : ${result.receipt.number} (${result.receipt.snap.tenant_name}).`
      : `${label} déjà généré : ${result.receipt.number} — réimpression possible.`);
    res.redirect(`/quittances/${result.receipt.id}`);
  } catch (e) {
    flash(req, null, e.message);
    res.redirect(`/quittances/mois?${query(year, month)}`);
  }
});

// Lot mensuel : aucun paiement n'est enregistré, aucun message n'est envoyé.
router.post('/toutes', async (req, res) => {
  const { year, month } = parsePeriod(req);
  try {
    const result = await rent.generateMonth(year, month);
    const unpaid = result.board.filter(r => r.status !== 'paid').length;
    const parts = [`${result.created.length} document${result.created.length > 1 ? 's' : ''}`
      + ` préparé${result.created.length > 1 ? 's' : ''}`];
    if (result.already.length) parts.push(`${result.already.length} déjà émis`);
    if (result.failed.length) parts.push(`${result.failed.length} non traité(s)`);
    let message = parts.join(', ') + '.';
    if (unpaid) {
      message += ` Aucun paiement n'a été enregistré : ${unpaid} loyer(s) non réglé(s)`
        + ' reçoivent un avis de loyer, distinct d\'une quittance.';
    }
    flash(req, message);
    res.redirect(`/quittances/mois/recap?${query(year, month)}`);
  } catch (e) {
    flash(req, null, e.message);
    res.redirect(`/quittances/mois?${query(year, month)}`);
  }
});

router.get('/recap', async (req, res) => {
  const { year, month } = parsePeriod(req);
  const rows = await rent.monthBoard(year, month);
  const docs = [];
  for (const row of rows) {
    if (!row.doc_id) continue;
    const receipt = await rent.getReceipt(row.doc_id);
    if (!receipt) continue;
    docs.push({
      row,
      receipt,
      label: docLabel(receipt.type),
      whatsapp: share.whatsappLink(row.phone, receipt),
      email: share.emailLink(row.email, receipt),
    });
  }
  const unpaid = rows.filter(r => r.status !== 'paid');
  const fullDocs = docs.filter(d => d.receipt.is_full);
  res.render('month/recap', {
    title: `Récapitulatif — ${formatPeriode(year, month)}`,
    year, month, docs, unpaid,
    pdfAvailable: pdf.status().available,
    periodLabel: formatPeriode(year, month),
    counts: {
      docs: docs.length,
      full: fullDocs.length,
      partial: docs.filter(d => d.receipt.type === 'recu_partiel').length,
      avis: docs.filter(d => d.receipt.is_avis).length,
      sheets: Math.ceil(fullDocs.length / 3),
    },
  });
});

module.exports = router;
