const path = require('path');
const crypto = require('crypto');
const { BrowserWindow, Notification } = require('electron');
const store = require('./store');
const { split } = require('./lib/schedule');

// Publications programmées, gardées avec les comptes. Elles ne partent que si l'application
// tourne à l'heure prévue : aucune des quatre API n'offre de programmation côté plateforme
// utilisable ici.
// Forme : { id, at, filePath, name, post, targets, status, results }
// status : pending, running, done, ou missed quand l'heure est passée application fermée.
const TICK_MS = 20 * 1000;

let publish = null;

const list = () => ((store.load().schedule || {}).jobs || []).sort((a, b) => a.at - b.at);

function save(jobs) {
  store.update('schedule', { jobs });
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('schedule', list());
}

const patch = (id, change) => save(list().map((j) => (j.id === id ? { ...j, ...change } : j)));

async function run(job) {
  patch(job.id, { status: 'running' });
  let results;
  try {
    results = await publish({ filePath: job.filePath, post: job.post, targets: job.targets });
  } catch (e) {
    results = job.targets.map((id) => ({ id, ok: false, error: e.message }));
  }
  patch(job.id, { status: 'done', results });
  const failed = results.filter((r) => !r.ok).length;
  if (Notification.isSupported()) {
    new Notification({
      title: failed ? 'Vertipost : publication programmée en échec' : 'Vertipost : publication programmée envoyée',
      body: failed ? `${job.name} : ${failed} plateforme(s) sur ${results.length} en échec.` : job.name,
    }).show();
  }
}

function tick() {
  const { due, missed } = split(list(), Date.now());
  for (const job of missed) patch(job.id, { status: 'missed' });
  for (const job of due) run(job);
}

function start(publisher) {
  publish = publisher;
  // Une publication coupée par la fermeture de l'application n'est pas relancée d'office :
  // une partie des plateformes a pu la recevoir.
  for (const job of list()) if (job.status === 'running') patch(job.id, { status: 'missed' });
  tick();
  setInterval(tick, TICK_MS);
}

function add({ filePath, post, targets, at }) {
  if (!Number.isFinite(at) || at <= Date.now()) throw new Error("Choisis une date et une heure à venir.");
  if (!targets.length) throw new Error('Coche au moins une plateforme connectée.');
  save([...list(), { id: crypto.randomUUID(), at, filePath, name: path.basename(filePath), post, targets, status: 'pending' }]);
}

const remove = (id) => save(list().filter((j) => j.id !== id || j.status === 'running'));

function runNow(id) {
  const job = list().find((j) => j.id === id && j.status === 'missed');
  if (job) run(job);
}

const pending = () => list().filter((j) => j.status === 'pending').length;

module.exports = { start, list, add, remove, runNow, pending };
