# Gestion des quittances de loyer — Immeuble Bamby Sidibé

Application web locale pour remplacer les quittances papier : suivi des loyers,
paiements réels, génération automatique de quittances et impression de **trois
quittances sur une feuille A4**. Interface d'administration en français, montants
en FCFA, aucune dépendance à Internet au démarrage (Tailwind, Lucide et les polices
sont vendus localement).

Stack : **Node.js + Express**, **EJS**, **Tailwind CSS**, **SQLite** (`better-sqlite3`),
**Lucide Icons**, **Nodemailer** (envoi e-mail), **Chromium headless** (PDF).
Pas de React/Vue/Angular, pas de build frontend.

---

## 1. Installation sur Ubuntu / Linux

### Prérequis

```bash
node --version    # Node.js 20 ou plus récent
npm --version
sudo apt install -y build-essential python3   # requis pour compiler better-sqlite3
```

Pour le bouton **Télécharger le PDF**, un navigateur Chromium est nécessaire
(`sudo apt install -y chromium-browser`, ou Google Chrome). Sans lui, l'application
reste entièrement utilisable : l'impression passe par la boîte de dialogue du
navigateur, qui sait enregistrer en PDF, et le bouton est désactivé avec une
explication visible (§5).

### Première installation

```bash
cd APP_LOCATION
cp .env.example .env      # puis éditez .env (voir §2)
npm install
npm start
```

Ouvrir <http://localhost:3000>. La base `data/rent.sqlite` est créée, migrée et
peuplée automatiquement au premier démarrage (les 3 étages, les 3 types de
logement, les tarifs par défaut et le compte administrateur). **Aucun locataire
fictif n'est préenregistré** : commencez par créer vos logements et locataires.

### Démarrage automatique (optionnel)

```bash
sudo npm i -g pm2
pm2 start src/app.js --name quittances
pm2 save && pm2 startup systemd   # puis exécuter la commande affichée
```

---

## 2. Configuration (`.env`)

