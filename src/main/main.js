const path = require('path');
const tls = require('tls');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const store = require('./store');
const platforms = require('./platforms');
const { inspect, thumbnail } = require('./video');
const { warnings, captionFor } = require('./lib/rules');
const { CATEGORIES, DEFAULT_CATEGORY } = require('./lib/advice');
const assistant = require('./assistant');
const { checklist, keywordsOf } = require('./lib/score');
const { LIMITS } = require('./lib/rules');

// Node ne lit pas le magasin de certificats de Windows. Sur un poste où un antivirus
// re-signe le HTTPS (Avast, Kaspersky...), toutes les requêtes échoueraient en
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. On ajoute donc les autorités du système à celles de Node.
function trustSystemCertificates() {
  if (!tls.getCACertificates || !tls.setDefaultCACertificates) return;
  const all = new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  tls.setDefaultCACertificates([...all]);
}

function platform(id) {
  const found = platforms.find((p) => p.id === id);
  if (!found) throw new Error(`Plateforme inconnue : ${id}`);
  return found;
}

// Identifiants d'application d'une plateforme : Facebook reprend ceux d'Instagram.
const configOf = (p, data = store.load()) => (data[p.configFrom || p.id] || {}).config || {};

// Ce que l'interface a le droit de voir : jamais un secret ni un jeton. Les comptes sont ceux
// du profil actif.
function describe() {
  const data = store.load();
  const accounts = data.accounts[data.profiles.active] || {};
  return platforms.map((p) => {
    const saved = accounts[p.id] || {};
    const config = configOf(p, data);
    return {
      id: p.id,
      name: p.name,
      redirectUri: p.redirectUri,
      configFrom: p.configFrom || null,
      consoleUrl: p.consoleUrl,
      help: p.help,
      fields: p.fields.map((f) => ({
        ...f,
        value: f.secret ? '' : config[f.key] || '',
        filled: Boolean(config[f.key]),
      })),
      configured: p.fields.every((f) => f.optional || config[f.key]),
      // Un mode assisté n'a pas de compte à connecter : la plateforme est prête telle quelle.
      assisted: Boolean(p.assisted && p.assisted(config)),
      connected: Boolean(saved.tokens) || Boolean(p.assisted && p.assisted(config)),
      account: saved.account || null,
    };
  });
}

function saveConfig(id, values) {
  const p = platform(id);
  if (p.configFrom) return saveConfig(p.configFrom, values);
  const saved = store.load()[id] || {};
  const config = { ...saved.config };
  for (const field of p.fields) {
    const value = (values[field.key] || '').trim();
    // Un champ secret laissé vide veut dire « ne change rien » : l'interface ne le réaffiche pas.
    if (value || !field.secret) config[field.key] = value;
  }
  store.update(id, { config });
  // Une autre application rend caducs les comptes connectés avec l'ancienne, dans tous les profils.
  if (!saved.config || saved.config.clientId !== config.clientId) {
    for (const q of platforms) if ((q.configFrom || q.id) === id) store.forget(q.id);
  }
}

const assistantConfig = () => (store.load().assistant || {}).config || {};

function describeAssistant() {
  const config = assistantConfig();
  return {
    ...assistant.settings,
    fields: assistant.settings.fields.map((f) => ({
      ...f,
      value: f.secret ? '' : config[f.key] || '',
      filled: Boolean(config[f.key]),
    })),
    configured: assistant.configured(config),
  };
}

function saveAssistant(values) {
  const config = { ...assistantConfig() };
  for (const field of assistant.settings.fields) {
    const value = (values[field.key] || '').trim();
    if (value || !field.secret) config[field.key] = value;
  }
  store.update('assistant', { config });
}

async function advise(input) {
  const config = assistantConfig();
  if (!assistant.configured(config)) throw new Error("Renseigne d'abord la clé API de l'assistant.");
  if (!(input.brief || '').trim()) throw new Error("Décris d'abord ta vidéo.");
  return assistant.advise(config, input);
}

// Quand une connexion autorise plusieurs comptes (des Pages, des comptes Instagram), l'utilisateur
// choisit celui du profil.
function chooser(win) {
  return async (message, labels) => {
    const { response } = await dialog.showMessageBox(win, { type: 'question', message, buttons: [...labels, 'Annuler'], cancelId: labels.length, noLink: true });
    if (response === labels.length) throw new Error('Connexion annulée.');
    return response;
  };
}

async function connect(win, id) {
  const p = platform(id);
  const config = configOf(p);
  if (!config.clientId) throw new Error("Renseigne d'abord les identifiants de l'application.");
  const profile = store.profiles().active;
  const { tokens, account } = await p.connect(config, { choose: chooser(win) });
  store.setAccount(id, { tokens, account }, profile);
}

async function publish(sender, { filePath, post, targets }) {
  const video = await inspect(filePath);
  const profile = store.profiles().active;
  const one = async (id) => {
    const p = platform(id);
    const ctx = context(id, profile);
    if (!ctx.tokens && !(p.assisted && p.assisted(ctx.config))) throw new Error('Compte non connecté.');
    return p.publish({
      ...ctx,
      video,
      post,
      caption: captionFor(id, post),
      progress: (phase, fraction) => sender.send('progress', { id, phase, fraction }),
    });
  };
  // Une plateforme qui échoue ne doit pas retenir les autres.
  const settled = await Promise.allSettled(targets.map(one));
  return targets.map((id, i) =>
    settled[i].status === 'fulfilled'
      ? { id, ok: true, ...settled[i].value }
      : { id, ok: false, error: settled[i].reason.message },
  );
}

