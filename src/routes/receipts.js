'use strict';

const { Router } = require('../utils/router');
const db = require('../db');
const rent = require('../services/rent');
const share = require('../services/share');
const unitsSvc = require('../services/units');
const stats = require('../services/stats');
const flash = require('../services/flash');
const transmissions = require('../services/transmissions');
const mailer = require('../services/mailer');
const pdf = require('../services/pdf');

const router = Router();

const MODES = ['trio', 'copies', 'une'];

function parseIds(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[, ]+/);
  return [...new Set(list.map(s => Number(s)).filter(n => Number.isInteger(n) && n > 0))].slice(0, 60);
}

function parseMode(raw) {
  return MODES.includes(raw) ? raw : 'trio';
}

async function await loadReceipt(req, res) {
  const r = await rent.getReceipt(req.params.id);
  if (r) return r;
  res.status(404).render('error', { title: 'Introuvable', message: 'Quittance inconnue.' });
  return null;
}

async function await tenantOf(r) {
  const tenancy = await rent.getTenancy(r.tenancy_id);
  return tenancy ? await db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenancy.tenant_id) : null;
}

router.get('/', async (req, res) => {
  const f = {
    year: req.query.year || null,
    month: req.query.month || null,
    tenant_id: req.query.tenant_id || null,
    floor_id: req.query.floor_id || null,
    type: req.query.type || null,
  };
  const [history, tenants, floors] = await Promise.all([
    stats.receiptHistory(f),
    db.prepare(`SELECT t.id, t.first_name, t.last_name FROM tenants t
                WHERE t.status = 'active' ORDER BY lower(t.last_name)`).all(),
    unitsSvc.listFloors(),
  ]);
  res.render('receipts/index', {
    title: 'Quittances',
    filters: f,
    receipts: history.map(r => rent.decorateReceipt(r)),
    pdfAvailable: pdf.status().available,
    smtpAvailable: mailer.smtpStatus().available,
    tenants,
    floors,
  });
});

router.get('/nouvelle', async (req, res) => {
  const tenants = await db.prepare(`SELECT t.id, t.first_name, t.last_name, te.id AS tenancy_id,
                              u.name AS unit_name, f.label AS floor_label
                              FROM tenants t
                              JOIN tenancies te ON te.tenant_id = t.id AND te.end_date IS NULL
                              JOIN units u ON u.id = te.unit_id
                              JOIN floors f ON f.id = u.floor_id
                              WHERE t.status = 'active'
                              ORDER BY lower(t.last_name), lower(t.first_name)`).all();
  res.render('receipts/new', { title: 'Générer une quittance', tenants, methods: rent.METHOD_LABELS });
});

router.get('/:id', async (req, res) => {
  const r = await await loadReceipt(req, res);
  if (!r) return undefined;
  const tenancy = await rent.getTenancy(r.tenancy_id);
  const tenant = tenancy ? await db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenancy.tenant_id) : null;
  const [summary, payments, hasFull, allSiblings] = await Promise.all([
    rent.periodSummary(r.tenancy_id, r.period_year, r.period_month),
    db.prepare(`SELECT * FROM payments WHERE tenancy_id = ? AND period_year = ? AND period_month = ?
                ORDER BY paid_at, id`).all(r.tenancy_id, r.period_year, r.period_month),
    rent.fullReceiptExists(r.tenancy_id, r.period_year, r.period_month),
    db.prepare(`SELECT * FROM receipts WHERE tenancy_id = ? AND period_year = ? AND period_month = ?
                AND cancelled = FALSE ORDER BY id`).all(r.tenancy_id, r.period_year, r.period_month),
  ]);
  const back = req.session.monthPeriod
    ? `/quittances/mois?year=${req.session.monthPeriod.year}&month=${req.session.monthPeriod.month}`
    : '/quittances';
  res.render('receipts/show', {
    title: `${r.type_label} ${r.number}`,
    r, tenancy, summary, back,
    tenant,
    draft: {
      whatsapp: share.whatsappLink(tenant ? tenant.phone : '', r),
      email: share.emailLink(tenant ? tenant.email : '', r),
    },
    number: tenant ? share.internationalNumber(tenant.phone) : null,
    smtp: mailer.smtpStatus(),
    pdfEngine: pdf.status(),
    business: share.businessApiStatus(),
    transmissions: await transmissions.listFor(r.id),
    payments: payments.map(p => ({ ...p, paid_at_fr: require('../utils/format').formatDateFr(p.paid_at) })),
    siblings: hasFull ? allSiblings.map(x => rent.decorateReceipt(x)) : [],
  });
});

