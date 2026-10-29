'use strict';

const nodemailer = require('nodemailer');
const share = require('./share');
const pdf = require('./pdf');

/**
 * Envoi réel des documents par e-mail. Les identifiants SMTP viennent
 * exclusivement de l'environnement (.env, hors dépôt Git) et ne sont jamais
 * transmis à une vue : seul l'état du service est affiché.
 */

function smtpStatus() {
  const host = process.env.SMTP_HOST || '';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const from = process.env.SMTP_FROM || user;
  const available = Boolean(host && user && pass && from);
  const missing = [];
  if (!host) missing.push('SMTP_HOST');
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');
  if (!from) missing.push('SMTP_FROM');
  return {
    available,
    host,
    port: Number(process.env.SMTP_PORT) || (String(process.env.SMTP_SECURE) === 'true' ? 465 : 587),
    secure: String(process.env.SMTP_SECURE) === 'true',
    user,
    from,
    missing,
  };
}

function createTransport() {
  const s = smtpStatus();
  if (process.env.SMTP_JSON_TRANSPORT === '1') {
    // transport de démonstration / test : construit le message sans se connecter à un serveur
    return nodemailer.createTransport({ jsonTransport: true });
  }
  if (!s.available) return null;
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: { user: s.user, pass: process.env.SMTP_PASS },
    maxConnections: 2,
    logger: false,
  });
}

/**
 * Envoie `receipt` à `to` avec le PDF officiel en pièce jointe.
 * Lève une erreur de validation si l'adresse est invalide ou si le moteur PDF
 * ou SMTP manque — l'appelant ne doit alors jamais annoncer un envoi.
 * `options.transport` permet d'injecter un transport (tests hors ligne).
 */
async function sendReceipt(receipt, to, options = {}) {
  const address = String(to || '').trim();
  if (!share.isValidEmail(address)) {
    const e = new Error('Adresse e-mail invalide ou non renseignée.');
    e.validation = true;
    throw e;
  }
  const s = smtpStatus();
  const jsonOnly = process.env.SMTP_JSON_TRANSPORT === '1';
  if (!s.available && !jsonOnly) {
    const e = new Error('Aucun service SMTP n\'est configuré : le message n\'a pas pu être envoyé.');
    e.noSmtp = true;
    throw e;
  }
  const transport = options.transport || createTransport();
  const buffer = await pdf.toPdf(receipt, 'une');
  const info = await transport.sendMail({
    from: s.from || process.env.SMTP_FROM,
    to: address,
    subject: share.subject(receipt),
    text: share.emailBody(receipt),
    attachments: [{
      filename: pdf.filenameFor(receipt),
      content: buffer,
      contentType: 'application/pdf',
    }],
  });
  if (info.rejected && info.rejected.length) {
    const e = new Error(`Serveur SMTP : destinataire refusé (${info.rejected.join(', ')}).`);
    e.smtpRejected = true;
    throw e;
  }
  return {
    messageId: info.messageId || '',
    recipient: address,
    attachmentBytes: buffer.length,
    transport: jsonOnly ? 'transport JSON de test (aucune remise réelle)' : 'SMTP',
  };
}

module.exports = { smtpStatus, createTransport, sendReceipt };
