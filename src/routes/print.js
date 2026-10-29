'use strict';

const { Router } = require('../utils/router');
const db = require('../db');
const rent = require('../services/rent');
const unitsSvc = require('../services/units');
const stats = require('../services/stats');
const flash = require('../services/flash');
const transmissions = require('../services/transmissions');
const pdf = require('../services/pdf');

const router = Router();

const MODES = ['trio', 'copies', 'une'];

function parseIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[, ]+/);
  return [...new Set(list.map(s => Number(s)).filter(n => Number.isInteger(n) && n > 0))].slice(0, 60);
}

function parseMode(raw) {
  return MODES.includes(raw) ? raw : 'trio';
}

/** Les documents demandés, dans l'ordre de sélection, annulés exclus. */
function loadReceipts(ids) {
  return ids.map(id => rent.getReceipt(id)).filter(Boolean);
}

function selectedIds(req) {
  const raw = req.query.ids !== undefined ? req.query.ids : req.body.ids;
  const tokens = Array.isArray(raw) ? raw : String(raw || '').split(/[, ]+/);
  const extra = req.body.all === '1' && req.body.period_year && req.body.period_month
    ? db.prepare(`SELECT id FROM receipts WHERE cancelled = 0 AND period_year = ? AND period_month = ?
                   AND type <> 'avis_loyer' ORDER BY number`)
      .all(Number(req.body.period_year), Number(req.body.period_month)).map(r => r.id)
    : [];
  return parseIds([...tokens, ...extra]);
}

router.get('/', (req, res) => {
  const year = Number(req.query.year) || res.locals.curYear;
  const month = Number(req.query.month) || res.locals.curMonth;
  const receipts = db.prepare(`SELECT r.* FROM receipts r WHERE r.cancelled = 0
                               AND r.period_year = ? AND r.period_month = ?
                               ORDER BY r.number`).all(year, month).map(x => rent.decorateReceipt(x));
  const canGenerate = stats.monthlyBoard(year, month)
    .filter(r => r.status === 'paid' && !r.has_full_receipt).length;
  res.render('print/index', {
    title: 'Impression groupée',
    year, month, receipts, canGenerate,
    floors: unitsSvc.listFloors(),
    pdfAvailable: pdf.status().available,
  });
});

// Génère automatiquement les quittances des loyers du mois déjà intégralement réglés
// qui n'ont pas encore de quittance intégrale.
router.post('/generer-mois', (req, res) => {
  const year = Number(req.body.period_year);
  const month = Number(req.body.period_month);
  if (!year || !month) { flash(req, null, 'Mois et année requis.'); return res.redirect('/impression'); }
  const board = require('../services/stats').monthlyBoard(year, month);
  let created = 0;
  try {
    for (const row of board) {
      if (row.status !== 'paid') continue;
      const result = rent.generateForPeriod(row.tenancy_id, year, month);
      if (result.created) created++;
    }
    flash(req, created > 0
      ? `${created} quittance${created > 1 ? 's' : ''} générée${created > 1 ? 's' : ''} pour ${rent.decoratePeriodLabel(year, month)}.`
      : 'Aucune quittance à générer : tous les loyers réglés ont déjà leur document, ou aucun loyer n\'est réglé.');
  } catch (e) {
    flash(req, null, e.message);
  }
  res.redirect(`/impression?year=${year}&month=${month}`);
});

function apercu(req, res) {
  const ids = selectedIds(req);
  const mode = parseMode(req.query.mode !== undefined ? req.query.mode : req.body.mode);
  if (!ids.length) {
    return res.status(400).render('error', { title: 'Rien à imprimer', message: 'Sélectionnez au moins une quittance.' });
  }
  const receipts = loadReceipts(ids);
  if (!receipts.length) {
    return res.status(404).render('error', { title: 'Introuvable', message: 'Quittances introuvables.' });
  }
  const selected = mode === 'copies' ? receipts.slice(0, 1) : receipts;
  const sheets = rent.buildPrintSheets(selected, mode);
  res.render('print/sheets', {
    title: 'Aperçu d\'impression',
    receipts: selected, sheets, mode,
    standalone: req.query.standalone === '1',
    autoPrint: req.query.pdf === '1' || req.query.print === '1',
    copiesNotice: mode === 'copies' && receipts.length > 1,
    sheetsLabel: pdf.sheetsLabel(mode, sheets.length),
  });
}

