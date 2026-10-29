'use strict';

/* Section 18 — envoi et partage des quittances (WhatsApp, e-mail, impression, PDF).
   Ce fichier vérifie que le document transmis est bien le modèle officiel, qu'aucun
   envoi n'est simulé, et que chaque action est enregistrée avec le statut réellement
   observable. Tous les locataires utilisés ici sont des exemples fictifs, créés dans
   une base PostgreSQL de test propre à ce fichier et supprimée à la fin. */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const nodemailer = require('nodemailer');
const { loadApp, seedTenant } = require('./helpers');

const { db, config, services } = loadApp();
const { rent, share, format } = services;
const pdf = require('../src/services/pdf');
const mailer = require('../src/services/mailer');
const transmissions = require('../src/services/transmissions');

const Y = 2026, M = 10;
const hasPdfEngine = Boolean(pdf.status().available);

const rowsFor = async (receiptId) =>
  db.prepare('SELECT * FROM receipt_transmissions WHERE receipt_id = ? ORDER BY id').all(receiptId);
const lastRow = async (receiptId) => (await rowsFor(receiptId)).at(-1) || {};

/** Locataire fictif dont le loyer d'octobre 2026 est intégralement encaissé. */
async function paidReceipt(unit, phone, email) {
  const seeded = await seedTenant(services, {
    name: unit, rent: 40000, first_name: 'Awa', last_name: 'Ndiaye', phone, email,
  });
  await rent.recordPayment({
    tenancy_id: seeded.tenancy.id, amount: 40000, paid_at: '2026-10-05',
    period_year: Y, period_month: M,
  }, { generate: 'none' });
  const doc = await rent.generateOne(seeded.tenancy.id, Y, M);
  return { ...doc, receipt: await rent.getReceipt(doc.receipt.id), tenant: seeded.tenant };
}

/* ---------- 1. PDF : le modèle officiel, accents compris ---------- */

test('le moteur PDF de la machine est détecté et annoncé', (t) => {
  const st = pdf.status();
  if (!st.available) return t.skip('Chromium/Chrome absent : PDF_ENGINE=none');
  assert.match(st.version, /Chrome|Chromium/i);
  assert.ok(st.engine);
});

test('le PDF reprend le modèle officiel, accents et montant en lettres inclus', async (t) => {
  if (!hasPdfEngine) return t.skip('moteur PDF indisponible');
  const { receipt } = await paidReceipt('PDF1', '771234567', 'awa@exemple.sn');

  const html = await pdf.sheetsHtml([receipt], 'une');
  assert.match(html, /QUITTANCE DE LOYER/);
  assert.ok(html.includes(receipt.number));
  assert.ok(html.includes(format.formatFcfa(40000)), 'le montant en chiffres apparaît');
  assert.ok(html.includes('Quarante mille francs CFA'), 'le montant en lettres apparaît');
  assert.match(html, /Étage/, 'les accents français sont conservés');
  assert.match(html, /Signature du propriétaire/);
  assert.ok(!/sig-img|signature-\d+/i.test(html),
    'aucune signature importée n\'apparaît tant qu\'aucun fichier n\'a été fourni');
  assert.match(html, /href="file:\/\/\/.*css\/print\.css"/, 'les ressources sont localisées pour le moteur');
  assert.ok(!html.includes('"/static/'), 'le document autonome ne garde aucune URL relative');

  const buffer = await pdf.toPdf([receipt], 'une');
  assert.strictEqual(buffer.subarray(0, 5).toString(), '%PDF-');
  assert.match(buffer.subarray(-32).toString('latin1'), /%%EOF/);
  assert.ok(buffer.length > 4000, `un PDF réel est produit (${buffer.length} octets)`);
  assert.match(pdf.filenameFor(receipt), /^quittance-QL-\d+-\d+-octobre-2026\.pdf$/, 'nom de fichier ASCII');
});

