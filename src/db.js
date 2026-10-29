'use strict';

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const pg = require('pg');
const config = require('./config');

/**
 * Couche d'accès aux données PostgreSQL.
 *
 * Les dates sont relues en chaînes « AAAA-MM-JJ [HH:MM:SS] » : tout le formatage
 * français de l'application (utils/format) travaille sur ce format, et un
 * document doit continuer à afficher exactement la même date qu'avant migration.
 */
const toText = (v) => v;
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.DATE, toText);
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (v) =>
  (v ? String(v).replace('T', ' ').slice(0, 19) : v));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => {
  if (!v) return v;
  const d = new Date(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
});

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.PG_POOL_MAX) || 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  application_name: 'quittances-loyer',
});
pool.on('error', (err) => console.error('Connexion PostgreSQL perdue :', err.message));

/** Placeholders « ? » (hérités de l'ancienne base) -> « $1, $2 … » de PostgreSQL. */
function toPg(sql) {
  let out = '';
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === "'") { out += sql[++i] || ''; }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '?') { out += `$${++n}`; continue; }
    out += ch;
  }
  return out;
}

// Client réservé quand on est dans une transaction, sinon le pool.
const txStore = new AsyncLocalStorage();
const currentClient = () => txStore.getStore() || pool;

async function query(sql, params = []) {
  return currentClient().query(toPg(sql), params);
}

/** Même surface que l'ancien pilote : get / all / run, en asynchrone. */
function prepare(sql) {
  const text = toPg(sql);
  const call = async (params) => {
    const res = await currentClient().query(text, params);
    return res;
  };
  return {
    all: async (...p) => (await call(p)).rows,
    get: async (...p) => (await call(p)).rows[0] ?? null,
    run: async (...p) => {
      const res = await call(p);
      const row = res.rows && res.rows[0];
      return { changes: res.rowCount, lastInsertRowid: row && row.id !== undefined ? row.id : null };
    },
  };
}

async function exec(sql) {
  await currentClient().query(sql);
}

/**
 * Enveloppe une fonction dans BEGIN/COMMIT. Les appels imbriqués se fondent dans
 * la transaction courante (comme l'ancien pilote), donc un service appelé depuis
 * une transaction y reste rattaché.
 */
async function tx(fn) {
  if (txStore.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txStore.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connexion déjà perdue */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Compat avec l'ancienne écriture `db.transaction(() => {...})()`. */
function transaction(fn) {
  return (...args) => tx(() => fn(...args));
}

const MIGRATIONS_DIR = path.join(__dirname, 'db', 'migrations');

/** Applique les migrations *.sql dans l'ordre, une par transaction. */
async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMP NOT NULL DEFAULT LOCALTIMESTAMP
  )`);
  const done = new Set((await pool.query('SELECT name FROM migrations')).rows.map(r => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw new Error(`Migration ${file} refusée : ${err.message}`);
    }
    client.release();
  }
  return files;
}

/** Attend que le serveur réponde, avec un message clair plutôt qu'une pile pg. */
async function assertReachable() {
  try {
    const r = await pool.query('SELECT current_database() AS db, version() AS v');
    return r.rows[0];
  } catch (err) {
    const e = new Error(`Base de données injoignable (${config.databaseLabel}) : ${err.message}`);
    e.cause = err;
    throw e;
  }
}

async function close() {
  await pool.end();
}

module.exports = {
  pool, prepare, query, exec, transaction, tx, migrate, close,
  assertReachable, toPg, databaseName: () => config.databaseLabel,
};
