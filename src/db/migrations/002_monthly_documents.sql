-- Documents mensuels en un clic : avis de loyer, e-mail du locataire,
-- et contrainte d'unicité empêchant deux quittances intégrales pour une même période.

ALTER TABLE tenants ADD COLUMN email TEXT NOT NULL DEFAULT '';

-- PostgreSQL autorise l'élargissement de la contrainte sans reconstruire la table.
ALTER TABLE receipts DROP CONSTRAINT receipts_type_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_type_check
  CHECK (type IN ('quittance', 'recu_partiel', 'quittance_definitive', 'avis_loyer'));

-- Une seule quittance intégrale active par location et par période :
-- la protection contre les doublons n'est plus seulement applicative.
CREATE UNIQUE INDEX uq_receipts_full_period
  ON receipts (tenancy_id, period_year, period_month)
  WHERE cancelled = FALSE AND type IN ('quittance', 'quittance_definitive');

-- Un seul avis de loyer actif par période (il est remplacé, pas dupliqué).
CREATE UNIQUE INDEX uq_receipts_avis_period
  ON receipts (tenancy_id, period_year, period_month)
  WHERE cancelled = FALSE AND type = 'avis_loyer';