router.get('/apercu', apercu);
router.post('/apercu', apercu);

/**
 * Demande d'impression : enregistre l'action (statut « préparé », le navigateur
 * ne peut pas confirmer la sortie du papier) puis ouvre l'aperçu qui déclenche
 * la boîte d'impression.
 */
router.post('/demander', (req, res) => {
  const ids = selectedIds(req);
  const mode = parseMode(req.body.mode);
  const receipts = loadReceipts(ids);
  if (!receipts.length) {
    flash(req, null, 'Sélectionnez au moins une quittance à imprimer.');
    return res.redirect('/impression');
  }
  const sheets = rent.buildPrintSheets(mode === 'copies' ? receipts.slice(0, 1) : receipts, mode);
  for (const r of receipts) {
    transmissions.record({
      receipt_id: r.id, channel: 'print', status: 'prepared', recipient: '',
      detail: `Demande d'impression · ${pdf.sheetsLabel(mode, sheets.length)}`
        + (mode === 'une' ? '' : ' · confirmation papier à enregistrer'),
    });
  }
  res.redirect(`/impression/apercu?ids=${receipts.map(r => r.id).join(',')}&mode=${mode}&print=1`);
});

/** Confirmation explicite d'une impression physique réellement sortie. */
router.post('/confirme', (req, res) => {
  const ids = selectedIds(req);
  const receipts = loadReceipts(ids);
  if (!receipts.length) {
    flash(req, null, 'Aucun document à confirmer.');
    return res.redirect('/impression');
  }
  for (const r of receipts) {
    transmissions.record({
      receipt_id: r.id, channel: 'print', status: 'printed', recipient: '',
      detail: `Impression confirmée manuellement (${req.body.sheets || '?'} feuille(s) annoncée(s)).`,
    });
  }
  flash(req, `Impression enregistrée pour ${receipts.length} document(s).`);
  res.redirect(`/quittances/${receipts[0].id}`);
});

/**
 * PDF réel reprenant le modèle officiel. En POST, l'action est tracée ; en GET
 * (lien depuis l'aperçu), aucun doublon d'historique n'est ajouté.
 */
async function buildPdf(req, res, record) {
  const ids = selectedIds(req);
  const mode = parseMode(req.query.mode !== undefined ? req.query.mode : req.body.mode);
  const receipts = loadReceipts(ids);
  if (!receipts.length) {
    flash(req, null, 'Sélectionnez au moins une quittance.');
    return res.redirect('/impression');
  }
  try {
    const buffer = await pdf.toPdf(receipts, mode);
    if (record) {
      for (const r of receipts) {
        transmissions.record({
          receipt_id: r.id, channel: 'pdf', status: 'prepared', recipient: '',
          detail: `PDF groupé téléchargé (${Math.round(buffer.length / 1024)} Ko, `
            + `${pdf.sheetsLabel(mode, rent.buildPrintSheets(mode === 'copies' ? [r] : receipts, mode).length)}).`,
        });
      }
    }
    const name = receipts.length === 1 ? pdf.filenameFor(receipts[0]) : pdf.filenameFor(receipts, mode);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).end(buffer);
  } catch (e) {
    if (record) {
      for (const r of receipts) {
        transmissions.record({ receipt_id: r.id, channel: 'pdf', status: 'failed', recipient: '', detail: e.message });
      }
    }
    flash(req, null, `${e.message} L'aperçu d'impression s'ouvre à la place : choisissez `
      + '« Enregistrer au format PDF » dans la boîte du navigateur.');
    return res.redirect(`/impression/apercu?ids=${receipts.map(r => r.id).join(',')}&mode=${mode}&pdf=1`);
  }
}

router.get('/pdf', (req, res) => buildPdf(req, res, false));
router.post('/pdf', (req, res) => buildPdf(req, res, true));

module.exports = router;
