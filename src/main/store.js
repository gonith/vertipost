const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

// Identifiants d'application et jetons, chiffrés par Windows (DPAPI) pour le compte courant.
// Forme : { youtube: { config: {...}, tokens: {...}, account: 'nom affiché' }, ... }
const file = () => path.join(app.getPath('userData'), 'comptes.dat');

function load() {
  let raw;
  try {
    raw = fs.readFileSync(file());
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(safeStorage.decryptString(raw));
}

function update(platform, patch) {
  const data = load();
  data[platform] = { ...data[platform], ...patch };
  fs.writeFileSync(file(), safeStorage.encryptString(JSON.stringify(data)));
  return data[platform];
}

module.exports = { load, update };