| Clé | Rôle | Valeur par défaut |
| --- | --- | --- |
| `PORT` | Port HTTP | `3000` |
| `DATABASE_PATH` | Fichier SQLite | `./data/rent.sqlite` |
| `ADMIN_USERNAME` | Identifiant administrateur | `admin` |
| `ADMIN_PASSWORD` | Mot de passe créé **au premier démarrage uniquement** | `changeme-2026` |
| `SESSION_SECRET` | Secret des cookies de session | à remplacer absolument |
| `BACKUP_DIR` | Dossier des sauvegardes | `./data/backups` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` | Serveur d'envoi des e-mails | vide = pas d'envoi réel |
| `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Identifiant, mot de passe, adresse d'expédition | vide = pas d'envoi réel |
| `SMTP_JSON_TRANSPORT` | `1` : construit le message sans le remettre à un serveur (test) | vide |
| `PDF_ENGINE` | `chromium` (détection auto) ou `none` | `chromium` |
| `CHROME_PATH` | Binaire Chrome/Chromium si l'auto-détection échoue | détection |
| `WHATSAPP_BUSINESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | API officielle WhatsApp (automatisation optionnelle) | vide = brouillons wa.me |
| `WHATSAPP_API_VERSION` | Version de l'API Meta | `v20.0` |

Les clauses `SMTP_*` et `WHATSAPP_BUSINESS_*` sont **optionnelles** : sans elles,
l'application n'annonce jamais un envoi réel (§5). Un mot de passe SMTP ou un
jeton WhatsApp ne doit jamais être saisi dans une page ni committé — `.env` est
dans `.gitignore` et seules les métadonnées du service (hôte, port, adresse
d'expédition, état) sont affichées à l'écran.

Générer un secret robuste :

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Le mot de passe est stocké **haché (bcrypt)** dans la table `settings`. Pour le
changer après le premier démarrage : **Paramètres → Sécurité**, ou
`UPDATE settings SET value='' WHERE key='admin_password_hash';` puis redémarrer
avec le nouveau `ADMIN_PASSWORD`.

---

## 3. Utilisation courante

### Scénario principal (critère de réussite)

1. **Logements** → ajouter les logements réels (numéro, étage, type A/B/C, loyer).
   Un seul logement de type C (terrasse) est autorisé.
2. **Locataires → Nouveau** : en choisissant le logement, l'étage, le type et le
   loyer de référence se remplissent automatiquement. Le loyer reste modifiable
   pour ce locataire uniquement (le tarif par défaut n'est pas touché).
3. **Paiements → Nouveau** (ou **Quittances → Générer**) : sélectionner le locataire
   puis le mois → la période déjà réglée, le montant attendu, le solde et le
   statut s'affichent, et le champ montant se préremplit avec le solde.
4. Enregistrer. Paiement intégral → **quittance**. Paiement partiel → **reçu de
   paiement partiel** (jamais présenté comme un loyer payé).
5. **Impression groupée** → cocher jusqu'à trois quittances → **Aperçu** →
   **Imprimer** : trois blocs sur une feuille A4, à découper sur les pointillés.

### Le mois en un clic — « Quittances du mois »

C'est le chemin réduit au minimum : aucune ressaisie, aucun formulaire intermédiaire.

1. **Menu → Quittances du mois**. La période s'ouvre sur le mois en cours et la
   dernière période consultée est **mémorisée pendant la session** (navigation
   mois précédent / suivant, ou sélecteurs mois + année).
2. Chaque ligne reprend ce qui est déjà enregistré sur la fiche du locataire :
   locataire, étage · logement, loyer mensuel, statut du paiement, statut de la
   quittance, actions. Un champ de recherche filtre les lignes instantanément.
3. **Générer la quittance** (un clic) : le document est préparé avec les données
   de la fiche, numéroté, et **l'aperçu final s'ouvre directement** — pas de
   formulaire à remplir. Depuis cet aperçu : Réimprimer, Télécharger en PDF,
   Envoyer par WhatsApp, Envoyer par e-mail, 3 exemplaires.
4. **Générer toutes les quittances du mois** : un seul traitement **groupé** pour
   toutes les locations actives de la période, puis une page **Récapitulatif**
   (compteurs, documents prêts, paiements non enregistrés, sélection pour
   l'impression). Aucune fenêtre individuelle, aucun doublon : une ligne déjà
   émise reste « Déjà générée » et se réimprime.
5. Le lot ne confirme **aucun paiement** et n'**envoie aucun message**. Un loyer
   non encaissé produit un **avis de loyer** (`AL-AAAA-0001`), clairement
   distinct d'une quittance : il indique le solde à régler et porte la mention
   « CE DOCUMENT N'EST PAS UNE QUITTANCE ». La quittance n'arrive qu'après
   l'encaissement, via l'action « Enregistrer le paiement et générer la
   quittance » (montant du solde et date du jour préremplis) ou un nouveau clic
   sur la ligne devenue « Intégralement payé ».
6. Statuts affichés : *En attente de paiement* / *Partiel* / *Intégralement payé*
   côté paiement, *À générer* / *Avis de loyer généré* / *Reçu partiel généré* /
   *Quittance générée* côté document.
7. Récapitulatif → cocher les documents (les avis sont décochés par défaut) →
   **Imprimer les sélectionnés** ou **Télécharger en PDF** : lots automatiques de
   3 par feuille A4, nombre de feuilles calculé avant l'impression
   (3 → 1 feuille, 6 → 2, 10 → 4 dont une partiellement remplie).
   Le PDF est généré côté serveur (Chromium headless, même modèle imprimable) si
   un navigateur est disponible, sinon la boîte d'impression du navigateur prend
   le relais (« Enregistrer au format PDF »). WhatsApp et l'e-mail n'ouvrent, par
   défaut, qu'un **brouillon** que vous validez ; le bouton n'apparaît que si le
   contact existe, et une correction temporaire du numéro est possible avant
   l'envoi (§5).

### Les pages

| Page | Contenu |
| --- | --- |
| `/` Tableau de bord | locataires, logements occupés/disponibles, encaissé et attendu du mois, payés/en attente, dernières quittances, sélecteur mois/année, raccourcis |
| `/logements` | vue du bâtiment par étage + CRUD des logements ; un locataire peut être affecté ou retiré sans perdre l'historique |
| `/locataires` | recherche (nom, étage, logement), filtres, fiche complète avec historique, archivage à la place de la suppression |
| `/paiements` | enregistrement des paiements (espèces, Wave, Orange Money, virement), liste filtrable, export CSV |
| `/quittances/mois` | **Quittances du mois** : génération en un clic par locataire, génération groupée de tout le mois, recherche instantanée, encaissement rapide, mémorisation de la dernière période consultée |
| `/quittances/mois/recap` | récapitulatif après lot mensuel : compteurs, documents prêts, paiements non enregistrés, sélection pour impression par lots de 3, PDF, brouillons WhatsApp / e-mail |
| `/quittances` | historique des quittances, reçus partiels et avis de loyer : consultation, réimpression, PDF, annulation, sélection multiple pour imprimer ou télécharger en lot, actions rapides par ligne (WhatsApp, e-mail, impression, PDF, historique des transmissions) |
| `/quittances/:id` | fiche du document : les trois actions principales (Envoyer par WhatsApp, Envoyer par e-mail, Imprimer la quittance), Télécharger le PDF, aperçu du document et **historique des transmissions** complet |
| `/impression` | mode 1 (une quittance par page), mode 2 (jusqu'à 3 quittances distinctes sur une feuille) et mode 3 (3 exemplaires) ; sélection multiple, aperçu avant impression, PDF groupé |
| `/calendrier` | suivi mensuel par logement : attendu / payé / reste / statut, navigation mois par mois |
| `/parametres` | identité du propriétaire, tarifs par défaut, libellés des documents, numérotation (préfixes `QL` et `AL`), indicatif WhatsApp pour les partages, **état des canaux d'envoi** (moteur PDF, SMTP, API WhatsApp Business), signature numérisée, sauvegardes, mot de passe |

### Règles métier appliquées

- Le statut d'un mois vient des **paiements enregistrés**, jamais de la présence
  d'une quittance, et n'est **jamais** mis à jour automatiquement au changement de mois.
- Une quittance d'intégralité est refusée en doublon pour un même
  locataire/logement/période ; la réémission reste possible explicitement
  (case « réémettre »), l'ancien document étant tracé comme annulé.
- Les numéros (`QL-AAAA-0001` par défaut) sont uniques et **jamais réutilisés**,
  même après annulation.
- Chaque quittance conserve un **instantané** (locataire, logement, étage, type,
  loyer attendu, mode de paiement) : modifier un nom ou un tarif ensuite ne
  change aucun document déjà émis.
- Les montants sont stockés en **entiers FCFA**.
- Un locataire ayant un historique financier est **archivé**, jamais supprimé.
- Un **avis de loyer** ne peut pas être émis pour une période déjà réglée, et une
  quittance intégrale rend automatiquement caduc l'avis de la même période :
  l'avis annulé reste visible dans l'historique, il n'est jamais effacé.
- Deux quittances intégrales actives pour un même locataire / logement / période
  sont bloquées **par la base** (index unique partiel `uq_receipts_full_period`),
  pas seulement par l'application ; la même règle vaut pour les avis
  (`uq_receipts_avis_period`). Une réémission volontaire annule d'abord l'ancien
  document et conserve la trace.
- La génération mensuelle en lot est **idempotente** : relancer « Générer toutes
  les quittances du mois » ne crée aucun document et n'émet aucun numéro en plus.
- Les partages WhatsApp et e-mail partent du **contact réellement enregistré** sur
  la fiche (numéro normalisé au format international via l'indicatif des
  paramètres, adresse validée) : l'application n'invente jamais un contact. Un
  numéro ou une adresse manquante bloque seulement cette action, jamais les
  autres, et l'utilisateur est invité à renseigner la fiche.
- Chaque action de transmission est **journalisée** avec son canal, son destinataire,
  son horodatage et son statut réel (§5) : « préparé » n'est jamais présenté comme
  « envoyé ».

---

## 4. Impression A4 (3 quittances par feuille)

- Format visé : A4 portrait 210 × 297 mm, `@page { size: A4 portrait; margin: 5mm }`,
  trois emplacements de ≈ 95,7 mm répartis sur 200 mm de largeur exploitable.
- Dans l'aperçu : **Imprimer** ouvre la boîte de dialogue du navigateur.
  Régler **Margins → Default**, **Size → A4**, **Scale → 100 %**, décocher
  « En-têtes et pieds de page ». Les menus, boutons et barres latérales sont
  exclus par `@media print` ; le rendu reste lisible en noir et blanc.
- Trois exemplaires d'une **même** quittance : mode « 3 exemplaires », à demander
  explicitement depuis la fiche d'une quittance.
- Cas extrêmes validés (noms à rallonge, 999 990 FCFA en toutes lettres,
  observations de 200 caractères) : le bloc le plus haut occupe 76 mm sur 95,7 mm,
  aucune ligne rognée. L'avis de loyer, plus dense (avertissement encadré), a été
  remesuré dans les mêmes conditions : il tient dans son emplacement, pied de page
  compris, sans rognure.

---

## 5. Envoi et partage des quittances (WhatsApp, e-mail, impression, PDF)

Une fois le document généré, trois actions principales sont proposées côte à
côte — **Envoyer par WhatsApp**, **Envoyer par e-mail**, **Imprimer la
quittance** — plus **Télécharger le PDF**. Elles sont accessibles depuis la fiche
du document (`/quittances/:id`), depuis chaque ligne de l'historique
(`Menu ⋮ Actions`), depuis le récapitulatif mensuel et depuis `/impression`.
Toutes utilisent **le même modèle de quittance** : le document imprimé,
téléchargé ou envoyé a le même rendu.

### WhatsApp

- Le message est prérempli à partir du document et du contact enregistré :
  « Bonjour Awa Ndiaye, veuillez trouver votre quittance de loyer pour le mois
  d'octobre 2026, d'un montant de 40 000 FCFA. Numéro de quittance :
  QL-2026-0001. Merci. » (un avis de loyer et un reçu partiel adaptent le libellé
  et le solde). Le lien `https://wa.me/<numéro>?text=<message>` est construit avec
  l'encodage correct et le numéro normalisé au format international
  (`771234567` → `221771234567`, `+221 …` et `00221 …` acceptés).
