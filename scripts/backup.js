'use strict';

// Sauvegarde manuelle : npm run backup
const { createBackup, listBackups } = require('../src/services/backup');

(async () => {
  const file = await createBackup();
  console.log(`Sauvegarde créée : ${file}`);
  console.log(`Sauvegardes conservées : ${listBackups().length}`);
})().catch(e => {
  console.error(`Sauvegarde impossible : ${e.message}`);
  process.exitCode = 1;
});
