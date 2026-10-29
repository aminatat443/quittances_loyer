'use strict';

function formatFcfa(n) {
  const v = Number.isFinite(n) ? Math.round(n) : 0;
  // espace normalisé (Intl produit une fine insécable U+202F selon les locales)
  return new Intl.NumberFormat('fr-FR').format(v).replace(/[\u202F\u00A0]/g, ' ') + ' FCFA';
}

const MOIS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

function formatPeriode(year, month) {
  return `${MOIS[month - 1]} ${year}`;
}

function formatDateFr(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function formatDateTimeFr(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(raw || ''));
  if (!m) return String(raw || '');
  return `${m[3]}/${m[2]}/${m[1]} à ${m[4]}:${m[5]}`;
}

/** « de » ou « d' » selon la première lettre du mot qui suit. */
function elided(word) {
  const s = String(word || '');
  return /^[aeiouyàâäéèêëîïôöûü]/i.test(s) ? `d'${s}` : `de ${s}`;
}

const UNITES = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
const DIZAINES = { 2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante', 8: 'quatre-vingt' };
const SPEC = { 10: 'dix', 11: 'onze', 12: 'douze', 13: 'treize', 14: 'quatorze', 15: 'quinze',
  16: 'seize', 17: 'dix-sept', 18: 'dix-huit', 19: 'dix-neuf' };

function below100(n, atEnd = true) {
  if (n < 10) return UNITES[n];
  if (n < 20) return SPEC[n];
  const d = Math.floor(n / 10);
  const u = n % 10;
  if (d === 7 || d === 9) {
    if (u === 0) return d === 7 ? 'soixante-dix' : 'quatre-vingt-dix';
    if (d === 7 && u === 1) return 'soixante et onze';
    return (d === 7 ? 'soixante' : 'quatre-vingt') + '-' + below100(10 + u);
  }
  const base = DIZAINES[d];
  if (u === 0) return base + (d === 8 && atEnd ? 's' : '');
  if (u === 1 && d < 8) return base + ' et un';
  return base + '-' + UNITES[u];
}

// « cent » et « vingt » ne prennent la marque du pluriel que lorsqu'ils ne sont
// pas suivis d'un autre nombre : deux cent mille, quatre-vingt mille.
function below1000(n, atEnd = true) {
  const c = Math.floor(n / 100);
  const r = n % 100;
  let s = '';
  if (c > 0) {
    if (c === 1) s = 'cent';
    else s = below100(c, r === 0 && atEnd) + ' cent' + (r === 0 && atEnd ? 's' : '');
  }
  if (r > 0) s = s ? s + ' ' + below100(r, atEnd) : below100(r, atEnd);
  return s;
}

function amountToFrenchWords(amount) {
  const n = Math.floor(Math.abs(Number(amount) || 0));
  if (n === 0) return 'Zéro franc CFA';
  const parts = [];
  const M = Math.floor(n / 1_000_000);
  const K = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  if (M > 0) parts.push(M === 1 ? 'un million' : below1000(M, true) + ' millions');
  if (K > 0) parts.push(K === 1 ? 'mille' : below1000(K, false) + ' mille');
  if (rest > 0) parts.push(below1000(rest));
  let words = parts.join(' ');
  if (M > 0 && K === 0 && rest === 0) words += ' de';
  return words.charAt(0).toUpperCase() + words.slice(1) + ' francs CFA';
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = {
  formatFcfa, formatPeriode, formatDateFr, formatDateTimeFr, amountToFrenchWords, escapeHtml, elided, MOIS,
};
