'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadApp } = require('./helpers');

const { db, config, services } = loadApp();

test('le mot de passe administrateur est stocké haché, jamais en clair', () => {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").get();
  assert.ok(row, 'le compte administrateur doit exister après la migration');
  assert.match(row.value, /^\$2[aby]\$/, 'empreinte bcrypt attendue');
  assert.doesNotMatch(row.value, /test-motdepasse/);
  assert.strictEqual(services.auth.verify('admin', 'mauvais-mot-de-passe'), false);
  assert.strictEqual(services.auth.verify(config.admin.username, 'test-motdepasse'), true);
});

test('le changement de mot de passe exige le mot de passe courant', () => {
  assert.strictEqual(services.auth.changePassword('incorrect', 'nouveau-mot-de-passe'), false);
  assert.strictEqual(services.auth.changePassword('test-motdepasse', 'nouveau-mot-de-passe'), true);
  assert.strictEqual(services.auth.verify('admin', 'nouveau-mot-de-passe'), true);
  services.auth.changePassword('nouveau-mot-de-passe', 'test-motdepasse');
});

test('les données affichées sont échappées côté vue', () => {
  const { escapeHtml } = services.format;
  assert.strictEqual(escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(escapeHtml('a"b\'c'), 'a&quot;b&#39;c');
});

test('le jeton CSRF protège les opérations d\'écriture', () => {
  const { csrf } = require('../src/middleware/security');
  const run = (body) => {
    const req = { method: 'POST', body, session: { _csrf: 'a'.repeat(64) }, headers: {} };
    const res = { locals: {}, status(c) { this.code = c; return this; }, render() {} };
    let allowed = false;
    csrf(req, res, () => { allowed = true; });
    return { allowed, code: res.code };
  };
  assert.strictEqual(run({ _csrf: 'a'.repeat(64) }).allowed, true);
  assert.strictEqual(run({ _csrf: 'b'.repeat(64) }).allowed, false);
  assert.strictEqual(run({ _csrf: 'b'.repeat(64) }).code, 403);
  assert.strictEqual(run({}).code, 403);
});

test('les routes de gestion exigent une session authentifiée', () => {
  const { requireLogin } = require('../src/middleware/security');
  const call = (session) => {
    let redirect = null, allowed = false;
    requireLogin({ session, originalUrl: '/locataires' },
      { redirect: url => { redirect = url; } }, () => { allowed = true; });
    return { redirect, allowed };
  };
  assert.deepStrictEqual(call({}), { redirect: '/login', allowed: false });
  assert.deepStrictEqual(call({ authenticated: true }), { redirect: null, allowed: true });
});
