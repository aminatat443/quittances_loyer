'use strict';

const { Router } = require('../utils/router');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const settings = require('../services/settings');
const unitsSvc = require('../services/units');
const backup = require('../services/backup');
const auth = require('../services/auth');
const config = require('../config');
const flash = require('../services/flash');

const router = Router();

const ALLOWED = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.signatureDir),
  filename: (req, file, cb) => cb(null, `signature-${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.has(ext)) return cb(new Error('Format non autorisé : utilisez PNG, JPG ou WEBP.'));
    cb(null, true);
  },
}).single('signature');

const uploadSignature = (req, res, next) => upload(req, res, err => {
  if (err) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Fichier trop volumineux (2 Mo maximum).'
      : err.message || 'Importation impossible.';
    flash(req, null, message);
    return res.redirect('/parametres');
  }
  next();
});

const EDITABLE = ['owner_name', 'building_name', 'building_address', 'owner_phone', 'city',
  'receipt_prefix', 'notice_prefix', 'whatsapp_country_code', 'document_title', 'document_footer',
  'fiscal_year_start'];

router.get('/', (req, res) => {
  res.render('settings/index', {
    title: 'Paramètres',
    s: settings.all(),
    types: unitsSvc.listUnitTypes(),
    floors: unitsSvc.listFloors(),
    backups: backup.listBackups(),
    smtp: require('../services/mailer').smtpStatus(),
    pdfEngine: require('../services/pdf').status(),
    business: require('../services/share').businessApiStatus(),
  });
});

router.post('/', (req, res) => {
  const patch = {};
  for (const key of EDITABLE) if (req.body[key] !== undefined) patch[key] = req.body[key].trim();
  if (!patch.owner_name) { flash(req, null, 'Le nom du propriétaire ne peut pas être vide.'); return res.redirect('/parametres'); }
  if (!/^[A-Za-z0-9-]{1,8}$/.test(patch.receipt_prefix || 'QL')) {
    flash(req, null, 'Préfixe de numérotation invalide (lettres, chiffres et tirets, 8 caractères maximum).');
    return res.redirect('/parametres');
  }
  if (!/^[A-Za-z0-9-]{1,8}$/.test(patch.notice_prefix || 'AL')) {
    flash(req, null, 'Préfixe des avis de loyer invalide (lettres, chiffres et tirets, 8 caractères maximum).');
    return res.redirect('/parametres');
  }
  if (patch.whatsapp_country_code && !/^\d{1,4}$/.test(patch.whatsapp_country_code)) {
    flash(req, null, 'Indicatif téléphonique invalide : des chiffres uniquement, ex. 221.');
    return res.redirect('/parametres');
  }
  settings.setMany(patch);
  for (const [code, rent] of Object.entries(req.body.tarifs || {})) {
    const v = Math.round(Number(rent));
    if (Number.isInteger(v) && v >= 0) unitsSvc.updateFloorTypeDefaultRent(code, v);
  }
  flash(req, 'Paramètres enregistrés. Les quittances déjà émises conservent leurs données d\'origine.');
  res.redirect('/parametres');
});

router.post('/signature', uploadSignature, (req, res) => {
  const previous = settings.get('signature_path');
  if (req.body.remove === '1') {
    if (previous && fs.existsSync(path.join(config.signatureDir, previous))) {
      fs.unlinkSync(path.join(config.signatureDir, previous));
    }
    settings.set('signature_path', '');
    flash(req, 'Signature retirée des documents.');
    return res.redirect('/parametres');
  }
  if (!req.file) { flash(req, null, 'Aucun fichier reçu.'); return res.redirect('/parametres'); }
  if (previous && fs.existsSync(path.join(config.signatureDir, previous))) {
    fs.unlinkSync(path.join(config.signatureDir, previous));
  }
  settings.set('signature_path', path.basename(req.file.filename));
  flash(req, 'Signature importée. Elle apparaîtra sur les nouvelles quittances.');
  res.redirect('/parametres');
});

router.post('/mot-de-passe', (req, res) => {
  const { old_password, new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    flash(req, null, 'Le nouveau mot de passe doit contenir au moins 8 caractères.');
    return res.redirect('/parametres');
  }
  if (!auth.changePassword(old_password || '', new_password)) {
    flash(req, null, 'Mot de passe actuel incorrect.');
    return res.redirect('/parametres');
  }
  flash(req, 'Mot de passe administrateur mis à jour.');
  res.redirect('/parametres');
});

router.post('/sauvegarde', async (req, res) => {
  try {
    const file = await backup.createBackup();
    flash(req, `Sauvegarde créée : ${path.basename(file)}`);
  } catch (e) {
    flash(req, null, `Échec de la sauvegarde : ${e.message}`);
  }
  res.redirect('/parametres');
});

router.get('/sauvegardes/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(config.backupDir, name);
  if (!name.endsWith('.sqlite') || !fs.existsSync(file)) {
    return res.status(404).render('error', { title: 'Introuvable', message: 'Sauvegarde inconnue.' });
  }
  res.download(file);
});

module.exports = router;
