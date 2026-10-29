# Gestion des quittances de loyer — Immeuble Bamby Sidibé

Application web locale pour remplacer les quittances papier : suivi des loyers,
paiements réels, génération automatique de quittances et impression de **trois
quittances sur une feuille A4**. Interface d'administration en français, montants
en FCFA, aucune dépendance à Internet au démarrage (Tailwind, Lucide et les polices
sont vendus localement), et **application installable** sur le poste, sur Android
et sur iPhone (§6).

Stack : **Node.js + Express**, **EJS**, **Tailwind CSS**, **PostgreSQL** (`pg`),
**Lucide Icons**, **Nodemailer** (envoi e-mail), **Chromium headless** (PDF),
**PWA** (manifeste, icônes, service worker). Pas de React/Vue/Angular, pas de build
frontend.

---

## 1. Installation sur Ubuntu / Linux

### Prérequis

```bash
node --version    # Node.js 20 ou plus récent
npm --version
sudo apt install -y postgresql postgresql-client   # base de données
```

Le service doit tourner sur la machine (cluster local, port 5432) :

```bash
sudo systemctl status postgresql     # « active »
```

Pour le bouton **Télécharger le PDF**, un navigateur Chromium est nécessaire
(`sudo apt install -y chromium-browser`, ou Google Chrome). Sans lui, l'application
reste entièrement utilisable : l'impression passe par la boîte de dialogue du
navigateur, qui sait enregistrer en PDF, et le bouton est désactivé avec une
explication visible (§5).

### Créer le rôle et la base (une seule fois)

En tant qu'administrateur PostgreSQL :

```bash
sudo -u postgres psql
```

```sql
CREATE ROLE quittances LOGIN PASSWORD 'mot-de-passe' CREATEDB;
CREATE DATABASE quittances OWNER quittances;
\q
```

`CREATEDB` est nécessaire pour la suite de tests, qui crée et supprime une base
isolée par fichier de test.

### Première installation

```bash
cd APP_LOCATION
cp .env.example .env      # puis éditez .env : DATABASE_URL au minimum (voir §2)
npm install
npm start
```

Ouvrir <http://localhost:3000>. Les migrations `src/db/migrations/*.sql` sont
appliquées automatiquement au premier démarrage (les 3 étages, les 3 types de
logement, les tarifs par défaut, les paramètres et le compte administrateur).
**Aucun locataire fictif n'est préenregistré** : commencez par créer vos logements
et locataires. Pour héberger l'application en ligne (Render) au lieu de la lancer
sur ce poste, voir §11.

Pour l'utiliser comme un logiciel — icône « Loyers », fenêtre autonome, installation
sur le poste, sur Android et sur iPhone — voir §6. Les icônes et les ressources
d'installation sont déjà générées : aucune commande supplémentaire n'est nécessaire.

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
| `DATABASE_URL` | Chaîne de connexion PostgreSQL (`postgres://user:mot-de-passe@hôte:port/base`) | — |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | Alternative à `DATABASE_URL` (utilisée si elle est vide) | `localhost`, `5432`, `quittances` |
| `PG_POOL_MAX` | Connexions simultanées dans le pool | `8` |
| `SQLITE_ARCHIVE_PATH` | Ancienne base SQLite, lue uniquement par le script d'import | `./data/rent.sqlite` |
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

`DATABASE_URL` prime sur les variables `PG*`. Un mot de passe contenant des
caractères spéciaux doit être encodé dans l'URL (`p/a/ss` → `p%2Fa%2Fss`).

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
| `/parametres` | identité du propriétaire, tarifs par défaut, libellés des documents, numérotation (préfixes `QL` et `AL`), indicatif WhatsApp pour les partages, **état des canaux d'envoi** (moteur PDF, SMTP, API WhatsApp Business), **installation de l'application (PWA)** et marche à suivre par navigateur, signature numérisée, sauvegardes, mot de passe |

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

## 6. Application installable (PWA)

L'application s'installe comme un logiciel dans Chrome, Edge (Ubuntu, Windows,
macOS), Chrome Android et Safari iOS, et s'ouvre alors dans **sa propre fenêtre**,
sans barre d'adresse, avec son icône et son nom « Loyers ».

