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

// Identifiants d'application fournis avec l'installateur (preset.json, hors du dépôt), pour qu'un
// proche n'ait pas à les saisir. Ne remplit qu'une plateforme encore vide : une configuration
// existante n'est jamais remplacée.
function seed() {
  const where = app.isPackaged ? process.resourcesPath : app.getAppPath();
  let preset;
  try {
    preset = JSON.parse(fs.readFileSync(path.join(where, 'preset.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('preset.json illisible :', e.message);
    return;
  }
  const data = load();
  for (const [platform, config] of Object.entries(preset)) {
    const filled = Object.fromEntries(Object.entries(config || {}).filter(([, v]) => typeof v === 'string' && v.trim()));
    if (!Object.keys(filled).length || data[platform]?.config?.clientId) continue;
    update(platform, { config: { ...data[platform]?.config, ...filled } });
  }
}

module.exports = { load, update, seed };
