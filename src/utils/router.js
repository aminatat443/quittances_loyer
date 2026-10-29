'use strict';

const express = require('express');

/** Express 4 n'attend pas les gestionnaires asynchrones : une promesse rejetée
 * mettrait fin au processus. Chaque fonction enregistrée est donc enveloppée
 * pour rendre la main au middleware de gestion d'erreurs.
 */
function wrap(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.catch === 'function') r.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function Router(options) {
  const router = express.Router(options);
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
    const original = router[method];
    router[method] = (...args) => original.apply(router, args.map(a => (typeof a === 'function' ? wrap(a) : a)));
  }
  return router;
}

module.exports = { Router, wrap };
