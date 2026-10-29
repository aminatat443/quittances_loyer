'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const { csrf, csrfField, requireLogin } = require('./middleware/security');

const app = express();
app.disable('x-powered-by');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', false);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use('/signatures', express.static(config.signatureDir));
// Manifest, service worker et page hors ligne : à la racine du scope, avant toute session.
app.use(require('./routes/pwa'));

/**
 * Store de sessions PostgreSQL. express-session attend des callbacks : chaque
 * opération se termine par cb(null, …) ou cb(err), et les lignes venues à
 * échéance sont supprimées à la lecture.
 */
function pgSessionStore() {
  const db = require('./db');
  const Store = session.Store;
  class PgSessionStore extends Store {
    async get(sid, cb) {
      try {
        const row = await db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
        if (!row) return cb(null, null);
        if (Number(row.expires) < Date.now()) {
          await db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
          return cb(null, null);
        }
        return cb(null, JSON.parse(row.data));
      } catch (err) {
        return cb(err);
      }
    }
    async set(sid, sess, cb) {
      try {
        const maxAge = (sess.cookie && sess.cookie.maxAge) || 7 * 24 * 3600 * 1000;
        await db.prepare(`INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
                          ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`)
          .run(sid, JSON.stringify(sess), Date.now() + maxAge);
        if (cb) cb(null);
      } catch (err) {
        if (cb) cb(err);
      }
    }
    async destroy(sid, cb) {
      try {
        await db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        if (cb) cb(null);
      } catch (err) {
        if (cb) cb(err);
      }
    }
  }
  return new PgSessionStore({});
}

app.use(session({
  store: pgSessionStore(),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 },
}));
// variables globales des vues — avant le CSRF pour que la page « session expirée » puisse s'afficher
const { viewGlobals } = require('./services/views');
app.use((req, res, next) => {
  Object.assign(res.locals, viewGlobals(req));
  delete req.session.flashOk;
  delete req.session.flashErr;
  next();
});
app.use(csrf);
app.use(csrfField);

app.use('/login', require('./routes/auth'));
app.use(require('./middleware/security').requireLogin);

app.use('/api', require('./routes/api'));
app.use('/', require('./routes/dashboard'));
app.use('/logements', require('./routes/units'));
app.use('/locataires', require('./routes/tenants'));
app.use('/paiements', require('./routes/payments'));
// « Quittances du mois » avant /quittances, dont le routeur déclare un GET /:id
app.use('/quittances/mois', require('./routes/month'));
app.use('/quittances', require('./routes/receipts'));
app.use('/impression', require('./routes/print'));
app.use('/calendrier', require('./routes/calendar'));
app.use('/parametres', require('./routes/settings'));
app.use('/export', require('./routes/export'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Page introuvable', message: 'Cette page n\'existe pas.' });
});
app.use((err, req, res, next) => {
  // La contrainte d'unicité par période est le dernier rempart contre le doublon :
  // sa violation doit rester un message lisible, pas une erreur technique.
  if (err && err.code === '23505' && !err.validation && !err.duplicate) {
    err.validation = true;
    err.message = 'Un document existe déjà pour cette période : aucune copie n\'a été créée.';
  }
  console.error(err);
  const message = err.validation || err.duplicate
    ? err.message
    : 'Une erreur inattendue est survenue. L\'action n\'a pas été exécutée.';
  if (req.accepts('html') && !req.path.startsWith('/api')) {
    return res.status(err.validation || err.duplicate ? 400 : 500)
      .render('error', { title: 'Action impossible', message });
  }
  res.status(500).json({ error: message });
});

if (require.main === module) {
  require('./boot').boot().then((info) => {
    app.listen(config.port, () => {
      console.log(`Base de données : ${info.db} (PostgreSQL)`);
      console.log(`Application de gestion locative démarrée : http://localhost:${config.port}`);
    });
  }).catch((err) => {
    console.error(`Démarrage impossible : ${err.message}`);
    console.error('Vérifiez que PostgreSQL est démarré et que DATABASE_URL est correct dans .env.');
    process.exit(1);
  });
}

module.exports = app;