- Le numéro affiché peut être **vérifié ou modifié temporairement** avant l'envoi :
  le champ de la fiche d'envoi n'écrit rien dans la base, il ne sert qu'à ce
  partage. Si le numéro est inexploitable, l'action est refusée avec une
  explication, enregistrée comme **échec**, et les autres actions restent
  disponibles.
- Ouvrir WhatsApp **ne joint pas le PDF et n'envoie pas** le message : la fiche
  rappelle l'étape (télécharger le PDF puis le joindre à la main) et un bouton
  **« J'ai envoyé le message »** enregistre la confirmation explicite. Tant que
  cette confirmation (ou un accusé de l'API) n'existe pas, l'action reste
  **Préparé**.
- L'automatisation réelle par l'**API officielle WhatsApp Business** est prévue
  mais jamais activée silencieusement : elle exige `WHATSAPP_BUSINESS_TOKEN`,
  `WHATSAPP_PHONE_NUMBER_ID` (et `WHATSAPP_API_VERSION`), et un numéro
  `auto=1` déclenche un appel unique à `graph.facebook.com`. Un succès donne
  **Envoyé** avec l'identifiant Meta ; un refus (par exemple erreur 131026) donne
  **Échec** avec le message de l'API. Le PDF n'est joint que s'il est hébergé
  publiquement ; sans cela, l'historique précise qu'il n'a pas été joint.

### E-mail

- Avec SMTP configuré (`.env`) : **envoi réel avec le PDF en pièce jointe** via
  Nodemailer, sujet « Quittance de loyer — Octobre 2026 — Awa Ndiaye », corps
  reprenant locataire, période, montant, logement et numéro. Le succès n'est
  affiché **que** si le serveur a accepté le message (et un destinataire refusé
  est traité comme un échec) ; l'adresse, le sujet et la taille de la pièce
  jointe sont enregistrés.
- Sans SMTP : la page l'explique et propose **le téléchargement du PDF** ou
  l'ouverture du logiciel de messagerie avec un **brouillon prérempli**
  (`mailto:`), enregistré comme **Préparé** — jamais comme envoyé. Le même
  principe vaut pour le transport de test `SMTP_JSON_TRANSPORT=1`.
- Adresse invalide ou vide → message d'erreur, statut **Échec**, autres actions
  intactes. Les identifiants SMTP ne sortent jamais du serveur : seules l'hôte,
  le port, le chiffrement, l'adresse d'expédition et l'état sont visibles dans
  **Paramètres**, le mot de passe n'est ni affiché ni journalisé.

### Impression

- Trois modes : **une quittance par page**, **jusqu'à trois quittances distinctes
  par A4**, **trois exemplaires** d'un même document. La sélection multiple existe
  dans l'historique, le récapitulatif mensuel et `/impression` ; le nombre de
  feuilles est annoncé avant l'impression.
- Un **aperçu** est affiché avant la boîte de dialogue ; les menus, boutons et
  barres d'administration sont exclus par `@media print` (`no-print`), le rendu
  reste lisible en noir et blanc. Consulter un aperçu n'enregistre rien.
- La **demande** d'impression est journalisée « Préparé » ; seul le bouton
  **« J'ai imprimé »** de l'aperçu enregistre **Imprimé**, car le navigateur ne
  peut pas vérifier la sortie papier réelle.

### PDF et historique des transmissions

- Le PDF est produit en rendant **le même gabarit `print/sheets`** côté serveur
  (`app.render` en mode autonome, ressources réécrites en `file://`) puis en le
  confiant à Chromium headless (`--print-to-pdf`, `--no-pdf-header-footer`).
  `CHROME_PATH` permet d'indiquer le binaire, `PDF_ENGINE=none` de désactiver la
  fonction. Le lot garde trois quittances par A4, le document seul tient sur une
  page. Aucun locataire n'est jamais préenregistré, aucune signature n'est
  ajoutée si elle n'a pas été fournie.
- Si le moteur échoue, l'échec est journalisé, un message clair apparaît et
  l'application renvoie vers l'aperçu d'impression du navigateur (« Enregistrer
  au format PDF ») : rien n'est annoncé comme téléchargé à tort.
