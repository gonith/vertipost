const path = require('path');
const tls = require('tls');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const store = require('./store');
const platforms = require('./platforms');
const { inspect } = require('./video');
const { warnings, captionFor } = require('./lib/rules');
const { CATEGORIES, DEFAULT_CATEGORY } = require('./lib/advice');
const assistant = require('./assistant');
const { checklist } = require('./lib/score');
const schedule = require('./schedule');

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

// Ce que l'interface a le droit de voir : jamais un secret ni un jeton.
function describe() {
  const data = store.load();
  return platforms.map((p) => {
    const saved = data[p.id] || {};
    const config = saved.config || {};
    return {
      id: p.id,
      name: p.name,
      redirectUri: p.redirectUri,
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
  const saved = store.load()[id] || {};
  const config = { ...saved.config };
  for (const field of p.fields) {
    const value = (values[field.key] || '').trim();
    // Un champ secret laissé vide veut dire « ne change rien » : l'interface ne le réaffiche pas.
    if (value || !field.secret) config[field.key] = value;
  }
  const sameApp = saved.config && saved.config.clientId === config.clientId;
  store.update(id, sameApp ? { config } : { config, tokens: null, account: null });
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

async function connect(id) {
  const p = platform(id);
  const saved = store.load()[id] || {};
  if (!saved.config) throw new Error("Renseigne d'abord les identifiants de l'application.");
  const { tokens, account } = await p.connect(saved.config);
  store.update(id, { tokens, account });
}

async function publish(notify, { filePath, post, targets }) {
  const video = await inspect(filePath);
  const data = store.load();
  const one = async (id) => {
    const p = platform(id);
    const saved = data[id] || {};
    const config = saved.config || {};
    if (!saved.tokens && !(p.assisted && p.assisted(config))) throw new Error('Compte non connecté.');
    return p.publish({
      config,
      tokens: saved.tokens,
      saveTokens: (tokens) => store.update(id, { tokens }),
      video,
      post,
      caption: captionFor(id, post),
      progress: (phase, fraction) => notify('progress', { id, phase, fraction }),
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
handle('connect', async (_e, id) => {
  await connect(id);
  return describe();
});
handle('disconnect', (_e, id) => {
  platform(id);
  store.update(id, { tokens: null, account: null });
  return describe();
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
handle('check', (_e, post, info) =>
  Object.fromEntries(platforms.map((p) => [p.id, warnings(p.id, post, info)])),
);
handle('publish', (event, request) => publish((channel, payload) => event.sender.send(channel, payload), request));
handle('schedule:list', () => schedule.list());
handle('schedule:add', async (_e, request) => {
  await inspect(request.filePath);
  schedule.add(request);
  return schedule.list();
});
handle('schedule:remove', (_e, id) => {
  schedule.remove(id);
  return schedule.list();
});
handle('schedule:run', (_e, id) => {
  schedule.runNow(id);
  return schedule.list();
});
handle('score', (_e, post, keywords) => checklist({ title: post.title, caption: post.caption, keywords }));
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
  // Fermer la fenêtre quitte l'application, et avec elle les publications programmées.
  win.on('close', (e) => {
    const count = schedule.pending();
    if (!count) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Garder Vertipost ouvert', 'Quitter quand même'],
      defaultId: 0,
      cancelId: 0,
      message: count === 1 ? 'Une publication est programmée.' : `${count} publications sont programmées.`,
      detail: "Elles ne partiront que si Vertipost est ouvert à l'heure prévue. Tu peux réduire la fenêtre au lieu de la fermer.",
    });
    if (choice === 0) e.preventDefault();
  });
  // Rien ne navigue dans la fenêtre : un lien sort dans le navigateur ou n'aboutit pas.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  trustSystemCertificates();
  createWindow();
  // Une publication programmée n'a pas de carte où afficher sa progression.
  schedule.start((request) => publish(() => {}, request));
});
app.on('window-all-closed', () => app.quit());
