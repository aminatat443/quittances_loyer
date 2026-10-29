'use strict';

const db = require('../db');

const DEFAULTS = {
  owner_name: 'Bamby Sidibé',
  building_name: 'Immeuble Bamby Sidibé',
  building_address: '',
  owner_phone: '',
  city: 'Dakar',
  receipt_prefix: 'QL',
  notice_prefix: 'AL',
  whatsapp_country_code: '221',
  document_title: 'QUITTANCE DE LOYER',
  document_footer: '',
  fiscal_year_start: '',
  signature_path: '',
};

const FLOORS = [
  { label: 'Premier étage', short_label: '1er étage', position: 1 },
  { label: 'Deuxième étage', short_label: '2e étage', position: 2 },
  { label: 'Troisième étage', short_label: '3e étage (terrasse)', position: 3 },
];

const UNIT_TYPES = [
  { code: 'A', label: 'Chambre avec salle de bains et salon', default_rent: 40000, position: 1 },
  { code: 'B', label: 'Chambre simple', default_rent: 20000, position: 2 },
  { code: 'C', label: 'Grande chambre (terrasse)', default_rent: 25000, position: 3 },
];

/**
 * Les paramètres sont lus des dizaines de fois par requête (libellés des
 * documents, indicatif WhatsApp, préfixes de numérotation). Ils sont donc gardés
 * en mémoire : la base ne reçoit que les écritures, et un lecteur reste
 * synchrone. `init()` doit être appelé une fois au démarrage, après les migrations.
 */
let cache = null;

async function seed() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`)
      .run(key, value);
  }
  const floorCount = (await db.prepare('SELECT COUNT(*) AS c FROM floors').get()).c;
  if (floorCount === 0) {
    const ins = db.prepare('INSERT INTO floors (label, short_label, position) VALUES (?, ?, ?)');
    for (const f of FLOORS) await ins.run(f.label, f.short_label, f.position);
  }
  const typeCount = (await db.prepare('SELECT COUNT(*) AS c FROM unit_types').get()).c;
  if (typeCount === 0) {
    const ins = db.prepare('INSERT INTO unit_types (code, label, default_rent, position) VALUES (?, ?, ?, ?)');
    for (const t of UNIT_TYPES) await ins.run(t.code, t.label, t.default_rent, t.position);
  }
}

async function reload() {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const map = { ...DEFAULTS };
  for (const r of rows) map[r.key] = r.value;
  cache = map;
  return cache;
}

async function init() {
  await seed();
  return reload();
}

function ensure() {
  if (!cache) throw new Error('settings.init() n\'a pas été appelé : les paramètres ne sont pas chargés.');
}

function get(key) {
  ensure();
  if (cache[key] !== undefined) return cache[key];
  return DEFAULTS[key] !== undefined ? DEFAULTS[key] : '';
}

function all() {
  ensure();
  return { ...cache };
}

async function set(key, value) {
  const v = String(value == null ? '' : value);
  await db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, v);
  ensure();
  cache[key] = v;
}

async function setMany(map) {
  await db.tx(async () => {
    for (const [k, v] of Object.entries(map)) await set(k, v);
  });
}

module.exports = { get, all, set, setMany, DEFAULTS, FLOORS, UNIT_TYPES, seed, init, reload };
