'use strict';

const { Router } = require('../utils/router');
const stats = require('../services/stats');
const rent = require('../services/rent');

const router = Router();

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/paiements.csv', async (req, res) => {
  const rows = await stats.paymentHistory({
    year: req.query.year, month: req.query.month,
    tenant_id: req.query.tenant_id, floor_id: req.query.floor_id,
  });
  const header = ['Date de paiement', 'Locataire', 'Etage', 'Logement', 'Periode',
    'Loyer attendu (FCFA)', 'Montant paye (FCFA)', 'Mode', 'Note'];
  const lines = [header.join(';')];
  for (const r of rows) {
    lines.push([
      r.paid_at, `${r.first_name} ${r.last_name}`, r.floor_label, r.unit_name,
      `${String(r.period_month).padStart(2, '0')}/${r.period_year}`,
      r.expected_amount, r.amount, rent.METHOD_LABELS[r.method] || r.method, r.note,
    ].map(csvCell).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="paiements.csv"');
  res.send('' + lines.join('\r\n'));
});

router.get('/quittances.csv', async (req, res) => {
  const rows = (await stats.receiptHistory({
    year: req.query.year, month: req.query.month,
    tenant_id: req.query.tenant_id, floor_id: req.query.floor_id, type: req.query.type,
  })).map(r => rent.decorateReceipt(r));
  const header = ['Numero', 'Type', 'Locataire', 'Etage', 'Logement', 'Periode',
    'Loyer attendu (FCFA)', 'Paye ce paiement (FCFA)', 'Total paye (FCFA)', 'Solde (FCFA)',
    'Date de paiement', 'Emis le'];
  const lines = [header.join(';')];
  const TYPE = {
    quittance: 'Quittance', recu_partiel: 'Reçu partiel',
    quittance_definitive: 'Quittance définitive', avis_loyer: 'Avis de loyer',
  };
  for (const r of rows) {
    lines.push([
      r.number, TYPE[r.type] || r.type, r.tenant_name, r.floor_label, r.unit_name,
      r.period_label, r.expected, r.amount_this, r.total_paid, r.balance,
      r.payment_date, String(r.issued_at).slice(0, 10),
    ].map(csvCell).join(';'));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="quittances.csv"');
  res.send('' + lines.join('\r\n'));
});

module.exports = router;
