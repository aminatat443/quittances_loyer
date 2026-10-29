'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Chaque fichier de test obtient sa propre base SQLite temporaire :
 * les variables d'environnement doivent être posées avant le chargement de src/db.
 */
function loadApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quittances-test-'));
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
  process.env.BACKUP_DIR = path.join(dir, 'backups');
  process.env.ADMIN_PASSWORD = 'test-motdepasse';
  process.env.SESSION_SECRET = 'test-secret';

  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  const db = require('../src/db');
  require('../src/services/settings');

  return { dir, db, config, services: {
    rent: require('../src/services/rent'),
    tenants: require('../src/services/tenants'),
    units: require('../src/services/units'),
    share: require('../src/services/share'),
    stats: require('../src/services/stats'),
    settings: require('../src/services/settings'),
    auth: require('../src/services/auth'),
    format: require('../src/utils/format'),
  } };
}

function seedFloorAndUnit(services, { name = 'A1', code = 'A', rent = 40000 } = {}) {
  const floor = services.units.listFloors()[0];
  services.units.createUnit({ floor_id: floor.id, unit_type_code: code, name, default_rent: rent, status: 'available' });
  return services.units.listUnits().find(u => u.name === name);
}

function seedTenant(services, opts = {}) {
  const unit = seedFloorAndUnit(services, opts);
  const tenant = services.tenants.createTenant({
    first_name: opts.first_name || 'Awa', last_name: opts.last_name || 'Ndiaye',
    phone: opts.phone || '', email: opts.email || '',
    unit_id: unit.id, start_date: opts.start_date || '2026-01-05', monthly_rent: opts.rent || 0,
  });
  return { tenant, unit, tenancy: services.tenants.currentTenancy(tenant.id) };
}

module.exports = { loadApp, seedFloorAndUnit, seedTenant };