### Ce qui est réellement en place

| Élément | Fichier | Rôle |
| --- | --- | --- |
| Manifeste Web | `src/public/manifest.webmanifest`, servi à la racine (`/manifest.webmanifest`) | nom « Gestion des quittances de loyer », nom court « Loyers », `start_url` et `scope` sur `/`, `display: standalone`, `background_color` `#f7f7f5`, `theme_color` `#256343`, deux raccourcis (Quittances du mois, Enregistrer un paiement) |
| Icônes | `src/public/icons/` | PNG 192 × 192 et 512 × 512, variante `maskable` pour Android, `apple-touch-icon`, plus le gabarit vectoriel `icon.svg` |
| Écran de démarrage | `src/public/splash/` | 13 images iOS (iPhone portrait, iPad portrait et paysage) + `background_color` et icône pour l'Android/desktop |
| Service worker | `src/public/sw.js`, servi à la racine | met en cache **la coquille** (CSS, JS, vendor, icônes, manifeste, page d'accueil hors ligne), supprime les caches des versions précédentes à l'activation |
| Bouton d'installation | `src/public/js/pwa.js`, dans le menu latéral et **Paramètres → Application installable (PWA)** | utilise l'invite native `beforeinstallprompt`, rend l'état après acceptation ou refus, se masque quand l'application est déjà installée |
| Page hors ligne | `src/public/hors-ligne.html` (URL `/hors-ligne`) | écran d'accueil servi par le cache quand le serveur n'est pas joignable |
| Métadonnées | `src/views/partials/pwa-head.ejs` | `<link rel="manifest">`, `theme-color`, icône tactile, déclarations iOS, inclus par `partials/head.ejs` sur toutes les pages — **pas** sur le gabarit d'impression |

### Installer

**Ubuntu / Windows / macOS — Chrome ou Edge.** Ouvrir `http://localhost:3000`
(ou l'adresse du poste hôte en HTTPS), puis l'un des trois chemins équivalents :
bouton **« Installer l'application »** (menu latéral ou Paramètres), icône
d'installation dans la barre d'adresse, ou menu ⋮ → « Installer l'application… ».
L'invite est demandée au navigateur : après acceptation l'icône « Loyers »
apparaît sur le bureau / dans la liste des applications, après refus le message
« Installation annulée » est affiché et le bouton reste disponible.

**Android.** Chrome → menu ⋮ → « Ajouter à l'écran d'accueil ». Si le navigateur
ne remet pas d'invite, l'application affiche ce mode d'emploi au lieu d'un bouton
inactif.

**iPhone / iPad (Safari).** Partager (icône carrée à flèche vers le haut) →
« Sur l'écran d'accueil ». L'application s'ouvre alors en `standalone` avec son
écran de démarrage. Le bouton « Installer » n'apparaît **jamais** sur iOS : Safari
ne fournit pas d'invite programmable, et la page Paramètres l'explique.

**Navigateur sans installation** (Firefox de bureau, Safari macOS) : aucun faux
bouton n'est affiché ; la zone d'installation explique ce que le navigateur ne
propose pas et comment faire.

### Hors ligne : ce qui est disponible, et ce qui ne l'est pas

Le cache du navigateur ne contient que **l'interface**. Les locataires, paiements,
quittances et paramètres vivent dans **PostgreSQL, sur le poste qui exécute
Node.js** : aucune base locale, aucune file d'attente de synchronisation, donc
aucune écriture différée ni conflit de fusion possible.

- Interface ouverte, serveur éteint → la page « Serveur de l'application
  injoignable » s'affiche : elle dit que les données ne sont pas sur l'appareil et
  qu'**aucun document n'a été envoyé, imprimé ni modifié** pendant la coupure.
- Bandeau discret en bas de page dès que le navigateur passe hors connexion, avec
  le même avertissement.
- Une saisie en cours (POST) n'est **jamais** rejouée par le service worker, et
  aucune page, aucun `/api`, aucun PDF, aucune signature n'est mis en cache :
  un écran ne peut pas afficher une quittance périmée en croyant qu'elle est à jour.
- Un véritable mode hors ligne avec écritures (file d'attente locale,
  synchronisation et gestion des conflits) demanderait une architecture dédiée ;
  il n'est pas simulé ici.

### Mises à jour après déploiement

1. Redéployer le code et relancer le service (`pm2 restart quittances`, ou
   `npm start`).
2. Si des fichiers precachés ont changé (CSS, JS, icônes), incrémenter
   `VERSION` en tête de `src/public/sw.js` — c'est ce qui force le nouveau cache.
3. L'onglet ouvert reçoit le nouveau service worker et affiche un bandeau
   **« Nouvelle version disponible → Mettre à jour »** ; le rechargement est
   déclenché par l'utilisateur, jamais d'autorité, pour ne pas perdre une saisie.
   Un onglet laissé ouvert se resynchronise aussi dès qu'il reprend le premier plan.
4. À l'activation, les caches des versions antérieures sont supprimés : aucune
   version obsolète ne survit.

### Générer à nouveau les icônes et les écrans de démarrage

```bash
npm run pwa:assets     # Chrome headless rasterise icon.svg et les 13 images iOS
```

Le script lit la table `STARTUP` de `src/views/partials/pwa-head.ejs` (taille
annoncée au navigateur = taille produite), puis vérifie chaque PNG généré.
`src/public/icons/icon.svg` est le seul fichier à modifier pour changer le logo.

### Sécurité et compatibilité

- **HTTPS en production.** Le service worker et l'installation exigent un contexte
  sécurisé ; `http://localhost` est accepté pour le développement local. Pour un
  accès depuis d'autres postes, placer l'application derrière un reverse proxy TLS
  (par exemple nginx + certificat, `letsencrypt` pour une adresse publique) et
  ouvrir l'adresse `https://…` : c'est cette origine qui sera installée.
- Le manifeste, le service worker et la page hors ligne sont servis **avant** la
  session et le CSRF — ils ne contiennent aucune donnée métier — tandis que toutes
  les pages applicatives restent protégées par la connexion.
- `Cache-Control: no-cache` sur `/sw.js` et `/manifest.webmanifest` : le navigateur
  recompare les octets à chaque chargement au lieu de traîner une vieille version.
- Les ressources externes (`wa.me`, API WhatsApp) ne sont jamais interceptées par
  le service worker.

---

## 7. Sauvegardes

- **Bouton « Sauvegarder maintenant »** dans Paramètres, ou en ligne de commande :

  ```bash
  npm run backup
  ```

- Archive cohérente produite par `pg_dump -Fc --no-owner --no-privileges`, nommée
  `data/backups/quittances-<horodatage>.dump` (format compressé, restaurable en
  partie), conservée 30 jours et téléchargeable depuis Paramètres. Le mot de passe
  transite par l'environnement du processus enfant, jamais par la ligne de commande.
- Chaque archive est vérifiée (`pg_restore --list`) avant d'être annoncée comme
  sauvegardée.
- Restauration :

  ```bash
  dropdb quittances && createdb quittances
  pg_restore -d quittances --no-owner data/backups/quittances-2026-10-29T17-23-13.dump
  ```

- Sauvegarde manuelle de secours, hors application :

  ```bash
  pg_dump -Fc -f ~/Sauvegardes/quittances-$(date +%F).dump "$DATABASE_URL"
  ```

- Les signatures importées (`data/signatures/`) ne sont **pas** contenues dans
  l'archive PostgreSQL : les copier avec la base. Les exports CSV sont produits à
  la volée et ne laissent aucun fichier sur le disque.

---

## 8. Tests et vérification du démarrage

```bash
npm test          # 74 tests (node:test) — une base PostgreSQL isolée par fichier
```

Chaque fichier de test crée sa propre base (`quittances_test_<pid>_<hasard>`) via
`createdb`, y applique les migrations, puis la supprime à la fin (`dropdb`) : les
tests ne touchent jamais les données réelles. Le rôle utilisé doit donc avoir
`CREATEDB`. Un garde-fou de `tests/helpers.js` refuse en outre tout fichier qui
chargerait `src/config`, `src/db` ou `src/app` **avant** `loadApp()` : la
configuration de production se serait installée dans le processus et les tests
écriraient dans la base réelle. Ils couvrent : calculs de loyers et soldes, paiements partiels et
complets, refus des doublons et réémission, unicité des numéros, conservation de
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

`tests/pwa.test.js` vérifie l'installation (§6) : manifeste accessible sans
connexion avec ses champs obligatoires (`name`, `short_name`, `start_url`,
`scope`, `display: standalone`, couleurs), icônes PNG réellement aux tailles
annoncées (lecture de l'en-tête IHDR), chaque ressource precachée reachable hors
session, liste des URL que le service worker refuse de cacher (pages, `/api`,
`/signatures`, PDF), page hors ligne qui n'affirme pas que les données le sont,
métadonnées présentes dans les pages, boutons d'installation `hidden` par défaut,
et gabarit d'impression exempt de toute référence PWA.

`tests/sw.test.js` exécute le service worker **hors navigateur** (`src/public/sw.js`
chargé dans un `vm` avec de faux `caches` et un `fetch` simulé) : precache de la
coquille, installation qui survit à une ressource absente, fichier de coquille servi
depuis le cache puis réactualisé, navigation qui vient du serveur et jamais archivée,
retombée sur la page d'avertissement quand le serveur est injoignable, réponse 504
sans cache ni serveur, non-interception des POST / `/api` / signatures / PDF / liens
externes, suppression des caches de versions précédentes à l'activation, et
`skipWaiting` déclenché uniquement par un message explicite.

Vérification bout-en-bout sur un serveur lancé :

```bash
npm start &
npm run smoke               # connexion, locataires, paiements, doublon refusé, CSV, aperçu A4
node scripts/stress-print.js  # cas extrêmes pour l'impression
```

Ces deux scripts créent des lignes marquées `Demo …` / `Stress …` et les purge au
démarrage (`scripts/purge-demo.js`) : à réserver à un environnement d'essai. Ils
lisent la même `DATABASE_URL` que l'application — pour les mener sur une base de
test, démarrer l'application et le script avec la `DATABASE_URL` de cette base.

---

## 9. Organisation du projet

```
src/
  app.js                 Express, sessions (store PostgreSQL maison), locals globaux, ressources PWA à la racine du scope, gestion d'erreurs FR
  boot.js                ordre de démarrage : base joignable → migrations → paramètres → compte administrateur → purge des sessions expirées
  config.js              lecture de .env (DATABASE_URL ou variables PG*)
  db.js                  pool `pg` + façade prepare().get/all/run async, placeholders « ? » traduits en « $n », transactions par AsyncLocalStorage, migrations *.sql
  db/migrations/         001_init.sql : schéma complet + index · 002_monthly_documents.sql : avis de loyer, e-mail, index d'unicité · 003_transmissions.sql : journal des transmissions · 004_sessions.sql : sessions côté serveur
  middleware/security.js CSRF (timingSafeEqual), exigences de session
  services/
    auth.js              bcrypt, création du compte administrateur
    units.js             étages, types, logements, vue bâtiment
    tenants.js           locataires, locations, archivage, réattribution
    rent.js              CŒUR métier : soldes, paiements, quittances, avis, génération en un clic et en lot, numérotation atomique, lots d'impression
    share.js             contacts et messages : normalisation internationale des numéros, textes WhatsApp/e-mail, brouillons wa.me / mailto, appel à l'API WhatsApp Business (opt-in par .env)
    mailer.js            envoi e-mail réel via Nodemailer (SMTP from .env), pièce jointe PDF, statut du service sans le mot de passe
    pdf.js               téléchargement PDF : rendu du modèle d'impression identique, puis Chromium headless (détection du binaire, PDF_ENGINE / CHROME_PATH)
    transmissions.js     journal des transmissions : canal, destinataire, statut (préparé / envoyé / échec / imprimé), horodatage FR
    stats.js             tableau de bord, board mensuel, historiques filtrés
    settings.js          paramètres en cache mémoire (lus des dizaines de fois par requête), jeu de données initial
    backup.js            sauvegardes pg_dump datées, purge, vérification pg_restore
  routes/                dashboard, units, tenants, payments, month (Quittances du mois), receipts, print, calendar, settings, export, api, auth, pwa (manifeste, service worker, page hors ligne — avant la session)
  views/                 EJS (mise en page, partiel imprimable receipt-doc.ejs, pages month/index et month/recap, fiche quittances/show avec actions de partage et historique des transmissions, partials/pwa-head.ejs pour les métadonnées d'installation)
  public/                CSS écran + impression, JS vanilla (app.js, pwa.js), vendor Tailwind et Lucide, et les ressources de la PWA (§6) : manifest.webmanifest, sw.js, hors-ligne.html, icons/, splash/
  utils/format.js        FCFA, dates et périodes FR, montants en toutes lettres
  utils/router.js        enveloppe les gestionnaires : Express 4 n'attend pas les fonctions async
  utils/params.js        identifiants lus dans l'URL, ramenés à 0 quand ils ne sont pas numériques
tests/                   node:test + helpers (base PostgreSQL isolée créée et supprimée par fichier)
scripts/                 smoke.js, stress-print.js, backup.js, migrate-to-postgres.js (import SQLite → PostgreSQL, driver chargé à la demande), generate-pwa-assets.js (icônes et écrans de démarrage), purge-demo.js
data/                    sauvegardes, signatures (hors service), archive SQLite en lecture seule
Dockerfile               image de production : Node + Chromium + postgresql-client, donc PDF et sauvegardes possibles en ligne (§11)
render.yaml              blueprint Render : service web + base PostgreSQL — aucun secret dans le fichier
.dockerignore            node_modules, .env, data/, tests : rien de personnel ne part dans l'image
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
jamais réutilisés) · `sessions` (cookie de session serveur : identifiant, données,
échéance) · `migrations` (fichiers déjà appliqués).

Contraintes notables : `UNIQUE(floor_id, name)`, `CHECK` sur les statuts et les
modes de paiement, index sur les périodes et les locataires, un index unique
partiel `uq_tenancies_open_unit` qui empêche deux locations ouvertes sur un même
logement, et les index partiels `uq_receipts_full_period` /
`uq_receipts_avis_period` qui interdisent deux quittances intégrales (ou deux
avis) actifs pour la même location et la même période — la base refuse, l'application
traduit l'erreur en message clair.

### Migration depuis SQLite (réalisée)

L'application tourne désormais **uniquement** sur PostgreSQL. L'ancienne base
`data/rent.sqlite` (avec son journal `-wal`) a été importée puis archivée sous
`data/rent.sqlite.archived` ; elle n'est plus ouverte par l'application, seulement
par le script d'import.

```bash
npm run migrate:postgres                        # data/rent.sqlite → DATABASE_URL
node scripts/migrate-to-postgres.js --from chemin/archive.sqlite [--force]
```

Le script lit une **copie cohérente** de l'archive (le journal WAL peut contenir
les dernières lignes), vide la destination dans une **seule transaction**
(`TRUNCATE … RESTART IDENTITY CASCADE`), réinjecte les identifiants d'origine — les
clés étrangères sont donc reconstituées à l'identique — puis compare le nombre de
lignes **table par table** avant d'archiver l'archive. Si les comptes diffèrent,
rien n'est renommé et le script sort en erreur. `--force` est nécessaire quand la
destination contient déjà des locataires.

Conversions appliquées : `AUTOINCREMENT` → `BIGINT GENERATED BY DEFAULT AS IDENTITY`
(l'import garde les numéros d'origine), `snapshot` TEXT → **JSONB**, `cancelled`
INTEGER → **BOOLEAN**, `COLLATE NOCASE` → `lower(…)`, `LIKE` → `ILIKE`, compteurs
de numérotation relu par une requête atomique `INSERT … ON CONFLICT … RETURNING`.
Les dates sont relues en chaînes `AAAA-MM-JJ [HH:MM:SS]` pour que le formatage
français reste identique, et `INT8`/`NUMERIC` sont convertis en nombres : les
montants FCFA continuent de voyager comme des entiers. Les sessions, stockées en
mémoire avec SQLite, vivent maintenant dans la table `sessions` (migration 004) :
la déconnexion d'un navigateur et un redémarrage du serveur ne se dessaisissent
plus, et les sessions expirées sont purgées au démarrage.

---

## 10. Dépannage

| Symptôme | Solution |
| --- | --- |
| `npm start` : « Cannot find module 'express-session' » | `npm install` (les dépendances manquaient) |
| « Démarrage impossible : Base de données injoignable » | PostgreSQL n'est pas lancé (`sudo systemctl start postgresql`), ou `DATABASE_URL` est faux — vérifier hôte, port, base et encodage du mot de passe |
| « FATAL: la base de données « … » n'existe pas » | créer la base : `createdb -U <rôle> quittances`, ou l'import : `npm run migrate:postgres` |
| « permission refusée pour création d'une base » lors de `npm test` | le rôle doit avoir `CREATEDB` : `ALTER ROLE <rôle> CREATEDB;` |
| Les pages ne se rafraîchissent pas en développement | lancer avec `NODE_ENV=development` (sinon le cache des vues EJS reste actif) |
| « Session expirée » sur un formulaire | le jeton CSRF a expiré : recharger la page |
| Port 3000 occupé | `PORT=3100 npm start` |
| Trois quittances ne tiennent pas sur la feuille | vérifier marges/A4/échelle 100 % dans la boîte d'impression |
| Bouton « Télécharger le PDF » grisé | aucun Chromium/Chrome détecté : `sudo apt install -y chromium-browser`, ou indiquer le binaire dans `CHROME_PATH` (`PDF_ENGINE=none` pour le désactiver assumément). L'impression du navigateur reste disponible et produit le même PDF |
| « Aucun service SMTP n'est configuré » | normal sans `SMTP_*` : l'application propose un brouillon `mailto:` ou le PDF, et journalise « Préparé ». Renseigner `.env` puis redémarrer pour l'envoi réel |
| Un e-mail est « Envoyé » mais le locataire ne l'a pas reçu | vérifier le destinataire dans l'historique des transmissions ; le serveur a pu accepter puis refuser (rejet enregistré comme « Échec » avec le message du serveur) |
| Le document reste « Préparé » après l'ouverture de WhatsApp | c'est le comportement attendu : wa.me n'envoie rien. Joindre le PDF puis confirmer avec « J'ai envoyé le message » |
| Aucun bouton « Installer l'application » (PWA) | le navigateur ne remet pas d'invite (Firefox, Safari macOS, iOS) ou l'application est déjà installée — la page Paramètres indique lequel de ces cas s'applique et la marche à suivre ; hors `localhost`, HTTPS est exigé |
| « Serveur de l'application injoignable » alors que l'application était ouverte | le poste qui exécute Node.js est éteint ou le service est arrêté (`pm2 restart quittances`) : l'interface est en cache, **les données non** — les recharger après redémarrage |
| L'interface semble rester une version périmée après redéploiement | incrémenter `VERSION` dans `src/public/sw.js`, puis valider le bandeau « Mettre à jour » ; en dernier recours, DevTools → Application → Service workers → Unregister |
| Icône ou écran de démarrage absent après modification du logo | `npm run pwa:assets` (Chrome/Chromium doit être installé), puis recharger l'onglet |
| Message d'erreur PostgreSQL affiché en français | normal : le cluster a `lc_messages = fr_FR`. Les messages affichés à l'écran viennent de l'application, l'erreur brute n'est jamais montrée telle quelle |
| Emplacement de signature introuvable après restauration | `data/signatures/` n'est pas dans l'archive PostgreSQL : le copier séparément |
| Build Render interrompu sur « better-sqlite3 » et `node-gyp rebuild` | ce module natif n'est plus une dépendance du projet : pousser le correctif (package.json + package-lock.json) et relancer le déploiement |
| « Télécharger le PDF » grisé sur Render | le déployé ne vient pas du `Dockerfile` actuel (il installe Chromium) : relancer un build, et vérifier `CHROME_PATH` dans les variables du service |
| Signature rechargeable perdue après un redéploiement sur Render | le dossier `data/` du conteneur est jetable : monter un volume sur `/app/data`, ou recharger la signature dans Paramètres (§11) |
| Déconnexion fréquente ou cookie non marqué `Secure` derrière Render | poser `TRUST_PROXY=1` : Render termine le HTTPS et l'application doit le savoir |
| « The server does not support SSL connections » au démarrage sur Render | la base a été renseignée avec une chaîne externe sans `?sslmode=require` (ou l'inverse) : prendre la chaîne **interne** de la base, `DATABASE_URL` fournie par le blueprint |

## 11. Mise en ligne sur Render

`render.yaml` (blueprint) et `Dockerfile` sont dans le dépôt. L'image contient Node,
**Chromium** et **postgresql-client** : le téléchargement PDF et le bouton
« Sauvegarder la base » fonctionnent en ligne exactement comme en local.
`better-sqlite3` a été retiré des dépendances — c'est un module natif qui ne se
compile plus sur les Node récents, et il ne servait qu'à l'import SQLite déjà effectué.

### Déployer avec le blueprint

1. Pousser le projet sur GitHub (l'application n'y envoie jamais rien : `.env` et
   `data/` sont hors de git).
2. Render → **New → Blueprint** → choisir le dépôt → Render lit `render.yaml`
   et propose deux ressources : le service web (image) et la base `quittances-db`.
3. Saisir **ADMIN_PASSWORD** (et les variables `SMTP_*` seulement si tu veux des
   envois réels). `SESSION_SECRET` est généré par Render, `DATABASE_URL` est
   injecté automatiquement depuis la base créée.
4. **Create** : le premier démarrage applique les migrations, les 3 étages, les
   types de logement, les tarifs, les paramètres et le compte administrateur.

Coût indicatif : service **Starter** + base **Starter** (l'exécution d'une image
n'est pas éligible au plan gratuit ; une base gratuite Render est supprimée au
bout de 30 jours).

### Ou configurer à la main

| Réglage | Valeur |
| --- | --- |
| Runtime | **Docker** (Image), `Dockerfile` à la racine |
| Health check path | `/login` |
| `DATABASE_URL` | chaîne **interne** de la base Render PostgreSQL |
| `TRUST_PROXY` | `1` — Render termine le HTTPS ; sans ceci le cookie de session n'est jamais marqué `Secure` |
| `SESSION_SECRET` | une longue chaîne aléatoire (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | le compte créé au premier démarrage |
| `CHROME_PATH`, `PDF_NO_SANDBOX` | déjà posés dans le `Dockerfile` |

`PORT` est fourni par Render et lu par l'application ; ne pas le figer.

### Ce qui est hébergé, et ce qui ne l'est pas

- La base Render démarre **vide** : aucun locataire, paiement ni quittance de ton
  poste local n'est transféré. Ce sont deux carnets distincts ; si un jour tu veux
  basculer les données réelles, c'est `pg_dump` ici, `pg_restore` là-bas — et les
  données personnelles des locataires quittent alors ta machine.
- **Signature scannée et dumps de sauvegarde** vivent dans `data/`, donc dans le
  conteneur : un redéploiement les efface. Deux parades :
  - Dashboard → service → **Volumes** → monter un volume sur `/app/data`
    (les volumes d'un service à image ne se déclarent pas dans `render.yaml`) ;
  - ou recharger la signature dans **Paramètres** après chaque mise en ligne.
  Dans les deux cas, l'application n'imprime jamais un cachet ou une signature
  absent : le document reste correct, simplement sans signature.
- Les sauvegardes cliquées dans l'interface se téléchargent depuis la page
  Paramètres : garde le fichier `.dump` **hors** de Render. Côté serveur, les
  base Render sont snapshotées automatiquement (rétention selon le plan).

### Après une mise en ligne

Ouvrir `https://<service>.onrender.com`, puis vérifier : connexion admin, tableau
de bord, génération d'un mois, téléchargement PDF (le bouton doit être actif),
impression A4, et l'installation PWA — Chrome sur Ubuntu, et **ajouter à l'écran
d'accueil** sur Android. HTTPS y est natif, donc le bandeau « Installer
l'application » apparaît, contrairement à `http://localhost` du poste.

`git push` redéploie automatiquement. Pense à incrémenter `VERSION` dans
`src/public/sw.js` quand la coquille change, sinon les appareils déjà installés
gardent l'ancienne interface jusqu'au bandeau « Mettre à jour ».

---

## Licence

Usage privé de gestion locative — non publié (`UNLICENSED`).
