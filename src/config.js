const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const root = path.join(__dirname, '..');

function resolve(p) {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

/**
 * PostgreSQL est le moteur de référence. DATABASE_URL primer sur les variables
 * PG* individuelles, ce qui laisse le choix de l'écriture dans .env.
 */
function buildDatabaseUrl() {
  const url = process.env.DATABASE_URL || '';
  if (url.trim()) return url.trim();
  const user = process.env.PGUSER || 'quittances';
  const host = process.env.PGHOST || 'localhost';
  const port = Number(process.env.PGPORT) || 5432;
  const name = process.env.PGDATABASE || 'quittances';
  const pass = process.env.PGPASSWORD || '';
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${name}`;
}

function labelOf(url) {
  try {
    const u = new URL(url);
    return `${u.host}/${u.pathname.slice(1)}`;
  } catch {
    return 'PostgreSQL';
  }
}

const databaseUrl = buildDatabaseUrl();

const config = {
  env: process.env.NODE_ENV || 'production',
  port: Number(process.env.PORT) || 3000,
  databaseUrl,
  databaseLabel: labelOf(databaseUrl),
  // Ancienne base SQLite : conservée comme archive et lue par le script d'import.
  sqlitePath: resolve(process.env.SQLITE_ARCHIVE_PATH || './data/rent.sqlite'),
  backupDir: resolve(process.env.BACKUP_DIR || './data/backups'),
  signatureDir: resolve('./data/signatures'),
  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'changeme-2026',
  },
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
};

module.exports = config;
