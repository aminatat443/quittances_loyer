'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../config');
const rent = require('./rent');
const { viewGlobals } = require('./views');

/**
 * Génération PDF à partir du modèle HTML/CSS officiel des documents : le rendu
 * est donc identique à l'aperçu d'impression. Le moteur est un Chromium ou un
 * Chrome déjà installé sur la machine (aucun téléchargement de navigateur) ;
 * `CHROME_PATH` permet d'indiquer le binaire, et sans moteur disponible la
 * production est refusée plutôt que simulée.
 */

const CANDIDATES = [
  process.env.CHROME_PATH,
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium',
].filter(Boolean);

let probed;

function detectEngine() {
  if (process.env.PDF_ENGINE === 'none') return null;
  if (probed !== undefined) return probed;
  for (const bin of CANDIDATES) {
    const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
    if (!probe.error && probe.status === 0) {
      probed = { bin, version: String(probe.stdout || probe.stderr || '').trim().split('\n')[0] };
      return probed;
    }
  }
  probed = null;
  return probed;
}

function status() {
  const engine = detectEngine();
  return engine
    ? { available: true, engine: engine.bin, version: engine.version }
    : { available: false, engine: null, version: null };
}

const BASE_FLAGS = [
  '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
  '--allow-file-access-from-files', '--no-pdf-header-footer',
  '--run-all-compositor-stages-before-draw', '--virtual-time-budget=20000',
];

function localAssetUrls(html) {
  const publicDir = `file://${path.join(__dirname, '..', 'public')}`;
  return html
    .replace(/"\/static\//g, `"${publicDir}/`)
    .replace(/"\/signatures\//g, `file://${config.signatureDir}/`);
}

/** Rend le modèle d'impression en HTML autonome (ressources en file://), sans barre d'outils. */
function sheetsHtml(receipts, mode = 'trio') {
  const app = require('../app');
  const sheets = rent.buildPrintSheets(receipts, mode);
  const locals = {
    ...viewGlobals(),
    title: 'Impression',
    receipts, sheets, mode,
    standalone: true,
    autoPrint: false,
    copiesNotice: false,
    sheetsLabel: sheetsLabel(mode, sheets.length),
  };
  return new Promise((resolve, reject) => {
    app.render('print/sheets', locals, (err, html) => {
      if (err) return reject(err);
      resolve(localAssetUrls(html));
    });
  });
}

function sheetsLabel(mode, count) {
  if (mode === 'une') return `${count} page A4 (une quittance par page)`;
  if (mode === 'copies') return '1 feuille A4 (3 exemplaires)';
  return `${count} feuille A4 (${count * 3} emplacement${count * 3 > 1 ? 's' : ''})`;
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// Dans un conteneur, le noyau ne fournit presque jamais de namespace d'utilisateur :
// le bac à sable de Chromium y échoue, d'où PDF_NO_SANDBOX pour les images Docker.
function withoutSandbox() {
  return isRoot() || process.env.PDF_NO_SANDBOX === '1';
}

function chromePdf(html, bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quittances-pdf-'));
  const htmlFile = path.join(dir, 'documents.html');
  const pdfFile = path.join(dir, 'documents.pdf');
  try {
    fs.writeFileSync(htmlFile, html, { mode: 0o600 });
    const args = (flags) => [...flags, ...BASE_FLAGS, ...(withoutSandbox() ? ['--no-sandbox'] : []),
      `--user-data-dir=${path.join(dir, 'profile')}`,
      `--print-to-pdf=${pdfFile}`, `file://${htmlFile}`];
    let run = spawnSync(bin, args(['--headless=new']), { timeout: 120000, encoding: 'utf8' });
    if (run.status !== 0 || !fs.existsSync(pdfFile)) {
      run = spawnSync(bin, args(['--headless']), { timeout: 120000, encoding: 'utf8' });
    }
    if (!fs.existsSync(pdfFile)) {
      const detail = String(run.stderr || run.stdout || run.error || '').trim().slice(0, 200);
      const e = new Error(`Le moteur PDF n'a produit aucun fichier${detail ? ` : ${detail}` : ''}.`);
      e.pdfFailure = true;
      throw e;
    }
    return fs.readFileSync(pdfFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** PDF A4 prêt à l'envoi ou au téléchargement. Lève pdfUnavailable / pdfFailure. */
async function toPdf(receipts, mode = 'trio') {
  const engine = detectEngine();
  if (!engine) {
    const e = new Error('Aucun moteur de rendu PDF (Chromium ou Chrome) n\'est disponible sur cette machine.');
    e.pdfUnavailable = true;
    throw e;
  }
  const list = Array.isArray(receipts) ? receipts : [receipts];
  if (!list.length) {
    const e = new Error('Aucun document à convertir en PDF.');
    e.validation = true;
    throw e;
  }
  return chromePdf(await sheetsHtml(list, mode), engine.bin);
}

/** Nom de fichier ASCII : les accents sont écartés, les navigateurs les réencodent mal. */
function filenameFor(receipts, mode = 'trio') {
  const list = Array.isArray(receipts) ? receipts : [receipts];
  const slug = (value) => String(value || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (list.length > 1) return `quittances-lot-${slug(list[0].number)}-${list.length}-${slug(mode)}.pdf`;
  const r = list[0];
  return `${slug(r.type === 'avis_loyer' ? 'avis-loyer' : 'quittance')}-${slug(r.number)}-${slug(r.period_label)}.pdf`;
}

module.exports = { detectEngine, status, sheetsHtml, sheetsLabel, toPdf, filenameFor };
