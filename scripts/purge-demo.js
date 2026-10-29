'use strict';

/**
 * Purge le contenu de démonstration créé par les scripts smoke.js et
 * stress-print.js (logements au nom préfixé, et tout ce qui en dépend).
 * L'ordre suit les clés étrangères : transmission → document → paiement →
 * location → locataire → logement.
 */
async function purgeUnitsLike(db, pattern) {
  const safePattern = String(pattern).replace(/'/g, "''");
  await db.tx(async () => {
    const like = `name LIKE '${safePattern}'`;
    const tenancies = `(SELECT id FROM tenancies WHERE unit_id IN (SELECT id FROM units WHERE ${like}))`;
    await db.query(`DELETE FROM receipt_transmissions WHERE receipt_id IN
                    (SELECT id FROM receipts WHERE tenancy_id IN ${tenancies})`);
    await db.query(`DELETE FROM receipts WHERE tenancy_id IN ${tenancies}`);
    await db.query(`DELETE FROM payments WHERE tenancy_id IN ${tenancies}`);
    const tenants = [...new Set((await db.query(
      `SELECT DISTINCT tenant_id FROM tenancies WHERE unit_id IN
       (SELECT id FROM units WHERE ${like})`)).rows.map(r => Number(r.tenant_id)))];
    await db.query(`DELETE FROM tenancies WHERE unit_id IN (SELECT id FROM units WHERE ${like})`);
    if (tenants.length) await db.query(`DELETE FROM tenants WHERE id IN (${tenants.join(',')})`);
    await db.query(`DELETE FROM units WHERE ${like}`);
  });
}

module.exports = { purgeUnitsLike };