test('1, 2 puis 3 quittances distinctes : une seule feuille A4, et une page par document en mode « une »',
  async (t) => {
    if (!hasPdfEngine) return t.skip('moteur PDF indisponible');
    const docs = [];
    for (const u of ['PDF2', 'PDF3', 'PDF4']) docs.push((await paidReceipt(u, '771234567', 'x@exemple.sn')).receipt);
    const sheets = (html) => (html.match(/<section class="a4-sheet/g) || []).length;
    const blocks = (html) => (html.match(/class="rent-receipt/g) || []).length;

    assert.strictEqual(sheets(await pdf.sheetsHtml(docs.slice(0, 1), 'trio')), 1);
    assert.strictEqual(blocks(await pdf.sheetsHtml(docs.slice(0, 1), 'trio')), 3,
      'les emplacements inutilisés restent sur la feuille');
    assert.strictEqual(blocks(await pdf.sheetsHtml(docs.slice(0, 2), 'trio')), 3);
    assert.strictEqual(sheets(await pdf.sheetsHtml(docs.slice(0, 3), 'trio')), 1, '3 documents = 1 feuille');
    assert.strictEqual(sheets(await pdf.sheetsHtml(docs, 'une')), 3, 'mode « une » : une page par document');
    assert.strictEqual(sheets(await pdf.sheetsHtml([docs[0]], 'copies')), 1);
    assert.strictEqual(blocks(await pdf.sheetsHtml([docs[0]], 'copies')), 3, '3 exemplaires du même document');
  });

/* ---------- 2. WhatsApp : normalisation + brouillon prérempli ---------- */

test('les numéros sénégalais sont normalisés au format international', () => {
  const cases = [
    ['771234567', '221771234567'],
    ['+221 77 123 45 67', '221771234567'],
    ['00221771234567', '221771234567'],
    ['77 12 34 56 78', '2217712345678'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(share.internationalNumber(input), expected, input);
  }
  for (const bad of ['', '12345', '22177', 'abc', null]) {
    assert.strictEqual(share.internationalNumber(bad), null, `« ${bad} » n'est pas un numéro exploitable`);
  }
});

test('le lien WhatsApp est prérempli avec le message exact, correctement encodé', async () => {
  const { receipt } = await paidReceipt('WA1', '77 123 45 67', 'awa1@exemple.sn');
  const url = new URL(share.whatsappLink('771234567', receipt));
  assert.strictEqual(url.origin + url.pathname, 'https://wa.me/221771234567');
  const text = decodeURIComponent(url.searchParams.get('text'));
  assert.strictEqual(text,
    `Bonjour Awa Ndiaye, veuillez trouver votre quittance de loyer pour le mois d'octobre 2026, `
    + `d'un montant de ${format.formatFcfa(40000)}. `
    + `Numéro de quittance : ${receipt.number}. Merci.`);
  assert.match(share.whatsappLink('771234567', receipt), /%20/, 'les espaces sont encodés');
  assert.strictEqual(share.whatsappLink('', receipt), null, 'aucun lien sans numéro');
  assert.strictEqual(share.whatsappLink('12345', receipt), null, 'aucun lien avec un numéro invalide');

  const avisTenant = await seedTenant(services, { name: 'WA0', rent: 30000, first_name: 'Awa', last_name: 'Ndiaye' });
  const avis = await rent.issueAvisLoyer(avisTenant.tenancy.id, Y, M);
  const avisText = decodeURIComponent(new URL(share.whatsappLink('771234567', avis))
    .searchParams.get('text'));
  assert.match(avisText, /avis de loyer/, 'un document de suivi n\'est jamais présenté comme une quittance');
  assert.match(avisText, /ne vaut pas quittance/);
  assert.match(avisText, /Solde à régler/);
  assert.ok(!avisText.includes('Montant payé'), 'un avis n\'annonce aucun paiement encaissé');
});

/* ---------- 3. Service d'enregistrement des transmissions ---------- */

test('l\'enregistrement des transmissions refuse un canal ou un statut inconnu', async () => {
  const { receipt } = await paidReceipt('TR1', '771234567', 't1@exemple.sn');
  await assert.rejects(() => transmissions.record({ receipt_id: receipt.id, channel: 'sms', status: 'sent' }));
  await assert.rejects(() => transmissions.record({ receipt_id: receipt.id, channel: 'email', status: 'ok' }));
  await assert.rejects(() => transmissions.record({ receipt_id: 999999, channel: 'email', status: 'sent' }));
  const row = await transmissions.record({ receipt_id: receipt.id, channel: 'email', status: 'prepared',
    recipient: 't1@exemple.sn', detail: 'brouillon' });
  assert.strictEqual(row.channel, 'email');
  assert.deepStrictEqual((await transmissions.listFor(receipt.id)).map(x => x.status), ['prepared']);
});

/* ---------- 4. Parcours HTTP réels ---------- */

let server, base, cookie = '';
const savedEnv = {};

async function startServer() {
  if (base) return;
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function send(url, opts = {}) {
  const headers = { Cookie: cookie, ...(opts.headers || {}) };
  let body;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await fetch(base + url, { method: opts.method || 'GET', headers, body, redirect: 'manual' });
  const set = res.headers.getSetCookie();
  if (set.length) cookie = set.map(c => c.split(';')[0]).join('; ');
  return {
    status: res.status,
    location: res.headers.get('location'),
    headers: res.headers,
    body: opts.raw ? Buffer.from(await res.arrayBuffer()) : await res.text(),
  };
}

const tokenOf = (html) => {
  const m = /name="_csrf" value="([0-9a-f]+)"/.exec(html);
  assert.ok(m, 'un formulaire avec jeton CSRF est attendu');
  return m[1];
};

const csrf = async () => tokenOf((await send('/quittances')).body);

/**
 * Remplace fetch uniquement pour les appels à l'API Meta : le harnais HTTP local
 * continue de passer par le vrai fetch.
 */
function stubMetaApi(responder) {
  const real = global.fetch;
  global.fetch = (url, options) =>
    String(url).includes('graph.facebook.com')
      ? Promise.resolve(responder(url, options))
      : real(url, options);
  return () => { global.fetch = real; };
}

let logged = false;
async function login() {
  await startServer();
  if (logged) return;
  const page = await send('/login');
  const res = await send('/login', { method: 'POST', form: {
    _csrf: tokenOf(page.body), username: config.admin.username, password: 'test-motdepasse' } });
  assert.strictEqual(res.status, 302, 'la connexion doit réussir');
  logged = true;
}

function useEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

const SMTP_ENV = {
  SMTP_HOST: 'smtp.exemple.sn', SMTP_PORT: '587', SMTP_SECURE: 'false',
  SMTP_USER: 'proprietaire@exemple.sn', SMTP_PASS: 'mot-de-passe-secret',
  SMTP_FROM: 'proprietaire@exemple.sn', SMTP_JSON_TRANSPORT: undefined,
};
const NO_SMTP_ENV = {
  SMTP_HOST: undefined, SMTP_USER: undefined, SMTP_PASS: undefined,
  SMTP_FROM: undefined, SMTP_JSON_TRANSPORT: undefined,
};

test('e-mail : envoi réel avec pièce jointe PDF quand SMTP est configuré', async (t) => {
  if (!hasPdfEngine) return t.skip('moteur PDF indisponible : pas de pièce jointe possible');
  useEnv(SMTP_ENV);
  await login();
  const { receipt } = await paidReceipt('MAIL1', '771234567', 'awa.mail1@exemple.sn');

  const captured = [];
  const realCreate = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async (mail) => { captured.push(mail); return { messageId: '<msg-1@exemple.sn>', accepted: [mail.to] }; },
  });
  let mail;
  try {
    mail = await send(`/quittances/${receipt.id}/email`, {
      method: 'POST', form: { _csrf: await csrf() } });
  } finally {
    nodemailer.createTransport = realCreate;
  }
  assert.strictEqual(mail.status, 302);
  assert.strictEqual(mail.location, `/quittances/${receipt.id}`);

  assert.strictEqual(captured.length, 1, 'un seul message remis au serveur');
  const m = captured[0];
  assert.strictEqual(m.to, 'awa.mail1@exemple.sn', 'le destinataire est celui réellement enregistré');
  assert.strictEqual(m.from, 'proprietaire@exemple.sn');
  assert.strictEqual(m.subject, 'Quittance de loyer — Octobre 2026 — Awa Ndiaye');
  assert.match(m.text, /Bonjour Awa Ndiaye,/);
  assert.ok(m.text.includes(`Montant payé : ${format.formatFcfa(40000)}`), m.text);
  assert.ok(m.text.includes(`Numéro de quittance : ${receipt.number}`), m.text);
  assert.ok(m.text.includes(`Logement : Premier étage — MAIL1`), m.text);
  assert.match(m.text, /Cordialement,\nBamby Sidibé/);
  assert.strictEqual(m.attachments.length, 1, 'le PDF est joint automatiquement');
  assert.strictEqual(m.attachments[0].contentType, 'application/pdf');
  assert.match(m.attachments[0].filename, /^quittance-QL-/);
  assert.strictEqual(m.attachments[0].content.subarray(0, 5).toString(), '%PDF-');

  const row = await lastRow(receipt.id);
  assert.strictEqual(row.channel, 'email');
  assert.strictEqual(row.status, 'sent', 'le succès n\'est enregistré que sur confirmation du serveur');
  assert.strictEqual(row.recipient, 'awa.mail1@exemple.sn');
  assert.match(row.detail, /msg-1@exemple\.sn/);
  assert.match(row.detail, /PDF joint de \d+ Ko/);

  const page = await send(`/quittances/${receipt.id}`);
  assert.match(page.body, /E-mail envoy/);
  assert.ok(!page.body.includes('mot-de-passe-secret'), 'le mot de passe SMTP n\'est jamais exposé');
  assert.ok(!page.body.includes('SMTP_PASS'), 'les variables sensibles ne fuient pas dans la page');
});

test('e-mail : adresse absente ou invalide → échec enregistré, autres actions conservées', async () => {
  useEnv(SMTP_ENV);
  await login();
  const { receipt } = await paidReceipt('MAIL2', '771234567', '');

  const bad = await send(`/quittances/${receipt.id}/email`, {
    method: 'POST', form: { _csrf: await csrf(), to: 'pas-une-adresse' } });
  assert.strictEqual(bad.location, `/quittances/${receipt.id}`);

  const row = await lastRow(receipt.id);
  assert.strictEqual(row.channel, 'email');
  assert.strictEqual(row.status, 'failed');
  assert.match(row.detail, /invalide/);

  const page = await send(bad.location);
  assert.match(page.body, /Adresse e-mail absente ou invalide/);
  assert.match(page.body, /Envoyer par WhatsApp/);
  assert.match(page.body, /Imprimer la quittance/, 'les autres canaux restent utilisables');

  useEnv(NO_SMTP_ENV);
});

test('e-mail : sans SMTP, un brouillon est ouvert et rien n\'est annoncé comme envoyé', async () => {
  useEnv(NO_SMTP_ENV);
  await login();
  const { receipt } = await paidReceipt('MAIL3', '771234567', 'awa.mail3@exemple.sn');

  const mail = await send(`/quittances/${receipt.id}/email`, {
    method: 'POST', form: { _csrf: await csrf() } });
  assert.match(mail.location, /^mailto:awa\.mail3@exemple\.sn\?subject=/);
  assert.strictEqual(decodeURIComponent(/subject=([^&]*)/.exec(mail.location)[1]),
    'Quittance de loyer — Octobre 2026 — Awa Ndiaye');

  const row = await lastRow(receipt.id);
  assert.strictEqual(row.status, 'prepared', 'aucun envoi ne peut être déclaré');
  assert.match(row.detail, /Aucun service SMTP/);

  const page = await send(`/quittances/${receipt.id}`);
  assert.match(page.body, /Préparer l&#39;e-mail/);
  assert.match(page.body, /SMTP/);
});

test('e-mail : une panne du serveur SMTP est enregistrée comme échec', async (t) => {
  if (!hasPdfEngine) return t.skip('moteur PDF indisponible');
  useEnv(SMTP_ENV);
  await login();
  const { receipt } = await paidReceipt('MAIL4', '771234567', 'awa.mail4@exemple.sn');

  const realCreate = nodemailer.createTransport;
  nodemailer.createTransport = () => ({
    sendMail: async () => { throw new Error('Erreur du serveur SMTP: connection to smtp.exemple.sn:587 failed'); },
  });
  let mail;
  try {
    mail = await send(`/quittances/${receipt.id}/email`, {
      method: 'POST', form: { _csrf: await csrf() } });
  } finally {
    nodemailer.createTransport = realCreate;
  }
  assert.strictEqual(mail.location, `/quittances/${receipt.id}`);

  const row = await lastRow(receipt.id);
  assert.strictEqual(row.status, 'failed');
  assert.match(row.detail, /connection to smtp\.exemple\.sn:587 failed/);
  const page = await send(mail.location);
  assert.match(page.body, /pas été envoyé/);

  useEnv(NO_SMTP_ENV);
});

/* ---------- 5. WhatsApp via HTTP : préparé puis confirmé ---------- */

test('WhatsApp : ouvrir le brouillon s\'enregistre « préparé », jamais « envoyé »', async () => {
  useEnv({ WHATSAPP_BUSINESS_TOKEN: undefined, WHATSAPP_PHONE_NUMBER_ID: undefined });
  await login();
  const { receipt } = await paidReceipt('WA2', '771234567', 'awa.wa2@exemple.sn');

  const open = await send(`/quittances/${receipt.id}/whatsapp`, {
    method: 'POST', form: { _csrf: await csrf() } });
  assert.strictEqual(open.status, 302);
  assert.match(open.location, /^https:\/\/wa\.me\/221771234567\?text=/);

  let row = await lastRow(receipt.id);
  assert.strictEqual(row.channel, 'whatsapp');
  assert.strictEqual(row.status, 'prepared', 'ouvrir WhatsApp ne vaut pas envoi');
  assert.strictEqual(row.recipient, '221771234567');
  assert.match(row.detail, /joignez le PDF/);

  const page = await send(`/quittances/${receipt.id}`);
  const confirm = await send(`/quittances/${receipt.id}/whatsapp/confirme`, {
    method: 'POST', form: { _csrf: tokenOf(page.body) } });
  assert.strictEqual(confirm.status, 302);

  row = await lastRow(receipt.id);
  assert.strictEqual(row.status, 'sent');
  assert.match(row.detail, /confirm. manuellement/);
  assert.strictEqual((await rowsFor(receipt.id)).filter(x => x.channel === 'whatsapp').length, 2,
    'le brouillon et la confirmation sont deux entrées distinctes');
});

test('WhatsApp : le numéro peut être corrigé avant l\'envoi, sinon échec sans bloquer les autres actions',
  async () => {
    await login();
    const { receipt } = await paidReceipt('WA3', '', 'awa.wa3@exemple.sn');

    const doc = await send(`/quittances/${receipt.id}`);
    assert.match(doc.body, /Aucun numéro exploitable/, 'la saisie du numéro est proposée');

    const fixed = await send(`/quittances/${receipt.id}/whatsapp`, {
      method: 'POST', form: { _csrf: tokenOf(doc.body), phone: '+221 78 555 11 22' } });
    assert.match(fixed.location, /^https:\/\/wa\.me\/221785551122\?text=/);
    assert.strictEqual((await lastRow(receipt.id)).recipient, '221785551122');

    const broken = await send(`/quittances/${receipt.id}/whatsapp`, {
      method: 'POST', form: { _csrf: await csrf(), phone: '12' } });
    assert.strictEqual(broken.location, `/quittances/${receipt.id}`);
    const row = await lastRow(receipt.id);
    assert.strictEqual(row.status, 'failed');
    assert.match(row.detail, /Numéro inutilisable/);

    const page = await send(broken.location);
    assert.match(page.body, /pas exploitable/);
    assert.match(page.body, /Les autres actions restent disponibles/);
    assert.match(page.body, /Imprimer la quittance/);
  });

test('WhatsApp Business : l\'automatisation n\'existe que si les identifiants sont configurés', async () => {
  useEnv({ WHATSAPP_BUSINESS_TOKEN: undefined, WHATSAPP_PHONE_NUMBER_ID: undefined });
  assert.strictEqual(share.businessApiStatus().available, false);
  assert.match(share.businessApiStatus().reason, /non configur/);

  useEnv({ WHATSAPP_BUSINESS_TOKEN: 'jeton-de-test', WHATSAPP_PHONE_NUMBER_ID: '123456789' });
  const st = share.businessApiStatus();
  assert.strictEqual(st.available, true);
  assert.strictEqual(st.phoneNumberId, '123456789');

  await login();
  const { receipt } = await paidReceipt('WA4', '771234567', 'awa.wa4@exemple.sn');
  const calls = [];
  const restore = stubMetaApi((url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.TEST' }] }) };
  });
  let auto;
  try {
    auto = await send(`/quittances/${receipt.id}/whatsapp`, {
      method: 'POST', form: { _csrf: await csrf(), auto: '1' } });
  } finally {
    restore();
    useEnv({ WHATSAPP_BUSINESS_TOKEN: undefined, WHATSAPP_PHONE_NUMBER_ID: undefined });
  }

  assert.strictEqual(auto.location, `/quittances/${receipt.id}`);
  assert.strictEqual(calls.length, 1, 'un seul appel à l\'API officielle');
  assert.match(calls[0].url, /graph\.facebook\.com\/v\d+\.\d+\/123456789\/messages$/);
  assert.match(calls[0].options.headers.Authorization, /^Bearer jeton-de-test$/);
  const payload = JSON.parse(calls[0].options.body);
  assert.strictEqual(payload.to, '221771234567');
  assert.strictEqual(payload.messaging_product, 'whatsapp');
  assert.match(payload.text.body, /Numéro de quittance/);

  const row = await lastRow(receipt.id);
  assert.strictEqual(row.status, 'sent', 'l\'API a renvoyé un accusé de prise en charge');
  assert.match(row.detail.replace(/&#39;/g, "'"), /PDF n'est pas joint/);
});

test('WhatsApp Business : un refus de l\'API est enregistré comme échec', async () => {
  useEnv({ WHATSAPP_BUSINESS_TOKEN: 'jeton', WHATSAPP_PHONE_NUMBER_ID: '123456789' });
  await login();
  const { receipt } = await paidReceipt('WA5', '771234567', 'awa.wa5@exemple.sn');
  const restore = stubMetaApi(() => ({
    ok: false, status: 400, json: async () => ({ error: { message: 'numéro non autorisé (erreur 131026)' } }),
  }));
  let fail;
  try {
    fail = await send(`/quittances/${receipt.id}/whatsapp`, {
      method: 'POST', form: { _csrf: await csrf(), auto: '1' } });
  } finally {
    restore();
    useEnv({ WHATSAPP_BUSINESS_TOKEN: undefined, WHATSAPP_PHONE_NUMBER_ID: undefined });
  }
  assert.strictEqual(fail.location, `/quittances/${receipt.id}`);
  const row = await lastRow(receipt.id);
  assert.strictEqual(row.status, 'failed');
  assert.match(row.detail, /num.ro non autoris/);
  assert.match((await send(`/quittances/${receipt.id}`)).body, /chec de l.{0,10}envoi WhatsApp/);
});

/* ---------- 6. Impression : demande puis confirmation physique ---------- */

test('impression : la demande est « préparée », le papier ne peut être confirmé que par l\'utilisateur',
  async () => {
    await login();
    const a = await paidReceipt('PRN1', '771234567', 'p1@exemple.sn');
    const b = await paidReceipt('PRN2', '771234567', 'p2@exemple.sn');

    const ask = await send('/impression/demander', { method: 'POST', form: {
      _csrf: await csrf(), ids: [a.receipt.id, b.receipt.id].join(','), mode: 'trio' } });
    assert.strictEqual(ask.status, 302);
    assert.match(ask.location, new RegExp(
      `^/impression/apercu\\?ids=${a.receipt.id},${b.receipt.id}&mode=trio&print=1$`));

    assert.strictEqual((await lastRow(a.receipt.id)).channel, 'print');
    assert.strictEqual((await lastRow(a.receipt.id)).status, 'prepared');
    assert.strictEqual((await lastRow(b.receipt.id)).status, 'prepared', 'les deux documents du lot sont journalisés');
    assert.match((await lastRow(a.receipt.id)).detail, /Demande d.impression/);

    const apercu = await send(ask.location);
    assert.strictEqual(apercu.status, 200);
    assert.strictEqual((apercu.body.match(/<section class="a4-sheet/g) || []).length, 1);
    assert.match(apercu.body, /window\.print\(\)/);
    assert.match(apercu.body, /no-print/, 'menus et boutons sont masqués à l\'impression');
    assert.match(apercu.body, /@media print|print\.css/);

    const confirm = await send('/impression/confirme', { method: 'POST', form: {
      _csrf: tokenOf(apercu.body), ids: `${a.receipt.id},${b.receipt.id}`, sheets: '1' } });
    assert.strictEqual(confirm.status, 302);
    assert.strictEqual((await lastRow(a.receipt.id)).status, 'printed');
    assert.match((await lastRow(a.receipt.id)).detail, /confirm.e manuellement/);
  });

test('une quittance par page : le mode « une » produit une page A4 par document', async () => {
  await login();
  const docs = [];
  for (const u of ['ONE1', 'ONE2']) docs.push((await paidReceipt(u, '771234567', 'o@exemple.sn')).receipt);
  const apercu = await send(`/impression/apercu?ids=${docs.map(d => d.id).join(',')}&mode=une`);
  assert.strictEqual(apercu.status, 200);
  assert.strictEqual((apercu.body.match(/<section class="a4-sheet single"/g) || []).length, 2);
  assert.match(apercu.body, /une quittance par page/);
});

test('l\'aperçu d\'impression ne consigne rien : seule la demande est journalisée', async () => {
  await login();
  const { receipt } = await paidReceipt('PRN3', '771234567', 'p3@exemple.sn');
  const apercu = await send(`/impression/apercu?ids=${receipt.id}&mode=trio`);
  assert.strictEqual(apercu.status, 200);
  assert.strictEqual((await rowsFor(receipt.id)).length, 0, 'consulter un aperçu n\'est pas une transmission');
  const doc = await send(`/quittances/${receipt.id}`);
  assert.match(doc.body, /Aucune action enregistrée pour ce document/);
});

/* ---------- 7. Téléchargement PDF ---------- */

test('télécharger le PDF : fichier valide et action tracée pour chaque document', async (t) => {
  if (!hasPdfEngine) return t.skip('moteur PDF indisponible');
  await login();
  const docs = [];
  for (const u of ['DL1', 'DL2', 'DL3']) docs.push((await paidReceipt(u, '771234567', 'd@exemple.sn')).receipt);

  const single = await send(`/quittances/${docs[0].id}/pdf`, {
    method: 'POST', raw: true, form: { _csrf: await csrf(), mode: 'une' } });
  assert.strictEqual(single.status, 200);
  assert.strictEqual(single.headers.get('content-type'), 'application/pdf');
  assert.match(single.headers.get('content-disposition'), /attachment; filename="quittance-QL-/);
  assert.strictEqual(single.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(single.body.subarray(0, 5).toString(), '%PDF-');
  assert.match(single.body.subarray(-32).toString('latin1'), /%%EOF/);
  assert.strictEqual((await lastRow(docs[0].id)).channel, 'pdf');
  assert.strictEqual((await lastRow(docs[0].id)).status, 'prepared');

  const lot = await send('/impression/pdf', { method: 'POST', raw: true, form: {
    _csrf: await csrf(), ids: docs.map(d => d.id).join(','), mode: 'trio' } });
  assert.strictEqual(lot.status, 200);
  assert.strictEqual(lot.body.subarray(0, 5).toString(), '%PDF-');
  assert.match(lot.body.subarray(-32).toString('latin1'), /%%EOF/);
  for (const d of docs) {
    assert.strictEqual((await lastRow(d.id)).channel, 'pdf', `${d.number} tracé`);
    assert.match((await lastRow(d.id)).detail, /PDF group/);
  }
});

test('un échec de génération PDF est enregistré et renvoie vers l\'impression du navigateur', async () => {
  await login();
  const { receipt } = await paidReceipt('FAIL1', '771234567', 'f@exemple.sn');
  const token = await csrf();

  const realToPdf = pdf.toPdf;
  pdf.toPdf = async () => {
    const e = new Error('Moteur PDF indisponible (simulation).');
    e.pdfUnavailable = true;
    throw e;
  };
  let fail;
  try {
    fail = await send(`/quittances/${receipt.id}/pdf`, {
      method: 'POST', form: { _csrf: token, mode: 'une' } });
  } finally {
    pdf.toPdf = realToPdf;
  }
  assert.strictEqual(fail.status, 302);
  assert.match(fail.location, new RegExp(`^/impression/apercu\\?ids=${receipt.id}&mode=une&pdf=1$`));

  const row = await lastRow(receipt.id);
  assert.strictEqual(row.channel, 'pdf');
  assert.strictEqual(row.status, 'failed');
  assert.match(row.detail, /simulation/);
  assert.match((await send(`/quittances/${receipt.id}`)).body, /Enregistrer au format PDF/);
});

/* ---------- 8. Historique des transmissions ---------- */

test('l\'historique conserve canal, horodatage, destinataire et statut de chaque action', async () => {
  await login();
  const { receipt } = await paidReceipt('HIS1', '771234567', 'h@exemple.sn');
  const token = await csrf();

  await send(`/quittances/${receipt.id}/whatsapp`, { method: 'POST', form: { _csrf: token } });
  await send(`/quittances/${receipt.id}/whatsapp/confirme`, { method: 'POST', form: { _csrf: token } });
  await send('/impression/demander', { method: 'POST', form: { _csrf: token, ids: String(receipt.id), mode: 'une' } });

  const list = await transmissions.listFor(receipt.id);
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map(x => x.channel_label), ['Impression', 'WhatsApp', 'WhatsApp']);
  assert.deepStrictEqual(list.map(x => x.status_label), ['Préparé', 'Envoyé', 'Préparé']);
  assert.match(list[0].at_fr, /^\d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}$/);
  assert.strictEqual(list[1].recipient, '221771234567');

  const view = await send(`/quittances/${receipt.id}`);
  assert.match(view.body, /Historique des transmissions/);
  assert.match(view.body, /Impression/);
  assert.match(view.body, /Préparé/);
  assert.strictEqual((await rowsFor(receipt.id)).length, 3, 'consulter la fiche n\'ajoute aucune action');
});

test.after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (server) await new Promise(resolve => server.close(resolve));
});
