'use strict';

/**
 * Identifiant lu dans l'URL. PostgreSQL refuserait « /quittances/abc » par une erreur
 * de type (500) là où l'ancienne base ne trouvait simplement aucune ligne : la valeur
 * est donc ramenée à 0, qui ne désigne aucun enregistrement — les routes renvoient
 * leur 404 et aucune écriture ne correspond à cet identifiant.
 */
function idOf(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

module.exports = { idOf };
