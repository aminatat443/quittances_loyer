# Image de production : l'application a besoin de deux programmes système en plus
# de Node — Chromium (téléchargement PDF des quittances) et pg_dump (sauvegardes).
FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         chromium \
         postgresql-client \
         fonts-liberation \
         ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium \
    PDF_NO_SANDBOX=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# Les fichiers d'identité (nom, cachet, signature scannée) vivent dans data/ et ne
# sont pas dans le dépôt : un volume monté sur /app/data les fait survivre aux
# redéploiements. Sans volume, ils sont à recharger après chaque mise en ligne.
RUN mkdir -p /app/data/signatures /app/data/backups /app/data/exports

EXPOSE 10000
CMD ["node", "src/app.js"]
