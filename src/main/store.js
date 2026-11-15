const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

// Identifiants d'application, profils et jetons, chiffrés par Windows (DPAPI) pour le compte courant.
// Forme : {
//   youtube: { config: {...} }, ...                 identifiants d'application, communs aux profils
//   profiles: { list: [{ id, name }], active: id }
//   accounts: { [profil]: { youtube: { tokens, account }, ... } }
//   assistant: { config: {...} }
// }
const file = () => path.join(app.getPath('userData'), 'comptes.dat');

function read() {
  let raw;
  try {
    raw = fs.readFileSync(file());
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(safeStorage.decryptString(raw));
}

function write(data) {
  fs.writeFileSync(file(), safeStorage.encryptString(JSON.stringify(data)));
}

const newId = () => crypto.randomBytes(4).toString('hex');

// Avant les profils, les jetons étaient rangés avec les identifiants de chaque plateforme :
// ils deviennent ceux d'un premier profil, nommé d'après la chaîne YouTube s'il y en a une.
function load() {
  const data = read();
  if (data.profiles) return data;
  const id = newId();
  const name = (data.youtube && data.youtube.account) || 'Mon profil';
  data.profiles = { list: [{ id, name }], active: id };
  data.accounts = { [id]: {} };
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object' || !('tokens' in value || 'account' in value)) continue;
    const { tokens, account, ...rest } = value;
    if (tokens) data.accounts[id][key] = { tokens, account };
    data[key] = rest;
  }
  write(data);
  return data;
}

function update(platform, patch) {
  const data = load();
  data[platform] = { ...data[platform], ...patch };
  write(data);
  return data[platform];
}

// Compte d'une plateforme dans un profil (l'actif par défaut) : { tokens, account }.
function account(platform, profile) {
  const data = load();
  const accounts = data.accounts[profile || data.profiles.active] || {};
  return accounts[platform] || {};
}

function setAccount(platform, patch, profile) {
  const data = load();
  const id = profile || data.profiles.active;
  const accounts = (data.accounts[id] = data.accounts[id] || {});
  accounts[platform] = { ...accounts[platform], ...patch };
  write(data);
}

// Oublie les comptes d'une plateforme dans tous les profils : ses identifiants ont changé.
function forget(platform) {
  const data = load();
  for (const accounts of Object.values(data.accounts)) delete accounts[platform];
  write(data);
}

const profiles = () => load().profiles;

function cleanName(name) {
  const clean = (name || '').trim();
  if (!clean) throw new Error('Donne un nom au profil.');
  if (clean.length > 40) throw new Error('Le nom du profil fait 40 caractères au plus.');
  return clean;
}

function addProfile(name) {
  const data = load();
  const id = newId();
  data.profiles.list.push({ id, name: cleanName(name) });
  data.profiles.active = id;
  data.accounts[id] = {};
  write(data);
}

function renameProfile(id, name) {
  const data = load();
  const profile = data.profiles.list.find((p) => p.id === id);
  if (!profile) throw new Error('Profil introuvable.');
  profile.name = cleanName(name);
  write(data);
}

function removeProfile(id) {
  const data = load();
  if (data.profiles.list.length < 2) throw new Error('Il faut garder au moins un profil.');
  data.profiles.list = data.profiles.list.filter((p) => p.id !== id);
  delete data.accounts[id];
  if (data.profiles.active === id) data.profiles.active = data.profiles.list[0].id;
  write(data);
}

function useProfile(id) {
  const data = load();
  if (!data.profiles.list.some((p) => p.id === id)) throw new Error('Profil introuvable.');
  data.profiles.active = id;
  write(data);
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

module.exports = { load, update, account, setAccount, forget, profiles, addProfile, renameProfile, removeProfile, useProfile, seed };
