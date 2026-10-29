-- Documents mensuels en un clic : avis de loyer, e-mail du locataire,
-- et contrainte d'unicité empêchant deux quittances intégrales pour une même période.

ALTER TABLE tenants ADD COLUMN email TEXT NOT NULL DEFAULT '';

-- SQLite ne permet pas d'élargir une contrainte CHECK : on reconstruit la table.
CREATE TABLE receipts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('quittance', 'recu_partiel', 'quittance_definitive', 'avis_loyer')),
  tenancy_id INTEGER NOT NULL REFERENCES tenancies(id),
  period_year INTEGER NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  amount_this INTEGER NOT NULL DEFAULT 0 CHECK (amount_this >= 0),
  total_paid INTEGER NOT NULL DEFAULT 0 CHECK (total_paid >= 0),
  expected INTEGER NOT NULL DEFAULT 0 CHECK (expected >= 0),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  payment_date TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'especes',
  observations TEXT NOT NULL DEFAULT '',
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  issued_place TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  cancelled INTEGER NOT NULL DEFAULT 0
);

INSERT INTO receipts_new SELECT * FROM receipts;
DROP TABLE receipts;
ALTER TABLE receipts_new RENAME TO receipts;

CREATE INDEX idx_receipts_period ON receipts (tenancy_id, period_year, period_month);

-- Une seule quittance intégrale active par location et par période :
-- la protection contre les doublons n'est plus seulement applicative.
CREATE UNIQUE INDEX uq_receipts_full_period
  ON receipts (tenancy_id, period_year, period_month)
  WHERE cancelled = 0 AND type IN ('quittance', 'quittance_definitive');

-- Un seul avis de loyer actif par période (il est remplacé, pas dupliqué).
CREATE UNIQUE INDEX uq_receipts_avis_period
  ON receipts (tenancy_id, period_year, period_month)
  WHERE cancelled = 0 AND type = 'avis_loyer';
