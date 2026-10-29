'use strict';

const db = require('../db');

function fullName(t) {
  return `${t.first_name} ${t.last_name}`.trim();
}

async function getTenant(id) {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

async function currentTenancy(tenantId) {
  return db.prepare(`SELECT t.*, u.name AS unit_name, u.floor_id, u.unit_type_code, f.label AS floor_label
                     FROM tenancies t JOIN units u ON u.id = t.unit_id
                     JOIN floors f ON f.id = u.floor_id
                     WHERE t.tenant_id = ? AND t.end_date IS NULL LIMIT 1`).get(tenantId);
}

async function listTenants(filters = {}) {
  let sql = `SELECT te.*,
               tu.name AS unit_name, tu.id AS assigned_unit_id,
               f.label AS floor_label, f.id AS floor_id,
               ut.label AS type_label, ut.code AS type_code,
               cu.monthly_rent AS current_rent
             FROM tenants te
             LEFT JOIN tenancies cu ON cu.tenant_id = te.id AND cu.end_date IS NULL
             LEFT JOIN units tu ON tu.id = cu.unit_id
             LEFT JOIN floors f ON f.id = tu.floor_id
             LEFT JOIN unit_types ut ON ut.code = tu.unit_type_code
             WHERE 1=1`;
  const args = [];
  if (filters.q) {
    // ILIKE : la recherche ne distingue pas la casse, comme sur l'ancienne base.
    sql += ` AND (te.first_name ILIKE ? OR te.last_name ILIKE ? OR tu.name ILIKE ? OR f.label ILIKE ?)`;
    const like = `%${filters.q}%`;
    args.push(like, like, like, like);
  }
  if (filters.floor_id) { sql += ' AND f.id = ?'; args.push(filters.floor_id); }
  if (filters.type_code) { sql += ' AND ut.code = ?'; args.push(filters.type_code); }
  if (filters.status) { sql += ' AND te.status = ?'; args.push(filters.status); }
  else if (!filters.includeArchived) { sql += " AND te.status = 'active'"; }
  sql += ' ORDER BY lower(te.last_name), lower(te.first_name)';
  return db.prepare(sql).all(...args);
}

function normalizeEmail(value) {
  const email = String(value || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    const e = new Error('Adresse e-mail invalide.');
    e.validation = true;
    throw e;
  }
  return email;
}

async function createTenant(input) {
  const errors = [];
  if (!input.first_name || !input.first_name.trim()) errors.push('Le prénom est obligatoire.');
  if (!input.last_name || !input.last_name.trim()) errors.push('Le nom est obligatoire.');
  if (!input.unit_id) errors.push('Aucun logement sélectionné.');
  if (input.unit_id) {
    const busy = await db.prepare('SELECT 1 FROM tenancies WHERE unit_id = ? AND end_date IS NULL')
      .get(input.unit_id);
    if (busy) errors.push('Ce logement est déjà occupé. Enregistrez d\'abord le départ de l\'occupant actuel.');
  }
  if (errors.length) { const e = new Error(errors.join(' ')); e.validation = true; throw e; }

  const unit = await db.prepare(`SELECT u.*, f.label AS floor_label, ut.label AS type_label
                           FROM units u JOIN floors f ON f.id = u.floor_id
                           JOIN unit_types ut ON ut.code = u.unit_type_code WHERE u.id = ?`).get(input.unit_id);
  const rent = Number(input.monthly_rent) > 0 ? Number(input.monthly_rent) : unit.default_rent;
  const start = input.start_date || new Date().toISOString().slice(0, 10);

  return db.tx(async () => {
    const info = await db.prepare(`INSERT INTO tenants (first_name, last_name, phone, email, address, notes)
                             VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
      .run(input.first_name.trim(), input.last_name.trim(), input.phone || '',
        normalizeEmail(input.email), input.address || '', input.notes || '');
    const tenantId = info.lastInsertRowid;
    const t = await getTenant(tenantId);
    await db.prepare(`INSERT INTO tenancies (tenant_id, unit_id, start_date, monthly_rent,
                unit_name, floor_label, unit_type_label, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tenantId, unit.id, start, rent, unit.name, unit.floor_label, unit.type_label, '');
    await db.prepare("UPDATE units SET status = 'occupied' WHERE id = ?").run(unit.id);
    return t;
  });
}

async function updateTenant(id, input) {
  const t = await getTenant(id);
  if (!t) { const e = new Error('Locataire introuvable.'); e.validation = true; throw e; }
  await db.tx(async () => {
    await db.prepare('UPDATE tenants SET first_name = ?, last_name = ?, phone = ?, email = ?, address = ?, notes = ? WHERE id = ?')
      .run((input.first_name || t.first_name).trim(), (input.last_name || t.last_name).trim(),
        input.phone ?? t.phone, input.email === undefined ? t.email : normalizeEmail(input.email),
        input.address ?? t.address, input.notes ?? t.notes, id);
    const open = await db.prepare('SELECT * FROM tenancies WHERE tenant_id = ? AND end_date IS NULL').get(id);
    if (open && input.monthly_rent && Number(input.monthly_rent) > 0) {
      // le loyer convenu ne s'applique qu'à cette location, pas aux tarifs par défaut
      await db.prepare('UPDATE tenancies SET monthly_rent = ? WHERE id = ?').run(Number(input.monthly_rent), open.id);
    }
  });
}

async function moveTenant(tenantId, newUnitId, startDate, monthlyRent) {
  const unit = await db.prepare(`SELECT u.*, f.label AS floor_label, ut.label AS type_label
                           FROM units u JOIN floors f ON f.id = u.floor_id
                           JOIN unit_types ut ON ut.code = u.unit_type_code WHERE u.id = ?`).get(newUnitId);
  const busy = await db.prepare('SELECT 1 FROM tenancies WHERE unit_id = ? AND end_date IS NULL').get(newUnitId);
  if (busy) { const e = new Error('Le logement d\'arrivée est déjà occupé.'); e.validation = true; throw e; }
  await db.tx(async () => {
    const open = await db.prepare('SELECT * FROM tenancies WHERE tenant_id = ? AND end_date IS NULL').get(tenantId);
    if (open) {
      await db.prepare('UPDATE tenancies SET end_date = ? WHERE id = ?').run(startDate, open.id);
      await db.prepare("UPDATE units SET status = 'available' WHERE id = ?").run(open.unit_id);
    }
    await db.prepare(`INSERT INTO tenancies (tenant_id, unit_id, start_date, monthly_rent, unit_name, floor_label, unit_type_label)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(tenantId, unit.id, startDate,
        Number(monthlyRent) > 0 ? Number(monthlyRent) : unit.default_rent,
        unit.name, unit.floor_label, unit.type_label);
    await db.prepare("UPDATE units SET status = 'occupied' WHERE id = ?").run(unit.id);
  });
}

async function endTenancy(tenantId, departureDate) {
  const open = await db.prepare('SELECT * FROM tenancies WHERE tenant_id = ? AND end_date IS NULL').get(tenantId);
  if (!open) { const e = new Error('Ce locataire n\'a aucune location en cours.'); e.validation = true; throw e; }
  await db.tx(async () => {
    await db.prepare('UPDATE tenancies SET end_date = ? WHERE id = ?').run(departureDate, open.id);
    await db.prepare("UPDATE units SET status = 'available' WHERE id = ?").run(open.unit_id);
    await db.prepare("UPDATE tenants SET status = 'archived', departure_date = ? WHERE id = ?").run(departureDate, tenantId);
  });
}

async function reactivate(tenantId, unitId, startDate, monthlyRent) {
  await db.prepare("UPDATE tenants SET status = 'active', departure_date = NULL WHERE id = ?").run(tenantId);
  await moveTenant(tenantId, unitId, startDate, monthlyRent);
}

module.exports = {
  fullName, getTenant, currentTenancy, listTenants,
  createTenant, updateTenant, moveTenant, endTenancy, reactivate,
};
