'use strict';

const { Router } = require('../utils/router');
const crypto = require('crypto');
const auth = require('../services/auth');
const { redirectIfLogged } = require('../middleware/security');

const router = Router();

router.get('/', redirectIfLogged, (req, res) => {
  res.render('login', { title: 'Connexion' });
});

router.post('/', redirectIfLogged, async (req, res) => {
  const { username, password } = req.body;
  if (await auth.verify(username || '', password || '')) {
    req.session.regenerate(() => {
      req.session.authenticated = true;
      req.session._csrf = crypto.randomBytes(32).toString('hex');
      const dest = req.session.afterLogin || '/';
      delete req.session.afterLogin;
      req.session.flashOk = 'Connexion réussie. Bienvenue !';
      res.redirect(dest);
    });
    return;
  }
  res.status(401).render('login', {
    title: 'Connexion',
    error: 'Identifiant ou mot de passe incorrect.',
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
