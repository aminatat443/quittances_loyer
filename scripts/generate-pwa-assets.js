'use strict';

/**
 * Fabrique les ressources d'installation de la PWA : icônes PNG (any + maskable),
 * icône Apple et images de démarrage iOS. Le rendu vectoriel est confié à Chrome
 * headless (--headless=new --screenshot), déjà utilisé pour les PDF ; chaque PNG
 * est ensuite vérifié octet par octet (en-tête IHDR) pour refuser une sortie mal
 * dimensionnée plutôt que de l'installer.
 *
 * Les tailles d'écran iOS sont lues dans src/views/partials/pwa-head.ejs : la
 * liste servie au navigateur et celle qui produit les fichiers ne peuvent donc
 * pas diverger.
 *
 *   npm run pwa:assets
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'public');
const ICON_DIR = path.join(PUBLIC_DIR, 'icons');
const SPLASH_DIR = path.join(PUBLIC_DIR, 'splash');
const PARTIAL = path.join(__dirname, '..', 'src', 'views', 'partials', 'pwa-head.ejs');

const svgSource = fs.readFileSync(path.join(ICON_DIR, 'icon.svg'), 'utf8');

/** Le gabarit vectoriel porte l'arrondi « any » ; les variantes le retirent ou réduisent le glyphe. */
function iconSvg(variant) {
  if (variant === 'rounded') return svgSource;
  const square = svgSource.replace('rx="112"', 'rx="0"');
  if (variant === 'full-bleed') return square;
  // maskable : iOS/Android rognent les bords, le glyphe doit tenir dans la zone sûre centrale.
  return square.replace(
    /(<g[\s\S]*?<\/g>\s*<path d="M188[\s\S]*?\/>)(\s*<\/svg>)/,
    '<g transform="translate(256 256) scale(0.8) translate(-256 -256)">$1</g>$2');
}

function page(body, width, height) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:transparent}
  </style></head><body>${body}</body></html>`;
}

function splashBody(width, height) {
  const box = Math.min(width, height);
  const size = Math.round(box * 0.26);
  return `<div style="display:flex;flex-direction:column;align-items:center;text-align:center;
      font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#fff;transform:translateY(-${(box * 0.04) | 0}px)">
    <div style="width:${size}px;height:${size}px;margin-bottom:${(box * 0.045) | 0}px">
      ${svgSource.replace(/<svg /, '<svg width="100%" height="100%" ')}
    </div>
    <div style="font-size:${(box * 0.075) | 0}px;font-weight:700;letter-spacing:-1px">Loyers</div>
    <div style="font-size:${(box * 0.033) | 0}px;font-weight:500;opacity:.72;margin-top:${(box * 0.016) | 0}px">
      Gestion des quittances de loyer</div>
  </div>`;
}

const CHROME = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium']
  .find(bin => spawnSync(bin, ['--version'], { timeout: 20000 }).status === 0);

if (!CHROME) {
  console.error('Aucun Chrome/Chromium détecté : installez-en un ou indiquez CHROME_PATH.');
  process.exit(1);
}

function shoot(html, file, width, height) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwa-assets-'));
  const src = path.join(dir, 'source.html');
  fs.writeFileSync(src, html);
  const args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    '--default-background-color=00000000', `--user-data-dir=${path.join(dir, 'profile')}`,
    `--screenshot=${file}`, `file://${src}`];
  const run = spawnSync(CHROME, args, { timeout: 60000, encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  if (!fs.existsSync(file)) {
    const detail = String(run.stderr || run.stdout || run.error || '').trim().slice(0, 200);
    throw new Error(`Rendu impossible pour ${path.basename(file)}${detail ? ` : ${detail}` : ''}`);
  }
  verifyPng(file, width, height);
}

/** IHDR : largeur en octets 16-19, hauteur en 20-23 (big-endian). */
function verifyPng(file, width, height) {
  const head = fs.readFileSync(file).subarray(0, 24);
  const w = head.readUInt32BE(16);
  const h = head.readUInt32BE(20);
  if (w !== width || h !== height) {
    throw new Error(`${path.basename(file)} sort en ${w}×${h} au lieu de ${width}×${height}`);
  }
}

const ICONS = [
  { file: 'icon-192.png', px: 192, variant: 'rounded' },
  { file: 'icon-512.png', px: 512, variant: 'rounded' },
  { file: 'maskable-192.png', px: 192, variant: 'maskable' },
  { file: 'maskable-512.png', px: 512, variant: 'maskable' },
  { file: 'apple-touch-icon.png', px: 180, variant: 'full-bleed' },
];

fs.mkdirSync(ICON_DIR, { recursive: true });
fs.mkdirSync(SPLASH_DIR, { recursive: true });

for (const icon of ICONS) {
  const target = path.join(ICON_DIR, icon.file);
  shoot(page(iconSvg(icon.variant), icon.px, icon.px), target, icon.px, icon.px);
  console.log(`icône ${icon.file} (${icon.px}×${icon.px}, ${icon.variant})`);
}

const splashSizes = [...fs.readFileSync(PARTIAL, 'utf8').matchAll(/px: '(\d+)x(\d+)'/g)]
  .map(m => ({ w: Number(m[1]), h: Number(m[2]) }));
if (!splashSizes.length) throw new Error('Aucune taille d’écran trouvée dans la table STARTUP de pwa-head.ejs');

for (const { w, h } of splashSizes) {
  const target = path.join(SPLASH_DIR, `${w}x${h}.png`);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>`
    + `html,body{margin:0;padding:0;width:${w}px;height:${h}px;overflow:hidden;background:#1c4c34}`
    + `body{display:flex;align-items:center;justify-content:center}</style></head><body>`
    + splashBody(w, h) + '</body></html>';
  shoot(html, target, w, h);
  console.log(`écran de démarrage ${w}×${h}`);
}

console.log(`\n${ICONS.length + splashSizes.length} fichiers générés dans src/public/{icons,splash}.`);