// Quittance définitive récapitulative après paiements partiels successifs
router.post('/:id/definitive', async (req, res) => {
  const base = await rent.getReceiptRaw(req.params.id);
  if (!base) return res.status(404).render('error', { title: 'Introuvable', message: 'Quittance inconnue.' });
  try {
    const r = await rent.issueFinalReceipt(base.tenancy_id, base.period_year, base.period_month,
      { observations: req.body.observations || '' });
    flash(req, `Quittance définitive émise : ${r.number}`);
    res.redirect(`/quittances/${r.id}`);
  } catch (e) {
    flash(req, null, e.message);
    res.redirect(`/quittances/${base.id}`);
  }
});

/**
 * WhatsApp : ouvre un brouillon avec le numéro (temporairement modifiable) et le
 * message personnalisés. L'ouverture du lien ne vaut pas envoi : l'action est
 * enregistrée comme « préparée », et le PDF doit être joint à la main.
 * `auto=1` utilise l'API officielle WhatsApp Business, si elle est configurée.
 */
router.post('/:id/whatsapp', async (req, res) => {
  const r = await loadReceipt(req, res);
  if (!r) return undefined;
  const tenant = await tenantOf(r);
  const phone = req.body.phone === undefined ? (tenant ? tenant.phone : '') : req.body.phone;
  const number = share.internationalNumber(phone);

  if (!number) {
    await transmissions.record({
      receipt_id: r.id, channel: 'whatsapp', status: 'failed', recipient: String(phone || '').trim(),
      detail: `Numéro inutilisable : « ${phone || 'vide'} ». Aucun message n'a été ouvert.`,
    });
    flash(req, null, 'Ce numéro de téléphone n\'est pas exploitable : corrigez-le sur la fiche du locataire '
      + 'ou dans le champ ci-dessus. Les autres actions restent disponibles.');
    return res.redirect(`/quittances/${r.id}`);
  }

  if (req.body.auto === '1') {
    try {
      const sent = await share.sendViaBusinessApi(phone, r);
      await transmissions.record({
        receipt_id: r.id, channel: 'whatsapp', status: 'sent', recipient: number,
        detail: `API WhatsApp Business · message ${sent.id || 'sans identifiant'} ; `
          + 'le PDF n\'est pas joint automatiquement.',
      });
      flash(req, `Message WhatsApp transmis à ${number} par l'API Business. Le PDF doit être envoyé séparément.`);
    } catch (e) {
      await transmissions.record({
        receipt_id: r.id, channel: 'whatsapp', status: 'failed', recipient: number, detail: e.message,
      });
      flash(req, null, `Échec de l'envoi WhatsApp : ${e.message}`);
    }
    return res.redirect(`/quittances/${r.id}`);
  }

  await transmissions.record({
    receipt_id: r.id, channel: 'whatsapp', status: 'prepared', recipient: number,
    detail: 'Brouillon WhatsApp ouvert : joignez le PDF et confirmez l\'envoi dans WhatsApp.',
  });
  // Le formulaire cible un nouvel onglet : WhatsApp s'ouvre, l'application reste affichée.
  return res.redirect(share.whatsappLink(phone, r));
});

/** Confirmation explicite : seul l'utilisateur peut attester l'envoi. */
router.post('/:id/whatsapp/confirme', async (req, res) => {
  const r = await loadReceipt(req, res);
  if (!r) return undefined;
  const tenant = await tenantOf(r);
  const number = share.internationalNumber(req.body.phone || (tenant ? tenant.phone : '')) || '';
  await transmissions.record({
    receipt_id: r.id, channel: 'whatsapp', status: 'sent', recipient: number,
    detail: 'Envoi confirmé manuellement par le propriétaire (WhatsApp ne renvoie aucun accusé).',
  });
  flash(req, 'Envoi WhatsApp marqué comme confirmé dans l\'historique des transmissions.');
  res.redirect(`/quittances/${r.id}`);
});

