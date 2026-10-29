'use strict';

const db = require('./db');
const settings = require('./services/settings');
const auth = require('./services/auth');

/**
 * Démarrage de l'application, dans l'ordre : la base doit être joignable et à
 * jour avant de lire les paramètres, car le compte administrateur y est stocké.
 * Les vues et le PDF appellent settings.get() en synchrone : le cache mémoire
 * doit donc être rempli avant la première requête HTTP.
 */
async function boot() {
  const info = await db.assertReachable();
  await db.migrate();
  await settings.init();
  await auth.ensureAdmin();
  // Les sessions lues suppriment leur propre ligne expirée ; ce passage évite
  // que la table ne croisse indéfiniment avec les navigateurs jamais rouverts.
  await db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  return info;
}

module.exports = { boot };
