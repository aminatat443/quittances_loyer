'use strict';

const crypto = require('crypto');

function csrf(req, res, next) {
  const session = req.session;
  if (!session._csrf) session._csrf = crypto.randomBytes(32).toString('hex');
  const token = session._csrf;
  res.locals.csrfToken = token;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const field = req.body ? req.body._csrf : undefined;
  const header = req.headers['x-csrf-token'];
  const provided = typeof field === 'string' ? field : header;
  if (!provided || provided.length !== token.length ||
      !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
    return res.status(403).render('error', {
      title: 'Session expirée',
      message: 'Votre session a expiré ou le formulaire est obsolète. Rechargez la page et réessayez.',
    });
  }
  next();
}

// jeton réutilisable dans les formulaires AJAX
function csrfField(req, res, next) {
  res.locals.csrfField = `<input type="hidden" name="_csrf" value="${res.locals.csrfToken || ''}">`;
  next();
}

function requireLogin(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  req.session.afterLogin = req.originalUrl;
  return res.redirect('/login');
}

function redirectIfLogged(req, res, next) {
  if (req.session && req.session.authenticated) return res.redirect('/');
  next();
}

module.exports = { csrf, csrfField, requireLogin, redirectIfLogged };