- Chaque document porte son **historique des transmissions** : canal (WhatsApp,
  e-mail, impression, téléchargement), destinataire quand il y en a un, date et
  heure en français, statut (**Préparé / Envoyé / Échec / Imprimé**) et, le cas
  échéant, le message d'erreur. Un échec SMTP y côtoie un envoi WhatsApp réussi,
  et la simple consultation d'un document n'ajoute aucune ligne.

---

## 6. Sauvegardes

- **Bouton « Sauvegarder maintenant »** dans Paramètres, ou en ligne de commande :

  ```bash
  npm run backup
  ```

- Copie cohérente via l'API `Backup` de SQLite, nommée
  `data/backups/rent-<horodatage>.sqlite`, conservée 30 jours, téléchargeable
  depuis Paramètres.
- Sauvegarde manuelle de secours (application arrêtée) :

  ```bash
  cp data/rent.sqlite ~/Sauvegardes/rent-$(date +%F).sqlite
  ```

- Les signatures importées (`data/signatures/`) ne sont **pas** versionnées :
  les copier avec la base. Les exports CSV sont produits à la volée et ne
  laissent aucun fichier sur le disque.

---

## 7. Tests et vérification du démarrage

```bash
npm test          # 58 tests (node:test) — base SQLite temporaire par fichier
```

