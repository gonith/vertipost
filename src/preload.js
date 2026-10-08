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
  open: (url) => call('open', url),
  onProgress: (fn) => ipcRenderer.on('progress', (_event, payload) => fn(payload)),
});