/**
 * E-mail : envoi réel avec pièce jointe si SMTP est configuré, sinon brouillon
 * du logiciel de messagerie — sans jamais annoncer un envoi fictif.
 */
router.post('/:id/email', async (req, res) => {
  const r = await loadReceipt(req, res);
  if (!r) return undefined;
  const tenant = await tenantOf(r);
  const to = String(req.body.to ?? (tenant ? tenant.email : '') ?? '').trim();

  if (!share.isValidEmail(to)) {
    await transmissions.record({
      receipt_id: r.id, channel: 'email', status: 'failed', recipient: to,
      detail: `Adresse e-mail absente ou invalide : « ${to || 'vide'} ».`,
    });
    flash(req, null, 'Adresse e-mail absente ou invalide : renseignez-la sur la fiche du locataire, '
      + 'ou utilisez WhatsApp et l\'impression.');
    return res.redirect(`/quittances/${r.id}`);
  }

  const smtp = mailer.smtpStatus();
  const jsonTransport = process.env.SMTP_JSON_TRANSPORT === '1';
  if (!smtp.available && !jsonTransport) {
    await transmissions.record({
      receipt_id: r.id, channel: 'email', status: 'prepared', recipient: to,
      detail: 'Aucun service SMTP configuré : brouillon ouvert dans le logiciel de messagerie, '
        + 'le PDF doit être joint à la main.',
    });
    flash(req, 'Aucun service SMTP n\'est configuré : rien n\'a été envoyé depuis l\'application. '
      + 'Le logiciel de messagerie s\'ouvre avec un message prérempli — joignez le PDF téléchargé. '
      + 'Vous pouvez aussi télécharger le PDF et l\'envoyer vous-même.');
    return res.redirect(share.emailLink(to, r));
  }

  try {
    const sent = await mailer.sendReceipt(r, to);
    const delivered = sent.transport === 'SMTP';
    await transmissions.record({
      receipt_id: r.id, channel: 'email', status: delivered ? 'sent' : 'prepared', recipient: sent.recipient,
      detail: delivered
        ? `Serveur SMTP confirmé (${sent.transport}) · message ${sent.messageId || 'sans identifiant'}`
          + ` · PDF joint de ${Math.round(sent.attachmentBytes / 1024)} Ko.`
        : `${sent.transport} · message ${sent.messageId || 'sans identifiant'} construit avec le PDF joint`
          + ` de ${Math.round(sent.attachmentBytes / 1024)} Ko, mais SMTP non configuré : aucune remise réelle.`,
    });
    flash(req, delivered
      ? `E-mail envoyé à ${sent.recipient} avec le PDF en pièce jointe (message ${sent.messageId}).`
      : `Message construit pour ${sent.recipient} avec son PDF (${Math.round(sent.attachmentBytes / 1024)} Ko) `
        + 'mais seul un transport de test est actif : rien n\'a été remis. Configurez SMTP pour l\'envoi réel.');
  } catch (e) {
    await transmissions.record({
      receipt_id: r.id, channel: 'email', status: 'failed', recipient: to, detail: e.message,
    });
    flash(req, null, `L'e-mail n'a pas été envoyé : ${e.message}`);
  }
  return res.redirect(`/quittances/${r.id}`);
});

/** Téléchargement du PDF officiel du document (POST : l'action est tracée). */
router.post('/:id/pdf', async (req, res) => {
  const r = await loadReceipt(req, res);
  if (!r) return undefined;
  const mode = parseMode(req.body.mode) === 'copies' ? 'une' : parseMode(req.body.mode);
  try {
    const buffer = await pdf.toPdf(r, mode);
    await transmissions.record({
      receipt_id: r.id, channel: 'pdf', status: 'prepared', recipient: '',
      detail: `PDF téléchargé (${Math.round(buffer.length / 1024)} Ko, ${pdf.sheetsLabel(mode, 1)}).`,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="${pdf.filenameFor(r)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).end(buffer);
  } catch (e) {
    await transmissions.record({
      receipt_id: r.id, channel: 'pdf', status: 'failed', recipient: '', detail: e.message,
    });
    flash(req, null, `${e.message} Utilisez « Imprimer » puis « Enregistrer au format PDF » : `
      + 'le rendu reste identique.');
    return res.redirect(`/impression/apercu?ids=${r.id}&mode=${mode}&pdf=1`);
  }
});

module.exports = router;
