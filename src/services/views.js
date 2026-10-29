'use strict';

const settings = require('./settings');
const { formatFcfa, formatPeriode, formatDateFr, amountToFrenchWords, elided } = require('../utils/format');

/** Variables globales des vues EJS — utilisées par HTTP et par le rendu PDF. */
function viewGlobals(req = {}) {
  const session = req.session || {};
  const now = new Date();
  return {
    app: { name: 'Quittances de loyer', owner: settings.get('owner_name') },
    settingsMap: settings.all(),
    fmtFcfa: formatFcfa,
    fmtPeriode: formatPeriode,
    fmtDate: formatDateFr,
    fmtWords: amountToFrenchWords,
    elided,
    path: (req.path) || '',
    query: req.query || {},
    today: now.toISOString().slice(0, 10),
    curYear: now.getFullYear(),
    curMonth: now.getMonth() + 1,
    flash: { ok: session.flashOk || null, err: session.flashErr || null },
  };
}

module.exports = { viewGlobals };