Ils couvrent : calculs de loyers et soldes, paiements partiels et complets,
refus des doublons et réémission, unicité des numéros, conservation de
l'historique (archivage, changement de tarif, instantanés), regroupement par lots
de trois, toutes lettres françaises, formatage FR, CSRF, hachage du mot de passe,
échappement, statistiques du tableau de bord et du calendrier.

`tests/month.test.js` vérifie en plus la génération mensuelle en un clic : aucun
document « payé » pour un loyer non encaissé (avis de loyer à la place), caducité
de l'avis après encaissement, idempotence du lot, refus en base de deux quittances
intégrales, étiquettes du tableau du mois, brouillons de partage, et — sur un
serveur HTTP réel — mémorisation de la période en session, ouverture directe du
document après un clic unique, récapitulatif, impression par lots de trois et
compilation de tous les modèles EJS.

`tests/transmit.test.js` vérifie l'envoi et le partage (§5) : génération PDF réelle
(octets `%PDF-` / `%%EOF`, accents français, montant en toutes lettres, zone de
signature laissée vide faute de dépôt, noms de fichiers ASCII), nombre de feuilles
pour 1, 2 et 3 documents en mode « une » et « exemplaires », normalisation des
numéros sénégalais, texte exact du message WhatsApp et de son encodage, envoi
e-mail réel avec pièce jointe quand SMTP répond (transport simulé, adresse, sujet,
corps et jointe contrôlés, mot de passe SMTP absent du HTML), adresse invalide et
échec serveur (enregistrés comme échec, autres actions intactes), absence de SMTP (brouillon
`mailto:` enregistré « préparé »), appel unique à l'API WhatsApp Business avec
en-tête Bearer et accusé « envoyé », refus de l'API enregistré « échec », demande
d'impression « préparée » puis confirmation « imprimée », aperçu qui n'enregistre
rien, téléchargements PDF tracés, et l'historique complet (canal, destinataire,
horodatage, statut).