// Une plateforme en panne ou déconnectée ne doit pas masquer les statistiques des autres.
function stats() {
  const profile = store.profiles().active;
  return Promise.all(
    platforms.map(async (p) => {
      const ctx = context(p.id, profile);
      const base = { id: p.id, name: p.name, rows: [], note: null, error: null };
      if (!p.stats) return { ...base, note: "Vertipost n'a pas accès aux statistiques de cette plateforme : consulte-les dans son application." };
      if (!ctx.tokens) return { ...base, note: 'Compte non connecté.' };
      try {
        return { ...base, ...(await p.stats(ctx)) };
      } catch (e) {
        return { ...base, error: e.message };
      }
    }),
  );
}

// Ce qu'une plateforme reçoit pour agir sur le compte d'un profil. Le profil est fixé au départ :
// un jeton renouvelé en cours de route revient au bon profil même si l'utilisateur en a changé.
function context(id, profile) {
  return {
    config: configOf(platform(id)),
    tokens: store.account(id, profile).tokens,
    saveTokens: (tokens) => store.setAccount(id, { tokens }, profile),
  };
}

// L'analyse part des statistiques affichées, complétées par une recherche YouTube dans la niche
// quand la chaîne est connectée et que des mots-clés sont renseignés.
async function review({ keywords, language }) {
  const config = assistantConfig();
  if (!assistant.configured(config)) throw new Error("Renseigne d'abord la clé API de l'assistant, dans l'onglet Paramètres.");
  const own = await stats();
  if (!own.some((p) => p.rows.length)) throw new Error("Aucune vidéo à analyser : connecte YouTube ou Instagram.");
  const youtube = context('youtube', store.profiles().active);
  const words = keywordsOf(keywords);
  const niche = youtube.tokens && words.length ? await platform('youtube').niche(youtube, words) : [];
  return assistant.review(config, { own, niche, keywords, language });
}

function retitle(id, title) {
  const youtube = context('youtube', store.profiles().active);
  if (!youtube.tokens) throw new Error('Compte non connecté.');
  const clean = (title || '').trim();
  if (!clean || clean.length > LIMITS.youtube.title) throw new Error(`Le titre doit faire entre 1 et ${LIMITS.youtube.title} caractères.`);
  return platform('youtube').retitle(youtube, id, clean);
}

// Une erreur levée dans un gestionnaire arrive côté interface préfixée par Electron
// (« Error invoking remote method... ») : on renvoie donc le message tel quel.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

handle('state', () => describe());
handle('config:save', (_e, id, values) => {
  saveConfig(id, values);
  return describe();
});
handle('connect', async (event, id) => {
  await connect(BrowserWindow.fromWebContents(event.sender), id);
  return describe();
});
handle('disconnect', (_e, id) => {
  platform(id);
  store.setAccount(id, { tokens: null, account: null });
  return describe();
});
// Chaque changement de profil renvoie les profils et les plateformes du profil actif.
const profileState = () => ({ profiles: store.profiles(), platforms: describe() });
handle('profiles:state', () => profileState());
handle('profiles:add', (_e, name) => {
  store.addProfile(name);
  return profileState();
});
handle('profiles:rename', (_e, id, name) => {
  store.renameProfile(id, name);
  return profileState();
});
handle('profiles:remove', (_e, id) => {
  store.removeProfile(id);
  return profileState();
});
handle('profiles:use', (_e, id) => {
  store.useProfile(id);
  return profileState();
});
handle('video:pick', async (event) => {
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Choisir une vidéo',
    properties: ['openFile'],
    filters: [{ name: 'Vidéos', extensions: ['mp4', 'mov'] }],
  });
  return picked.canceled ? null : inspect(picked.filePaths[0]);
});
handle('video:inspect', (_e, filePath) => inspect(filePath));
// Miniature : une image de la vidéo à un instant donné, ou une image choisie à part.
handle('thumb:frame', (_e, filePath, seconds) => thumbnail(filePath, Number(seconds) || 0));
handle('thumb:pick', async (event) => {
  const picked = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: 'Choisir une miniature',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
  });
  return picked.canceled ? null : thumbnail(picked.filePaths[0]);
});
handle('check', (_e, post, info) =>
  Object.fromEntries(platforms.map((p) => [p.id, warnings(p.id, post, info)])),
);
handle('publish', (event, request) => publish(event.sender, request));
handle('score', (_e, post, keywords) => checklist({ title: post.title, caption: post.caption, keywords }));
handle('stats', () => stats());
handle('review', (_e, input) => review(input));
handle('retitle', (_e, id, title) => retitle(id, title));
handle('categories', () => ({ list: CATEGORIES, initial: DEFAULT_CATEGORY }));
handle('assistant:state', () => describeAssistant());
handle('assistant:save', (_e, values) => {
  saveAssistant(values);
  return describeAssistant();
});
handle('assistant:advise', (_e, input) => advise(input));
handle('open', (_e, url) => {
  if (new URL(url).protocol !== 'https:') throw new Error('Seuls les liens https sont ouverts.');
  return shell.openExternal(url);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#101114',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js') },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Rien ne navigue dans la fenêtre : un lien sort dans le navigateur ou n'aboutit pas.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  trustSystemCertificates();
  store.seed();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
