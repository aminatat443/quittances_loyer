'use strict';

const db = require('../db');

async function listFloors() {
  return db.prepare('SELECT * FROM floors ORDER BY position').all();
}

async function listUnitTypes() {
  return db.prepare('SELECT * FROM unit_types ORDER BY position').all();
}

async function getUnit(id) {
  return db.prepare(`SELECT u.*, f.label AS floor_label, f.position AS floor_position,
                     ut.label AS type_label, ut.code AS type_code,
                     t.first_name, t.last_name, te.start_date AS tenancy_start, te.id AS tenancy_id,
                     te.monthly_rent AS agreed_rent
                     FROM units u
                     JOIN floors f ON f.id = u.floor_id
                     JOIN unit_types ut ON ut.code = u.unit_type_code
                     LEFT JOIN tenancies te ON te.unit_id = u.id AND te.end_date IS NULL
                     LEFT JOIN tenants t ON t.id = te.tenant_id
                     WHERE u.id = ?`).get(id);
}

async function listUnits() {
  return db.prepare(`SELECT u.*, f.label AS floor_label, f.position AS floor_position,
                     ut.label AS type_label, ut.code AS type_code,
                     t.id AS tenant_id, t.first_name || ' ' || t.last_name AS tenant_name,
                     te.monthly_rent AS agreed_rent, te.start_date AS tenancy_start
                     FROM units u
                     JOIN floors f ON f.id = u.floor_id
                     JOIN unit_types ut ON ut.code = u.unit_type_code
                     LEFT JOIN tenancies te ON te.unit_id = u.id AND te.end_date IS NULL
                     LEFT JOIN tenants t ON t.id = te.tenant_id
                     ORDER BY f.position, lower(u.name)`).all();
}

async function buildingByFloor() {
  const [floors, units] = await Promise.all([listFloors(), listUnits()]);
  return floors.map(f => ({
    ...f,
    units: units.filter(u => u.floor_id === f.id),
  }));
}

async function createUnit(input) {
  const errors = [];
  if (!input.floor_id) errors.push('Sélectionnez un étage.');
  if (!input.name || !input.name.trim()) errors.push('Le numéro ou nom du logement est obligatoire.');
  if (!input.unit_type_code) errors.push('Sélectionnez un type de logement.');
  const rent = Number(input.default_rent);
  if (!Number.isInteger(rent) || rent < 0) errors.push('Le loyer mensuel doit être un entier en FCFA.');
  if (input.unit_type_code === 'C') {
    const already = await db.prepare("SELECT 1 FROM units WHERE unit_type_code = 'C'").get();
    if (already) errors.push('Il ne peut exister qu\'un seul logement de type C (terrasse).');
  }
  if (errors.length) { const e = new Error(errors.join(' ')); e.validation = true; throw e; }
  const dup = await db.prepare('SELECT 1 FROM units WHERE floor_id = ? AND name = ?')
    .get(input.floor_id, input.name.trim());
  if (dup) { const e = new Error('Un logement porte déjà ce nom à cet étage.'); e.validation = true; throw e; }
  await db.prepare(`INSERT INTO units (floor_id, unit_type_code, name, default_rent, status, notes)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(input.floor_id, input.unit_type_code, input.name.trim(), rent,
      input.status || 'available', input.notes || '');
}

async function updateUnit(id, input) {
  const u = await db.prepare('SELECT * FROM units WHERE id = ?').get(id);
  if (!u) { const e = new Error('Logement introuvable.'); e.validation = true; throw e; }
  const rent = Number(input.default_rent);
  if (!Number.isInteger(rent) || rent < 0) {
    const e = new Error('Le loyer mensuel doit être un entier en FCFA.'); e.validation = true; throw e;
  }
  const occupied = await db.prepare('SELECT 1 FROM tenancies WHERE unit_id = ? AND end_date IS NULL').get(id);
  let status = input.status || u.status;
  if (occupied && status !== 'occupied') status = 'occupied';
  if (!occupied && status === 'occupied') status = 'available';
  await db.prepare(`UPDATE units SET floor_id = ?, unit_type_code = ?, name = ?, default_rent = ?, status = ?, notes = ?
              WHERE id = ?`)
    .run(input.floor_id || u.floor_id, input.unit_type_code || u.unit_type_code,
      (input.name || u.name).trim(), rent, status, input.notes ?? u.notes, id);
  const open = await db.prepare('SELECT * FROM tenancies WHERE unit_id = ? AND end_date IS NULL').get(id);
  if (open && input.sync_rent === true) {
    await db.prepare('UPDATE tenancies SET monthly_rent = ? WHERE id = ?').run(rent, open.id);
  }
}

async function deleteUnit(id) {
  const busy = await db.prepare('SELECT 1 FROM tenancies WHERE unit_id = ?').get(id);
  if (busy) {
    const e = new Error('Ce logement possède un historique d\'occupation : markez-le indisponible plutôt que de le supprimer.');
    e.validation = true; throw e;
  }
  await db.prepare('DELETE FROM units WHERE id = ?').run(id);
}

async function createFloor(label, shortLabel) {
  if (!label || !label.trim()) { const e = new Error('Le libellé de l\'étage est obligatoire.'); e.validation = true; throw e; }
  const row = await db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM floors').get();
  await db.prepare('INSERT INTO floors (label, short_label, position) VALUES (?, ?, ?)')
    .run(label.trim(), (shortLabel || label).trim(), row.p);
}

async function updateFloorTypeDefaultRent(code, rent) {
  await db.prepare('UPDATE unit_types SET default_rent = ? WHERE code = ?').run(Number(rent), code);
}

module.exports = {
  listFloors, listUnitTypes, getUnit, listUnits, buildingByFloor,
  createUnit, updateUnit, deleteUnit, createFloor, updateFloorTypeDefaultRent,
};
