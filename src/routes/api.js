'use strict';

const { Router } = require('../utils/router');
const db = require('../db');
const rent = require('../services/rent');
const tenantsSvc = require('../services/tenants');
const unitsSvc = require('../services/units');

const router = Router();

router.get('/periode', async (req, res) => {
  const tenantId = Number(req.query.tenant_id);
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const tenant = await tenantsSvc.getTenant(tenantId);
  if (!tenant || !year || !month) return res.status(400).json({ error: 'Locataire, mois et année requis.' });

  const open = await tenantsSvc.currentTenancy(tenantId);
  if (!open) return res.json({ has_tenancy: false, tenant_name: `${tenant.first_name} ${tenant.last_name}` });

  const [summary, receipts, unit, hasFullReceipt] = await Promise.all([
    rent.periodSummary(open.id, year, month),
    db.prepare(`SELECT id, number, type, amount_this, total_paid, balance, payment_date
                FROM receipts WHERE tenancy_id = ? AND period_year = ? AND period_month = ?
                AND cancelled = FALSE ORDER BY id`).all(open.id, year, month),
    unitsSvc.getUnit(open.unit_id),
    rent.fullReceiptExists(open.id, year, month),
  ]);
  return res.json({
    has_tenancy: true,
    tenancy_id: open.id,
    tenant_name: `${tenant.first_name} ${tenant.last_name}`,
    unit_name: unit.name,
    floor_label: unit.floor_label,
    type_label: unit.type_label,
    monthly_rent: open.monthly_rent,
    expected: summary.expected,
    paid: summary.paid,
    balance: summary.balance,
    status: summary.status,
    receipts,
    has_full_receipt: hasFullReceipt,
  });
});

module.exports = router;
