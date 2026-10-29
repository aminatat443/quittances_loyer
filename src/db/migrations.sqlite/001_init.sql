-- Structure principale de l'application de gestion locative

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE floors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE,
  short_label TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE unit_types (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  default_rent INTEGER NOT NULL CHECK (default_rent >= 0),
  position INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  departure_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_id INTEGER NOT NULL REFERENCES floors(id),
  unit_type_code TEXT NOT NULL REFERENCES unit_types(code),
  name TEXT NOT NULL,
  default_rent INTEGER NOT NULL CHECK (default_rent >= 0),
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('occupied', 'available', 'unavailable')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (floor_id, name)
);

CREATE INDEX idx_units_floor ON units (floor_id);

-- Historique d'occupation : un locataire peut occuper plusieurs logements,
-- un logement peut accueillir plusieurs locataires successifs.
CREATE TABLE tenancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  start_date TEXT NOT NULL,
  end_date TEXT,
  monthly_rent INTEGER NOT NULL CHECK (monthly_rent >= 0),
  -- instantané au moment de l'entrée
  unit_name TEXT NOT NULL DEFAULT '',
  floor_label TEXT NOT NULL DEFAULT '',
  unit_type_label TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_tenancies_tenant ON tenancies (tenant_id);
CREATE INDEX idx_tenancies_unit ON tenancies (unit_id);
CREATE UNIQUE INDEX uq_tenancies_open_unit ON tenancies (unit_id) WHERE end_date IS NULL;

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenancy_id INTEGER NOT NULL REFERENCES tenancies(id),
  period_year INTEGER NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  expected_amount INTEGER NOT NULL CHECK (expected_amount >= 0),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  paid_at TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'especes' CHECK (method IN ('especes', 'wave', 'orange_money', 'virement')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_payments_period ON payments (tenancy_id, period_year, period_month);

CREATE TABLE receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('quittance', 'recu_partiel', 'quittance_definitive')),
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
  -- instantané fige à l'émission, pour réimpression fidèle
  snapshot TEXT NOT NULL DEFAULT '{}',
  cancelled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_receipts_period ON receipts (tenancy_id, period_year, period_month);

-- Compteur de numérotation par année (numéros jamais réutilisés)
CREATE TABLE receipt_sequences (
  year INTEGER PRIMARY KEY,
  last_value INTEGER NOT NULL DEFAULT 0
);
