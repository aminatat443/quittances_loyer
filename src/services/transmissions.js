'use strict';

const db = require('../db');
const { formatDateTimeFr } = require('../utils/format');

/**
 * Journal des transmissions. Le statut « prepared » (préparé) ne signifie jamais
 * que le locataire a reçu le document : seule une confirmation fiable — serveur
 * SMTP, clic explicite de l'utilisateur — donne « sent » ou « printed ».
 */

const CHANNELS = {
  whatsapp: 'WhatsApp',
  email: 'E-mail',
  print: 'Impression',
  pdf: 'Téléchargement PDF',
};

const STATUSES = {
  prepared: 'Préparé',
  sent: 'Envoyé',
  failed: 'Échec',
  printed: 'Imprimé',
};

async function record({ receipt_id, channel, status, recipient = '', detail = '' }) {
  if (!CHANNELS[channel]) throw new Error(`Canal inconnu : ${channel}`);
  if (!STATUSES[status]) throw new Error(`Statut inconnu : ${status}`);
  if (!await db.prepare('SELECT 1 FROM receipts WHERE id = ?').get(receipt_id)) {
    throw new Error('Document introuvable pour cet historique.');
  }
  const info = await db.prepare(`INSERT INTO receipt_transmissions
    (receipt_id, channel, status, recipient, detail) VALUES (?, ?, ?, ?, ?) RETURNING id`)
    .run(receipt_id, channel, status, String(recipient || '').trim(), String(detail || '').trim());
  return decorate(await db.prepare('SELECT * FROM receipt_transmissions WHERE id = ?')
    .get(info.lastInsertRowid));
}

function decorate(t) {
  return {
    ...t,
    channel_label: CHANNELS[t.channel] || t.channel,
    status_label: STATUSES[t.status] || t.status,
    at_fr: formatDateTimeFr(t.created_at),
  };
}

async function listFor(receiptId) {
  const rows = await db.prepare(`SELECT * FROM receipt_transmissions WHERE receipt_id = ?
                                 ORDER BY created_at DESC, id DESC`).all(receiptId);
  return rows.map(decorate);
}

/** Dernier enregistrement par canal : sert à l'affichage condensé des listes. */
async function latestByChannel(receiptId) {
  const map = {};
  for (const t of await listFor(receiptId)) if (!map[t.channel]) map[t.channel] = t;
  return map;
}

module.exports = { CHANNELS, STATUSES, record, listFor, latestByChannel, decorate };
