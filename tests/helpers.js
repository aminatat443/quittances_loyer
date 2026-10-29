'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

/**
 * Chaque fichier de test obtient sa propre base PostgreSQL, créée à partir des
 * identifiants de DATABASE_URL (le rôle doit avoir CREATEDB). La base est
 * supprimée à la fin du fichier : les tests ne touchent jamais les données réelles.
 *
 * createdb et dropdb s'exécutent en synchrone : la base existe déjà quand le
 * fichier de test charge src/config, ce qui laisse les require() d'en-tête intacts.
 */
function adminConnection() {
  delete require.cache[require.resolve('../src/config')];
  const url = new URL(require('../src/config').databaseUrl);
  return {
    url,
    args: ['-h', url.hostname, '-p', url.port || '5432', '-U', decodeURIComponent(url.username)],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password || '') },
  };
}

function createTestDatabase() {
  const { url, args, env } = adminConnection();
  const name = `quittances_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  execFileSync('createdb', [...args, name], { env });
  const target = new URL(url.toString());
  target.pathname = `/${name}`;
  return { name, target: target.toString(), args, env };
}

function dropTestDatabase(name, { args, env }) {
  try {
    execFileSync('dropdb', [...args, '--if-exists', name], { env });
  } catch (e) {
    console.error(`Base de test ${name} non supprimée : ${e.message}`);
  }
}

/**
 * Ouvre la base de test du fichier : environnement, modules, puis migrations,
 * paramètres et compte administrateur. Le hook `before` attend cette préparation
 * avant le premier test, le hook `after` rend la base disponible puis la supprime.
 */
function loadApp() {
  // Garde-fou : un module de l'application chargé avant loadApp() aurait gardé la
  // configuration lue dans .env, c'est-à-dire la base réelle. Exiger l'ordre évite
  // qu'un fichier de test écrive des données de production par inadvertance.
  for (const mod of ['../src/config', '../src/db', '../src/app']) {
    if (require.cache[require.resolve(mod)]) {
      throw new Error(`${mod} est déjà chargé : appelez loadApp() avant tout require des modules de l'application.`);
    }
  }
  const created = createTestDatabase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quittances-test-'));
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = created.target;
  process.env.BACKUP_DIR = path.join(dir, 'backups');
  process.env.ADMIN_PASSWORD = 'test-motdepasse';
  process.env.SESSION_SECRET = 'test-secret';

  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  const db = require('../src/db');
  require('../src/services/settings');

  const services = {
    rent: require('../src/services/rent'),
    tenants: require('../src/services/tenants'),
    units: require('../src/services/units'),
    share: require('../src/services/share'),
    stats: require('../src/services/stats'),
    settings: require('../src/services/settings'),
    auth: require('../src/services/auth'),
    format: require('../src/utils/format'),
  };

  // Le catch attaché ici évite un rejet non traité si le fichier échoue avant le hook.
  const ready = require('../src/boot').boot();
  ready.catch(() => {});

  test.before(async () => { await ready; });
  test.after(async () => {
    await db.close();
    dropTestDatabase(created.name, created);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { db, config, services, ready, databaseName: created.name };
}

async function seedFloorAndUnit(services, { name = 'A1', code = 'A', rent = 40000 } = {}) {
  const floor = (await services.units.listFloors())[0];
  await services.units.createUnit({
    floor_id: floor.id, unit_type_code: code, name, default_rent: rent, status: 'available',
  });
  return (await services.units.listUnits()).find(u => u.name === name);
}

async function seedTenant(services, opts = {}) {
  const unit = await seedFloorAndUnit(services, opts);
  const tenant = await services.tenants.createTenant({
    first_name: opts.first_name || 'Awa', last_name: opts.last_name || 'Ndiaye',
    phone: opts.phone || '', email: opts.email || '',
    unit_id: unit.id, start_date: opts.start_date || '2026-01-05', monthly_rent: opts.rent || 0,
  });
  return { tenant, unit, tenancy: await services.tenants.currentTenancy(tenant.id) };
}

module.exports = { loadApp, seedFloorAndUnit, seedTenant };