Vérification bout-en-bout sur un serveur lancé :

```bash
npm start &
node scripts/smoke.js         # connexion, locataires, paiements, doublon refusé, CSV, aperçu A4
node scripts/stress-print.js  # cas extrêmes pour l'impression
```

Ces deux scripts créent des lignes marquées `Demo …` / `Stress …` et les purge
d'abord : à réserver à un environnement d'essai.

---

## 8. Organisation du projet

```
src/
  app.js                 Express, sessions (store SQLite maison), locals globaux, gestion d'erreurs FR
  config.js              lecture de .env
  db.js                  ouverture SQLite (WAL, clés étrangères) + exécute les migrations *.sql
  db/migrations/         001_init.sql : schéma complet + index · 002_monthly_documents.sql : avis de loyer, e-mail, index d'unicité · 003_transmissions.sql : journal des transmissions
  middleware/security.js CSRF (timingSafeEqual), exigences de session
  services/
    auth.js              bcrypt, création du compte administrateur
    units.js             étages, types, logements, vue bâtiment
    tenants.js           locataires, locations, archivage, réattribution
    rent.js              CŒUR métier : soldes, paiements, quittances, avis, génération en un clic et en lot, numérotation, lots d'impression
    share.js             contacts et messages : normalisation internationale des numéros, textes WhatsApp/e-mail, brouillons wa.me / mailto, appel à l'API WhatsApp Business (opt-in par .env)
    mailer.js            envoi e-mail réel via Nodemailer (SMTP from .env), pièce jointe PDF, statut du service sans le mot de passe
    pdf.js               téléchargement PDF : rendu du modèle d'impression identique, puis Chromium headless (détection du binaire, PDF_ENGINE / CHROME_PATH)
    transmissions.js     journal des transmissions : canal, destinataire, statut (préparé / envoyé / échec / imprimé), horodatage FR
    stats.js             tableau de bord, board mensuel, historiques filtrés
    settings.js          paramètres + jeu de données initial
    backup.js            sauvegardes datées, purge, vérification
  routes/                dashboard, units, tenants, payments, month (Quittances du mois), receipts, print, calendar, settings, export, api, auth
  views/                 EJS (mise en page, partiel imprimable receipt-doc.ejs, pages month/index et month/recap, fiche quittances/show avec actions de partage et historique des transmissions)
  public/                CSS écran + impression, JS vanilla, vendor Tailwind et Lucide
  utils/format.js        FCFA, dates et périodes FR, montants en toutes lettres
tests/                   node:test + helpers (base temporaire isolée)
scripts/                 smoke.js, stress-print.js, backup.js
data/                    base SQLite, sauvegardes, signatures (hors service)
```

