'use strict';

const path = require('path');
const express = require('express');

/**
 * Fichiers que le scope de l'application exige à la RACINE de l'URL :
 * un service worker déclaré sous /static/ ne pourrait contrôler que /static/,
 * et le manifest doit rester accessible sans connexion pour que le navigateur
 * puisse proposer l'installation. Ces trois routes sont donc montées avant la
 * session et avant l'exigence de connexion.
 */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const router = express.Router();

function serve(file, type) {
  return (req, res) => {
    // no-cache : une nouvelle version doit être détectée au rechargement,
    // pas dans un mois, quand le navigateur comparera les octets du fichier.
    // Le type est imposé ici : « .webmanifest » est inconnu de la table MIME et
    // sortirait en application/octet-stream, ce que le navigateur refuserait.
    res.set('Content-Type', type).set('Cache-Control', 'no-cache')
      .sendFile(path.join(PUBLIC_DIR, file));
  };
}

router.get('/sw.js', serve('sw.js', 'application/javascript; charset=utf-8'));
router.get('/manifest.webmanifest', serve('manifest.webmanifest', 'application/manifest+json; charset=utf-8'));
router.get('/hors-ligne', serve('hors-ligne.html', 'text/html; charset=utf-8'));

module.exports = router;
