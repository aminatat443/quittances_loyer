'use strict';

const { Router } = require('../utils/router');
const db = require('../db');
const { idOf } = require('../utils/params');
const tenantsSvc = require('../services/tenants');
const unitsSvc = require('../services/units');
const rent = require('../services/rent');
const flash = require('../services/flash');

const router = Router();

router.get('/', async (req, res) => {
  const filters = {
    q: (req.query.q || '').trim() || null,
    floor_id: req.query.floor_id || null,
    type_code: req.query.type_code || null,
    status: req.query.status || null,
    includeArchived: req.query.status === 'archived',
  };
  const [tenants, floors, types] = await Promise.all([
    tenantsSvc.listTenants(filters),
    unitsSvc.listFloors(),
    unitsSvc.listUnitTypes(),
  ]);
  res.render('tenants/index', { title: 'Locataires', filters, tenants, floors, types });
});

router.get('/nouveau', async (req, res) => {
  const units = await unitsSvc.listUnits();
  res.render('tenants/form', {
    title: 'Ajouter un locataire',
    tenant: null,
    units: units.filter(u => u.status !== 'occupied'),
    back: '/locataires',
  });
});

router.post('/nouveau', async (req, res) => {
  try {
    const t = await tenantsSvc.createTenant(req.body);
    flash(req, `${t.first_name} ${t.last_name} enregistré(e).`);
    res.redirect(`/locataires/${t.id}`);
  } catch (e) {
    flash(req, null, e.message);
    res.redirect('/locataires/nouveau');
  }
});

router.get('/:id', async (req, res) => {
  const tenant = await tenantsSvc.getTenant(idOf(req.params.id));
  if (!tenant) return res.status(404).render('error', { title: 'Introuvable', message: 'Locataire inconnu.' });
  const tenancies = await db.prepare(`
    SELECT te.*, u.name AS unit_name, f.label AS floor_label, ut.label AS type_label
    FROM tenancies te JOIN units u ON u.id = te.unit_id
    JOIN floors f ON f.id = u.floor_id JOIN unit_types ut ON ut.code = u.unit_type_code
    WHERE te.tenant_id = ? ORDER BY te.start_date DESC`).all(tenant.id);

  const periods = [];
  for (const te of tenancies) {
    const rows = await db.prepare(`
      SELECT period_year, period_month,
             SUM(amount) AS paid, MAX(expected_amount) AS expected
      FROM payments WHERE tenancy_id = ?
      GROUP BY period_year, period_month ORDER BY period_year DESC, period_month DESC`).all(te.id);
    periods.push({ tenancy: te, rows: rows.map(r => ({
      ...r,
      balance: Math.max(r.expected - r.paid, 0),
      label: rent.decoratePeriodLabel(r.period_year, r.period_month),
      status: r.paid >= r.expected ? 'payé' : (r.paid > 0 ? 'partiel' : 'en attente'),
    })) });
  }
  const receipts = await db.prepare(`
    SELECT r.* FROM receipts r WHERE r.cancelled = FALSE AND r.tenancy_id IN
    (SELECT id FROM tenancies WHERE tenant_id = ?)
    ORDER BY r.period_year DESC, r.period_month DESC, r.id DESC`).all(tenant.id);
  const open = tenancies.find(t => !t.end_date);
  const allUnits = await unitsSvc.listUnits();
  const units = allUnits.filter(u => u.status !== 'occupied' || (open && u.id === open.unit_id));

  res.render('tenants/show', {
    title: `${tenant.first_name} ${tenant.last_name}`,
    tenant, tenancies, periods, receipts, open,
    availableUnits: units.filter(u => u.status !== 'occupied'),
  });
});

router.get('/:id/modifier', async (req, res) => {
  const tenant = await tenantsSvc.getTenant(idOf(req.params.id));
  if (!tenant) return res.status(404).render('error', { title: 'Introuvable', message: 'Locataire inconnu.' });
  const [open, units] = await Promise.all([
    tenantsSvc.currentTenancy(tenant.id),
    unitsSvc.listUnits(),
  ]);
  res.render('tenants/form', {
    title: `Modifier ${tenant.first_name} ${tenant.last_name}`,
    tenant, open, units, back: `/locataires/${tenant.id}`,
  });
});

router.post('/:id/modifier', async (req, res) => {
  try {
    await tenantsSvc.updateTenant(idOf(req.params.id), req.body);
    flash(req, 'Fiche mise à jour.');
  } catch (e) {
    flash(req, null, e.message);
  }
  res.redirect(`/locataires/${idOf(req.params.id)}`);
});

router.post('/:id/depart', async (req, res) => {
  try {
    await tenantsSvc.endTenancy(idOf(req.params.id), req.body.departure_date || new Date().toISOString().slice(0, 10));
    flash(req, 'Départ enregistré. L\'historique des paiements et des quittances est conservé.');
  } catch (e) {
    flash(req, null, e.message);
  }
  res.redirect(`/locataires/${idOf(req.params.id)}`);
});

router.post('/:id/relogement', async (req, res) => {
  try {
    await tenantsSvc.moveTenant(idOf(req.params.id), Number(req.body.unit_id),
      req.body.start_date || new Date().toISOString().slice(0, 10), Number(req.body.monthly_rent) || 0);
    flash(req, 'Logement réattribué ; l\'ancienne occupation reste dans l\'historique.');
  } catch (e) {
    flash(req, null, e.message);
  }
  res.redirect(`/locataires/${idOf(req.params.id)}`);
});

module.exports = router;
