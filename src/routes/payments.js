'use strict';

const { Router } = require('../utils/router');
const db = require('../db');
const rent = require('../services/rent');
const tenantsSvc = require('../services/tenants');
const unitsSvc = require('../services/units');
const stats = require('../services/stats');
const flash = require('../services/flash');

const router = Router();

async function activeWithTenancy() {
  return db.prepare(`SELECT t.id, t.first_name, t.last_name, te.id AS tenancy_id,
                     te.monthly_rent, u.name AS unit_name, f.label AS floor_label
                     FROM tenants t
                     JOIN tenancies te ON te.tenant_id = t.id AND te.end_date IS NULL
                     JOIN units u ON u.id = te.unit_id
                     JOIN floors f ON f.id = u.floor_id
                     ORDER BY lower(t.last_name), lower(t.first_name)`).all();
}

router.get('/', async (req, res) => {
  const f = {
    year: req.query.year || null,
    month: req.query.month || null,
    tenant_id: req.query.tenant_id || null,
    floor_id: req.query.floor_id || null,
  };
  const [history, tenants, floors] = await Promise.all([
    stats.paymentHistory(f), activeWithTenancy(), unitsSvc.listFloors(),
  ]);
  const rows = history.map(p => ({
    ...p,
    tenant_name: `${p.first_name} ${p.last_name}`.trim(),
  }));
  res.render('payments/index', {
    title: 'Paiements',
    filters: f,
    payments: rows,
    tenants,
    floors,
    total: rows.reduce((s, p) => s + p.amount, 0),
  });
});

router.get('/nouveau', async (req, res) => {
  res.render('payments/form', {
    title: 'Enregistrer un paiement',
    tenants: await activeWithTenancy(),
    methods: rent.METHOD_LABELS,
  });
});

router.post('/', async (req, res) => {
  const b = req.body;
  const amount = Math.round(Number(b.amount));
  try {
    const result = await rent.recordPayment({
      tenancy_id: Number(b.tenancy_id),
      amount,
      paid_at: b.paid_at,
      method: b.method || 'especes',
      period_year: Number(b.period_year),
      period_month: Number(b.period_month),
      note: b.observations || b.note || '',
      observations: b.observations || b.note || '',
    }, { generate: b.generate === 'none' ? 'none' : 'auto' });

    if (result.receipt) {
      flash(req, `${result.receipt.type === 'recu_partiel' ? 'Reçu de paiement partiel' : 'Quittance'} généré : ${result.receipt.number}`);
      return res.redirect(`/quittances/${result.receipt.id}`);
    }
    flash(req, 'Paiement enregistré sans quittance.');
    return res.redirect('/paiements');
  } catch (e) {
    if (e.duplicate) {
      flash(req, null, e.message);
      return res.redirect('/paiements/nouveau');
    }
    flash(req, null, e.message);
    return res.redirect('/paiements/nouveau');
  }
});

module.exports = router;
