-- Historique des transmissions : chaque partage préparé, envoyé, imprimé ou
-- rejeté est tracé rattaché au document, sans jamais modifier le document lui-même.

CREATE TABLE receipt_transmissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email', 'print', 'pdf')),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'sent', 'failed', 'printed')),
  recipient TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX idx_transmissions_receipt
  ON receipt_transmissions (receipt_id, created_at DESC);
