-- Sessions serveur stockées dans PostgreSQL : l'application ne dépend plus d'un
-- fichier SQLite, et un redémarrage ne déconnecte plus les utilisateurs.

CREATE TABLE sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires BIGINT NOT NULL
);

CREATE INDEX idx_sessions_expires ON sessions (expires);
