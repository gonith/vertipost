const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

contextBridge.exposeInMainWorld('vertipost', {
  state: () => call('state'),
  saveConfig: (id, values) => call('config:save', id, values),
  connect: (id) => call('connect', id),
  disconnect: (id) => call('disconnect', id),
  pickVideo: () => call('video:pick'),
  // Le chemin d'un fichier déposé n'est lisible que d'ici, pas depuis la page.
  inspectDropped: (file) => call('video:inspect', webUtils.getPathForFile(file)),
  check: (post, info) => call('check', post, info),
  publish: (request) => call('publish', request),
  score: (post, keywords) => call('score', post, keywords),
  stats: () => call('stats'),
  review: (input) => call('review', input),
  retitle: (id, title) => call('retitle', id, title),
  categories: () => call('categories'),
  assistantState: () => call('assistant:state'),
  saveAssistant: (values) => call('assistant:save', values),
  advise: (input) => call('assistant:advise', input),
  open: (url) => call('open', url),
  onProgress: (fn) => ipcRenderer.on('progress', (_event, payload) => fn(payload)),
});
