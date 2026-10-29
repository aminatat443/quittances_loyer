'use strict';

/**
 * Côté navigateur de la PWA : enregistrement du service worker, bandeau de mise à
 * jour, indicateur hors ligne et bouton « Installer l'application ».
 *
 * Deux règles commandent le code :
 *  - aucune donnée métier n'est prétendument disponible hors ligne ; les loyers
 *    restent sur le serveur Node.js + PostgreSQL, ce script ne dit jamais autre chose ;
 *  - aucun faux bouton : on ne propose « Installer » que si le navigateur remet une
 *    vraie invite d'installation, sinon on explique la marche à suivre sur ce navigateur.
 */
(function () {
  const SECURE = window.isSecureContext;              // https, ou localhost en développement
  const STANDALONE = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || (window.matchMedia && window.matchMedia('(display-mode: window-controls-overlay)').matches)
    || window.navigator.standalone === true;          // iOS
  const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const ANDROID = /Android/.test(navigator.userAgent);

  let deferredPrompt = null;

  /* ---------------------------------------------------------------- installation */

  function installTargets() {
    return Array.from(document.querySelectorAll('[data-pwa-install]'));
  }

  function render(state, detail) {
    const copy = {
      installable: { button: 'Installer l\'application', hint: 'L\'application ouvrira sa propre fenêtre, sans barre d\'adresse, avec son icône sur le bureau ou l\'écran d\'accueil.' },
      installing: { button: null, hint: 'Installation lancée par le navigateur. L\'icône « Loyers » apparaît sur votre poste.' },
      installed: { button: null, hint: 'Application déjà installée sur cet appareil : lancez-la depuis son icône.' },
      dismissed: { button: null, hint: 'Installation annulée. Le navigateur ne remet pas l\'invite deux fois dans une session : rechargez la page, ou installez depuis son menu ⋮.' },
      ios: { button: null, hint: 'Sur iPhone ou iPad : ouvrez le menu de partage de Safari (icône carrée avec flèche vers le haut), puis « Sur l\'écran d\'accueil ».' },
      android: { button: null, hint: 'Ce navigateur ne transmet pas d\'invite d\'installation : menu ⋮ du navigateur, puis « Ajouter à l\'écran d\'accueil ».' },
      unsupported: { button: null, hint: 'Ce navigateur ne propose pas l\'installation d\'applications web. Utilisez Chrome ou Edge pour garder l\'interface hors ligne en cache.' },
      chromium: { button: null, hint: 'Le navigateur ne remet pas son invite pour l\'instant : installez depuis l\'icône dédiée de la barre d\'adresse, ou menu ⋮ → « Installer l\'application… ». Rechargez la page si rien n\'apparaît.' },
      insecure: { button: null, hint: 'L\'installation exige HTTPS. En local, http://localhost est accepté ; sur un autre poste, servez l\'application derrière un certificat.' },
    }[state] || {};
    const hint = detail || copy.hint || '';

    installTargets().forEach((zone) => {
      const button = zone.querySelector('[data-pwa-button]');
      const text = zone.querySelector('[data-pwa-hint]');
      if (button) {
        button.hidden = !copy.button;
        // Le libellé vit dans une span pour que l'icône Lucide du bouton survive.
        (button.querySelector('[data-pwa-label]') || button).textContent = copy.button || '';
        zone.dataset.pwaState = state;
      }
      if (text) text.textContent = hint;
      // Dans le menu latéral, seul le bouton a sa place ; la page Paramètres garde
      // l'explication en toutes circonstances, y compris « ce navigateur ne peut pas ».
      if (zone.hasAttribute('data-pwa-menu')) zone.hidden = !copy.button;
      else zone.hidden = false;
    });
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    render('installable');
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    render('installed');
  });

  async function promptInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (choice.outcome === 'accepted') {
      render('installing');
    } else {
      render('dismissed');
    }
  }

  document.addEventListener('click', (event) => {
    const zone = event.target && event.target.closest
      ? event.target.closest('[data-pwa-button]') : null;
    if (zone) {
      event.preventDefault();
      promptInstall();
    }
  });

  function describePlatform() {
    if (!SECURE) return 'insecure';
    if (STANDALONE) return 'installed';
    if (IOS) return 'ios';
    if (ANDROID) return 'android';
    // Chrome/Edge savent installer sans remettre d'invite programmable : le dire
    // exactement, plutôt que de prétendre qu'ils ne le peuvent pas.
    if (window.chrome || /Edg\//.test(navigator.userAgent)) return 'chromium';
    return 'unsupported';
  }

  /* ------------------------------------------------------------ service worker */

  let updateReady = false;
  let registration = null;

  function showUpdateBanner() {
    if (document.getElementById('pwa-update') || !updateReady) return;
    const bar = document.createElement('div');
    bar.id = 'pwa-update';
    bar.className = 'no-print fixed bottom-4 left-1/2 -translate-x-1/2 z-50 card px-4 py-3 flex items-center gap-3 shadow-card';
    bar.innerHTML = '<span class="text-sm">Nouvelle version de l\'application disponible.</span>'
      + '<button type="button" class="btn btn-primary">Mettre à jour</button>';
    document.body.appendChild(bar);
    bar.querySelector('button').addEventListener('click', () => {
      const worker = registration && (registration.waiting || registration.installing);
      if (worker) worker.postMessage('skip-waiting');
    });
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Un seul rechargement, déclenché par la volonté explicite de l'utilisateur.
      if (window.__pwaReloading) return;
      window.__pwaReloading = true;
      window.location.reload();
    });
  }

  async function registerServiceWorker() {
    if (!SECURE || !('serviceWorker' in navigator)) return;
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (err) {
      return;                                       // pas de cache : l'application reste utilisable en ligne
    }
    updateReady = !!registration.waiting;
    if (updateReady) showUpdateBanner();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          updateReady = true;
          showUpdateBanner();
        }
      });
    });
    // Après un redéploiement, un onglet laissé ouvert récupère la nouvelle version
    // dès qu'on lui rend l'attention.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) registration.update().catch(() => {});
    });
  }

  /* --------------------------------------------------------- indicateur hors ligne */

  let bannerEl = null;

  function showOfflineBar(online) {
    if (online && !bannerEl) return;                 // rien à afficher tant que rien ne manque
    if (!bannerEl) {
      bannerEl = document.createElement('div');
      bannerEl.id = 'pwa-hors-ligne';
      document.body.appendChild(bannerEl);
    }
    bannerEl.hidden = online;
    bannerEl.className = 'no-print fixed bottom-0 inset-x-0 z-40 px-4 py-2 text-sm text-center '
      + 'bg-amber-100 text-amber-900 border-t border-amber-200';
    bannerEl.textContent = 'Hors ligne : l\'interface reste ouverte, mais les locataires, paiements '
      + 'et quittances sont sur le serveur de l\'application et ne s\'afficheront qu\'à la reconnexion.';
  }

  window.addEventListener('offline', () => showOfflineBar(false));
  window.addEventListener('online', () => showOfflineBar(true));

  /* ---------------------------------------------------------------- démarrage */

  document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    render(describePlatform());
    if (!navigator.onLine) showOfflineBar(false);
  });
})();
