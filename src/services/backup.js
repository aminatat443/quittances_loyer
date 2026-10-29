'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const config = require('../config');

const run = promisify(execFile);

/**
 * Sauvegarde cohérente via pg_dump (format « custom », compressé, restaurable
 * partiellement par pg_restore). Les fichiers de plus de 30 jours sont purgés.
 * Les variables PG* sont transmises par l'environnement du processus enfant :
 * le mot de passe n'apparaît jamais dans la ligne de commande.
 */
function pgEnv() {
  const u = new URL(config.databaseUrl);
  return {
    ...process.env,
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  };
}

async function createBackup() {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(config.backupDir, `quittances-${stamp}.dump`);
  await run('pg_dump', ['-Fc', '--no-owner', '--no-privileges', '-f', file], { env: pgEnv() });
  await purgeOld();
  return file;
}

async function purgeOld() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  if (!fs.existsSync(config.backupDir)) return;
  for (const f of fs.readdirSync(config.backupDir)) {
    const p = path.join(config.backupDir, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > cutoff) fs.unlinkSync(p);
    } catch { /* fichier déjà supprimé */ }
  }
}

function listBackups() {
  if (!fs.existsSync(config.backupDir)) return [];
  return fs.readdirSync(config.backupDir)
    .filter(f => f.endsWith('.dump') || f.endsWith('.sql'))
    .map(f => {
      const p = path.join(config.backupDir, f);
      const st = fs.statSync(p);
      return { name: f, path: p, size: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Vérifie que l'archive est lisible et contient bien les tables métier. */
async function verifyBackup(file) {
  try {
    const { stdout } = await run('pg_restore', ['--list', file], { env: pgEnv() });
    // Ligne de la liste : « 233; 1259 26818 TABLE public receipts aminata ».
    return /TABLE \S+ receipts\b/.test(stdout) && /TABLE \S+ tenants\b/.test(stdout);
  } catch {
    return false;
  }
}

module.exports = { createBackup, listBackups, verifyBackup, pgEnv };