### Modèle de données

`floors` (3 étages) · `unit_types` (A/B/C + tarif par défaut) · `units`
(logement, étage, type, loyer, statut, notes) · `tenants` (identité, téléphone,
e-mail, statut actif/archivé, date de départ) · `tenancies` (occupation d'un
logement : entrée, sortie, loyer convenu, instantanés logement/étage/type) ·
`payments` (montant entier, date, mode, période, note) · `receipts` (numéro unique, type `recu_partiel` / `quittance` / `quittance_definitive` / `avis_loyer`,
montants, instantané JSON, drapeau annulé) · `receipt_transmissions` (une ligne
par action de partage : document, canal `whatsapp` / `email` / `print` / `pdf`,
statut `prepared` / `sent` / `failed` / `printed`, destinataire, détail ou message
d'erreur, horodatage) · `receipt_sequences` (compteur de
numérotation par année, partagé entre `QL` et `AL` pour que les numéros ne soient
jamais réutilisés).

Contraintes notables : `UNIQUE(floor_id, name)`, `CHECK` sur les statuts et les
modes de paiement, index sur les périodes et les locataires, un index unique
partiel `uq_tenancies_open_unit` qui empêche deux locations ouvertes sur un même
logement, et les index partiels `uq_receipts_full_period` /
`uq_receipts_avis_period` qui interdisent deux quittances intégrales (ou deux
avis) actifs pour la même location et la même période.

### Évolution vers PostgreSQL

Toute l'accès aux données passe par `src/db.js` et des requêtes paramétrées.
Pour migrer : ajouter un adaptateur (par ex. `pg`) exposant `prepare().get/all/run`
et `transaction()`, convertir `001_init.sql` (`INTEGER` → `BIGINT`,
`datetime('now')` → `now()`, `AUTOINCREMENT` → `GENERATED ALWAYS AS IDENTITY`,
index partiel déjà compatible) et rejouer les migrations sur la nouvelle base.
Aucune vue ni règle métier n'a besoin d'être modifiée.

---

## 9. Dépannage

| Symptôme | Solution |
| --- | --- |
| `npm run dev` : « Cannot find module 'express-session' » | `npm install` (les dépendances manquaient) |
| Les pages ne se rafraîchissent pas en développement | lancer avec `NODE_ENV=development` (sinon le cache des vues EJS reste actif) |
| « Session expirée » sur un formulaire | le jeton CSRF a expiré : recharger la page |
| Port 3000 occupé | `PORT=3100 npm start` |
| Trois quittances ne tiennent pas sur la feuille | vérifier marges/A4/échelle 100 % dans la boîte d'impression |
| Bouton « Télécharger le PDF » grisé | aucun Chromium/Chrome détecté : `sudo apt install -y chromium-browser`, ou indiquer le binaire dans `CHROME_PATH` (`PDF_ENGINE=none` pour le désactiver assumément). L'impression du navigateur reste disponible et produit le même PDF |
| « Aucun service SMTP n'est configuré » | normal sans `SMTP_*` : l'application propose un brouillon `mailto:` ou le PDF, et journalise « Préparé ». Renseigner `.env` puis redémarrer pour l'envoi réel |
| Un e-mail est « Envoyé » mais le locataire ne l'a pas reçu | vérifier le destinataire dans l'historique des transmissions ; le serveur a pu accepter puis refuser (rejet enregistré comme « Échec » avec le message du serveur) |
| Le document reste « Préparé » après l'ouverture de WhatsApp | c'est le comportement attendu : wa.me n'envoie rien. Joindre le PDF puis confirmer avec « J'ai envoyé le message » |
| `better-sqlite3` ne compile pas | `sudo apt install build-essential python3` puis `npm rebuild better-sqlite3` |

## Licence

Usage privé de gestion locative — non publié (`UNLICENSED`).
