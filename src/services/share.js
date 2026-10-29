'use strict';

const settings = require('./settings');
const { MOIS, elided } = require('../utils/format');

/**
 * Préparation et remise des documents aux locataires.
 *
 * Canal WhatsApp : par défaut, l'application ouvre un **brouillon** wa.me —
 * elle n'envoie rien et ne joint pas le PDF elle-même. Une automatisation reste
 * possible via l'API officielle WhatsApp Business (variables d'environnement),
 * traitée ci-dessous comme un fournisseur distinct, explicite et optionnel.
 * Canal e-mail : brouillon mailto sans SMTP, envoi réel avec pièce jointe
 * lorsque Nodemailer est configuré (voir services/mailer.js).
 */

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

/** Numéro local, international ou saisi avec « + »/« 00 » -> format wa.me. */
function internationalNumber(raw, countryCode) {
  const code = digits(countryCode === undefined ? settings.get('whatsapp_country_code') : countryCode);
  let number = digits(raw);
  if (!number) return null;
  if (number.startsWith('00')) number = number.slice(2);
  if (code && number.startsWith(code)) {
    return number.length >= code.length + 6 ? number : null;
  }
  number = number.replace(/^0+/, '');
  if (number.length < 6) return null;
  return code ? code + number : number;
}

function isValidEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function docKind(r) {
  if (r.is_avis) return 'avis de loyer';
  return r.is_full ? 'quittance de loyer' : 'reçu de paiement partiel';
}

function capitalised(value) {
  const s = String(value || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function periodLabel(r) {
  return capitalised(r.period_label);
}

/** Nom court du document pour la ligne « Numéro de … ». */
function shortKind(r) {
  if (r.is_avis) return 'avis';
  return r.is_full ? 'quittance' : 'reçu';
}

/** « Quittance de loyer — Octobre 2026 — Awa Ndiaye » */
function subject(r) {
  return `${capitalised(docKind(r))} — ${periodLabel(r)} — ${r.snap.tenant_name}`;
}

/** Corps court pour WhatsApp, conforme au modèle attendu par les locataires. */
function whatsappText(r) {
  const kind = docKind(r);
  const amount = r.is_avis ? r.balance_fr : r.is_full ? r.total_paid_fr : r.amount_this_fr;
  const lines = [`Bonjour ${r.snap.tenant_name}, veuillez trouver votre ${kind}`
    + ` pour le mois ${elided(r.period_label)}, d'un montant de ${amount}.`];
  if (r.is_avis) {
    lines.push(`Solde à régler : ${r.balance_fr}. `
      + `Ce document est un avis de suivi, il ne vaut pas quittance.`);
  } else if (!r.is_full) {
    lines.push(`Solde restant à régler : ${r.balance_fr}.`);
  }
  lines.push(`Numéro de ${shortKind(r)} : ${r.number}. Merci.`);
  return lines.join(' ');
}

/** Corps long pour l'e-mail (le PDF est joint au message). */
function emailBody(r) {
  const kind = docKind(r);
  const amount = r.is_avis ? r.balance_fr : r.is_full ? r.total_paid_fr : r.amount_this_fr;
  const amountLabel = r.is_avis ? 'Solde à régler' : 'Montant payé';
  const lines = [
    `Bonjour ${r.snap.tenant_name},`,
    '',
    `Veuillez trouver en pièce jointe votre ${kind} pour le mois ${elided(r.period_label)}.`,
    '',
    `${amountLabel} : ${amount}.`,
    `Logement : ${r.snap.floor_label ? r.snap.floor_label + ' — ' : ''}${r.snap.unit_name}`
      + `${r.snap.unit_type_label ? ' (' + r.snap.unit_type_label + ')' : ''}.`,
    `Numéro de ${shortKind(r)} : ${r.number}.`,
  ];
  if (r.is_full) {
    lines.push(`Montant en lettres : ${r.amount_in_words}.`);
  }
  if (r.is_avis) {
    lines.push('', 'Attention : ce document est un avis de loyer. Il ne constate aucun paiement');
    lines.push('reçu et ne tient pas lieu de quittance ; la quittance sera délivrée après encaissement.');
  } else if (!r.is_full) {
    lines.push('', `Le solde de ${r.balance_fr} reste dû pour cette période ; `
      + 'ce reçu ne vaut pas quittance de loyer intégralement payé.');
  }
  const s = settings.all();
  lines.push('', `Cordialement,`, `${s.owner_name}${s.owner_phone ? ' — ' + s.owner_phone : ''}`);
  return lines.join('\n');
}

/** Retourne null quand le contact est manquant : l'interface n'affiche alors aucun lien. */
function whatsappLink(phone, r) {
  const number = internationalNumber(phone);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(whatsappText(r))}`;
}

function emailLink(email, r) {
  if (!isValidEmail(email)) return null;
  return `mailto:${String(email).trim()}?subject=${encodeURIComponent(subject(r))}`
    + `&body=${encodeURIComponent(emailBody(r))}`;
}

/* ---------- API officielle WhatsApp Business (automatisation optionnelle) ---------- */

const WABA_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

/** Configuration détectée depuis l'environnement ; jamais depuis le navigateur. */
function businessApiStatus() {
  const token = process.env.WHATSAPP_BUSINESS_TOKEN || '';
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
  if (!token || !phoneNumberId) {
    return { available: false, reason: 'Identifiants WhatsApp Business non configurés (.env).' };
  }
  return { available: true, phoneNumberId, token };
}

/**
 * Envoi réel via l'API Meta. Le PDF ne peut être joint que s'il est hébergé :
 * sans WHATSAPP_MEDIA_BASE_URL publicly accessible, seul le texte est envoyé,
 * et l'historique le mentionne explicitement.
 */
async function sendViaBusinessApi(phone, r) {
  const cfg = businessApiStatus();
  if (!cfg.available) {
    const e = new Error(cfg.reason);
    e.validation = true;
    throw e;
  }
  const to = internationalNumber(phone);
  if (!to) {
    const e = new Error('Numéro de téléphone invalide pour l\'envoi WhatsApp.');
    e.validation = true;
    throw e;
  }
  const url = `https://graph.facebook.com/${WABA_VERSION}/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      type: 'text',
      to,
      text: { preview_url: false, body: whatsappText(r) },
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`WhatsApp Business : ${payload.error && payload.error.message
      ? payload.error.message : `erreur HTTP ${res.status}`}`);
    e.whatsappFailure = true;
    throw e;
  }
  return { id: payload.messages && payload.messages[0] ? payload.messages[0].id : '', to };
}

module.exports = {
  digits, internationalNumber, isValidEmail, docKind, subject,
  whatsappText, emailBody, whatsappLink, emailLink,
  businessApiStatus, sendViaBusinessApi,
};
