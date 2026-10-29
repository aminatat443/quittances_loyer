'use strict';

const db = require('../db');

async function occupancyCounts() {
  const [total_units, occupied, available, tenants] = await Promise.all([
    count('SELECT COUNT(*) AS c FROM units'),
    count("SELECT COUNT(*) AS c FROM units WHERE status = 'occupied'"),
    count("SELECT COUNT(*) AS c FROM units WHERE status = 'available'"),
    count("SELECT COUNT(*) AS c FROM tenants WHERE status = 'active'"),
  ]);
  return { total_units, occupied, available, tenants };
}

async function count(sql, args = []) {
  return (await db.prepare(sql).get(...args)).c;
}

/**
 * attendus = loyers dus par les locations actives couvrant la période.
 * encaisse  = somme des paiements enregistrés pour la période.
 */
async function monthTotals(year, month) {
  const expectedRows = await db.prepare(`SELECT te.monthly_rent AS rent
                                         FROM tenancies te WHERE te.end_date IS NULL`).all();
  const expected = expectedRows.reduce((s, r) => s + r.rent, 0);
  const paidRow = await db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments
                                    WHERE period_year = ? AND period_month = ?`).get(year, month);
  return { expected, collected: paidRow.total };
}

async function paidCounts(year, month) {
  const perTenancy = await db.prepare(`
    SELECT p.tenancy_id, te.monthly_rent AS rent, SUM(p.amount) AS paid
    FROM payments p JOIN tenancies te ON te.id = p.tenancy_id
    WHERE p.period_year = ? AND p.period_month = ?
    GROUP BY p.tenancy_id, te.monthly_rent`).all(year, month);
  const paid = perTenancy.filter(r => r.paid >= r.rent).length;
  const partial = perTenancy.filter(r => r.paid > 0 && r.paid < r.rent).length;
  return { paid, partial };
}

async function pendingCount(year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const activeTenancies = await db.prepare(`SELECT te.id, te.monthly_rent FROM tenancies te
                                      WHERE te.end_date IS NULL
                                      AND substr(te.start_date, 1, 7) <= ?`).all(key);
  let pending = 0;
  const paidQ = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments
                            WHERE tenancy_id = ? AND period_year = ? AND period_month = ?`);
  for (const t of activeTenancies) {
    const p = (await paidQ.get(t.id, year, month)).total;
    if (p < t.monthly_rent) pending++;
  }
  return { pending, due: activeTenancies.length };
}

async function recentReceipts(limit = 6) {
  return db.prepare(`SELECT r.*, te.tenant_id, t.first_name, t.last_name
                     FROM receipts r
                     JOIN tenancies te ON te.id = r.tenancy_id
                     JOIN tenants t ON t.id = te.tenant_id
                     WHERE r.cancelled = FALSE
                     ORDER BY r.issued_at DESC, r.id DESC LIMIT ?`).all(limit);
}

/** Vue mensuelle : un état par location active couvrant la période. */
async function monthlyBoard(year, month) {
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const rows = await db.prepare(`
    SELECT te.id AS tenancy_id, te.monthly_rent AS expected, te.start_date, te.end_date,
           u.id AS unit_id, u.name AS unit_name, f.label AS floor_label, f.position AS floor_position,
           t.id AS tenant_id, t.first_name, t.last_name, t.phone, t.email,
           ut.label AS type_label,
           COALESCE((SELECT SUM(p.amount) FROM payments p
                     WHERE p.tenancy_id = te.id AND p.period_year = ? AND p.period_month = ?), 0) AS paid,
           (SELECT COUNT(*) FROM receipts r
            WHERE r.tenancy_id = te.id AND r.period_year = ? AND r.period_month = ?
            AND r.cancelled = FALSE) AS receipt_count,
           EXISTS (SELECT 1 FROM receipts r
            WHERE r.tenancy_id = te.id AND r.period_year = ? AND r.period_month = ?
            AND r.type IN ('quittance', 'quittance_definitive') AND r.cancelled = FALSE) AS has_full_receipt
    FROM tenancies te
    JOIN units u ON u.id = te.unit_id
    LEFT JOIN unit_types ut ON ut.code = u.unit_type_code
    JOIN floors f ON f.id = u.floor_id
    JOIN tenants t ON t.id = te.tenant_id
    WHERE substr(te.start_date, 1, 7) <= ?
      AND (te.end_date IS NULL OR substr(te.end_date, 1, 7) >= ?)
    ORDER BY f.position, lower(u.name)`,
  ).all(year, month, year, month, year, month, key, key);
  return rows.map(r => {
    const balance = Math.max(r.expected - r.paid, 0);
    let status;
    if (r.paid >= r.expected && r.expected > 0) status = 'paid';
    else if (r.paid > 0) status = 'partial';
    else status = 'pending';
    return { ...r, balance, status,
      tenant_name: `${r.first_name} ${r.last_name}`.trim() };
  });
}

async function paymentHistory(filters = {}) {
  let sql = `SELECT p.*, te.tenant_id, t.first_name, t.last_name,
               u.name AS unit_name, f.label AS floor_label, te.id AS tenancy_id
             FROM payments p
             JOIN tenancies te ON te.id = p.tenancy_id
             JOIN tenants t ON t.id = te.tenant_id
             JOIN units u ON u.id = te.unit_id
             JOIN floors f ON f.id = u.floor_id WHERE 1=1`;
  const args = [];
  if (filters.year && filters.month) { sql += ' AND p.period_year = ? AND p.period_month = ?'; args.push(Number(filters.year), Number(filters.month)); }
  if (filters.tenant_id) { sql += ' AND te.tenant_id = ?'; args.push(filters.tenant_id); }
  if (filters.floor_id) { sql += ' AND u.floor_id = ?'; args.push(filters.floor_id); }
  if (filters.unit_id) { sql += ' AND te.unit_id = ?'; args.push(filters.unit_id); }
  sql += ' ORDER BY p.paid_at DESC, p.id DESC';
  return db.prepare(sql).all(...args);
}

async function receiptHistory(filters = {}) {
  let sql = `SELECT r.*, t.first_name, t.last_name, t.phone, t.email, te.tenant_id,
               u.name AS unit_name, f.label AS floor_label
             FROM receipts r
             JOIN tenancies te ON te.id = r.tenancy_id
             JOIN tenants t ON t.id = te.tenant_id
             JOIN units u ON u.id = te.unit_id
             JOIN floors f ON f.id = u.floor_id
             WHERE r.cancelled = FALSE`;
  const args = [];
  if (filters.year && filters.month) { sql += ' AND r.period_year = ? AND r.period_month = ?'; args.push(Number(filters.year), Number(filters.month)); }
  if (filters.tenant_id) { sql += ' AND te.tenant_id = ?'; args.push(filters.tenant_id); }
  if (filters.floor_id) { sql += ' AND u.floor_id = ?'; args.push(filters.floor_id); }
  if (filters.type === 'full') sql += " AND r.type IN ('quittance', 'quittance_definitive')";
  if (filters.type === 'partial') sql += " AND r.type = 'recu_partiel'";
  if (filters.type === 'avis') sql += " AND r.type = 'avis_loyer'";
  sql += ' ORDER BY r.period_year DESC, r.period_month DESC, r.issued_at DESC, r.id DESC';
  const rows = await db.prepare(sql).all(...args);
  return rows.map(r => ({ ...r, tenant_name: `${r.first_name} ${r.last_name}`.trim() }));
}

module.exports = {
  occupancyCounts, monthTotals, paidCounts, pendingCount,
  recentReceipts, monthlyBoard, paymentHistory, receiptHistory,
};
