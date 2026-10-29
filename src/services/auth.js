'use strict';

const bcrypt = require('bcryptjs');
const db = require('../db');
const config = require('../config');
const settings = require('./settings');

const HASH_KEY = 'admin_password_hash';
const USER_KEY = 'admin_username';

/** Crée le compte administrateur au premier démarrage, jamais avant les migrations. */
async function ensureAdmin() {
  const existing = await db.prepare('SELECT value FROM settings WHERE key = ?').get(HASH_KEY);
  if (existing) return false;
  const hash = bcrypt.hashSync(config.admin.password, 10);
  await settings.set(HASH_KEY, hash);
  await settings.set(USER_KEY, config.admin.username);
  return true;
}

async function verify(username, password) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(HASH_KEY);
  const userRow = await db.prepare('SELECT value FROM settings WHERE key = ?').get(USER_KEY);
  if (!row || !userRow) return false;
  if (username !== userRow.value) return false;
  return bcrypt.compareSync(password, row.value);
}

async function changePassword(oldPassword, newPassword) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(HASH_KEY);
  if (!row || !bcrypt.compareSync(oldPassword, row.value)) return false;
  await settings.set(HASH_KEY, bcrypt.hashSync(newPassword, 10));
  return true;
}

module.exports = { ensureAdmin, verify, changePassword };
