const api = window.vertipost;
const $ = (id) => document.getElementById(id);

const state = {
  platforms: [],
  video: null,
  selected: new Set(),
  overrides: {},
  warnings: {},
  progress: {},
  results: {},
  busy: false,
};
// Éléments de chaque carte mis à jour sans reconstruire la liste, par identifiant de plateforme.
const refs = {};

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

// La sélection est un confort : si le stockage local manque, on coche ce qui est connecté.
function loadSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem('selection'));
    if (Array.isArray(saved)) return new Set(saved);
  } catch {}
  return null;
}

function saveSelection() {
  try {
    localStorage.setItem('selection', JSON.stringify([...state.selected]));
  } catch {}
}

function currentPost() {
  return {
    title: $('title').value,
    caption: $('caption').value,
    privacy: $('privacy').value,
    overrides: state.overrides,
  };
}

function targets() {
  return state.platforms.filter((p) => p.connected && state.selected.has(p.id)).map((p) => p.id);
}

function setPlatforms(list) {
  state.platforms = list;
  render();
}

function statusText(p) {
  if (p.connected) return `Connecté : ${p.account}`;
  return p.configured ? 'Non connecté' : 'À configurer';
}

function card(p) {
  const box = el('input', { type: 'checkbox', checked: p.connected && state.selected.has(p.id), disabled: !p.connected || state.busy });
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(p.id);
    else state.selected.delete(p.id);
    saveSelection();
    renderPublish();
    renderWarnings();
  });

  const configure = el('button', { className: 'ghost', textContent: 'Configurer', disabled: state.busy });
  configure.addEventListener('click', () => openSettings(p));

  const link = el('button', { textContent: p.connected ? 'Déconnecter' : 'Connecter', disabled: state.busy || !p.configured });
  link.addEventListener('click', async () => {
    showError('');
    link.disabled = true;
    link.textContent = p.connected ? 'Déconnexion...' : 'En attente du navigateur...';
    try {
      const list = await (p.connected ? api.disconnect(p.id) : api.connect(p.id));
      if (!p.connected) state.selected.add(p.id);
      saveSelection();
      setPlatforms(list);
    } catch (e) {
      showError(`${p.name} : ${e.message}`);
      render();
    }
  });

  const node = el(
    'div',
    { className: 'card' },
    el(
      'div',
      { className: 'row' },
      box,
      el('span', { className: 'name', textContent: p.name }),
      el('span', { className: p.connected ? 'good' : 'muted', textContent: statusText(p) }),
      el('span', { className: 'grow' }),
      configure,
      link,
    ),
  );

  // TikTok part en brouillon : la légende s'écrit dans l'application, pas ici.
  if (p.connected && p.id !== 'tiktok') {
    const own = el('textarea', { rows: 3, value: state.overrides[p.id] || '', placeholder: 'Vide : la légende commune est utilisée.' });
    own.addEventListener('input', () => {
      state.overrides[p.id] = own.value;
      scheduleCheck();
    });
    node.append(el('details', { open: Boolean(state.overrides[p.id]) }, el('summary', { textContent: 'Légende propre à cette plateforme' }), own));
  }

  // Avertissements et progression sont mis à jour sur place : reconstruire la carte ferait
  // perdre le curseur d'une légende en cours de saisie.
  const bar = el('progress', { max: 1, value: 0, hidden: true });
  const phase = el('p', { className: 'result muted', hidden: true });
  refs[p.id] = { warnings: el('ul', { hidden: true }), bar, phase };
  node.append(refs[p.id].warnings, bar, phase);

  const result = state.results[p.id];
  if (result) {
    const line = el('p', { className: `result ${result.ok ? 'good' : 'bad'}`, textContent: result.ok ? 'Envoyé.' : `Échec : ${result.error}` });
    if (result.url) {
      const open = el('button', { textContent: 'Ouvrir' });
      open.addEventListener('click', () => api.open(result.url));
      line.append(' ', result.url, open);
    }
    node.append(line);
    if (result.note) node.append(el('p', { className: 'result muted', textContent: result.note }));
  }
  return node;
}

function renderPublish() {
  const count = targets().length;
  const button = $('publish');
  button.disabled = state.busy || !state.video || count === 0;
  if (state.busy) button.textContent = 'Publication en cours...';
  else if (!state.video) button.textContent = 'Choisis une vidéo';
  else if (count === 0) button.textContent = 'Coche au moins une plateforme connectée';
  else button.textContent = count === 1 ? 'Publier sur 1 plateforme' : `Publier sur ${count} plateformes`;
}

function renderWarnings() {
  for (const p of state.platforms) {
    const list = (p.connected && state.selected.has(p.id) && state.warnings[p.id]) || [];
    refs[p.id].warnings.replaceChildren(...list.map((w) => el('li', { textContent: w })));
    refs[p.id].warnings.hidden = list.length === 0;
  }
}

function renderProgress() {
  for (const p of state.platforms) {
    const progress = state.results[p.id] ? null : state.progress[p.id];
    const { bar, phase } = refs[p.id];
    bar.hidden = phase.hidden = !progress;
    if (progress) {
      bar.value = progress.fraction;
      phase.textContent = `${progress.phase} ${Math.round(progress.fraction * 100)} %`;
    }
  }
}

function render() {
  $('platforms').replaceChildren(...state.platforms.map(card));
  renderWarnings();
  renderProgress();
  renderPublish();
}

let checkTimer = null;
function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    state.warnings = await api.check(currentPost(), state.video && state.video.info);
    renderWarnings();
  }, 200);
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function setVideo(video) {
  if (!video) return;
  state.video = video;
  state.results = {};
  state.progress = {};
  const preview = $('preview');
  preview.src = video.url;
  preview.hidden = false;
  $('drop-hint').hidden = true;
  $('drop').classList.add('filled');
  $('change').hidden = false;
  const info = video.info
    ? `${video.info.width}x${video.info.height}, ${Math.round(video.info.duration)} s, ${megabytes(video.size)}`
    : `${megabytes(video.size)} (ffprobe introuvable : format non vérifié)`;
  $('file-info').textContent = `${video.name} : ${info}`;
  showError('');
  scheduleCheck();
  render();
}

async function pick() {
  if (state.busy) return;
  try {
    setVideo(await api.pickVideo());
  } catch (e) {
    showError(e.message);
  }
}

const drop = $('drop');
drop.addEventListener('click', () => {
  if (!state.video) pick();
});
drop.addEventListener('keydown', (e) => {
  if (!state.video && (e.key === 'Enter' || e.key === ' ')) pick();
});
$('change').addEventListener('click', pick);
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const file = e.dataTransfer.files[0];
  if (!file || state.busy) return;
  try {
    setVideo(await api.inspectDropped(file));
  } catch (err) {
    showError(err.message);
  }
});

for (const id of ['title', 'caption']) $(id).addEventListener('input', scheduleCheck);

$('publish').addEventListener('click', async () => {
  const ids = targets();
  state.busy = true;
  state.results = {};
  state.progress = Object.fromEntries(ids.map((id) => [id, { phase: 'En attente', fraction: 0 }]));
  showError('');
  render();
  try {
    const results = await api.publish({ filePath: state.video.path, post: currentPost(), targets: ids });
    for (const result of results) state.results[result.id] = result;
  } catch (e) {
    showError(e.message);
  }
  state.busy = false;
  state.progress = {};
  render();
});

api.onProgress(({ id, phase, fraction }) => {
  state.progress[id] = { phase, fraction };
  renderProgress();
});

// Réglages d'une plateforme.
let editing = null;

function openSettings(p) {
  editing = p;
  $('settings-title').textContent = `Configurer ${p.name}`;
  $('settings-help').replaceChildren(...p.help.map((line) => el('li', { textContent: line })));
  $('settings-redirect').value = p.redirectUri;
  $('settings-error').hidden = true;
  $('settings-fields').replaceChildren(
    ...p.fields.map((f) =>
      el(
        'label',
        { textContent: f.label },
        el('input', {
          type: f.secret ? 'password' : 'text',
          name: f.key,
          value: f.value,
          placeholder: f.secret && f.filled ? 'Déjà enregistré, laisse vide pour le garder' : '',
        }),
      ),
    ),
  );
  $('settings').showModal();
}

$('settings-redirect').addEventListener('focus', (e) => e.target.select());
$('settings-console').addEventListener('click', () => api.open(editing.consoleUrl));
$('settings-cancel').addEventListener('click', () => $('settings').close());
$('settings').querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = {};
  for (const input of $('settings-fields').querySelectorAll('input')) values[input.name] = input.value;
  try {
    setPlatforms(await api.saveConfig(editing.id, values));
    $('settings').close();
  } catch (err) {
    $('settings-error').textContent = err.message;
    $('settings-error').hidden = false;
  }
});

(async () => {
  try {
    const list = await api.state();
    state.selected = loadSelection() || new Set(list.filter((p) => p.connected).map((p) => p.id));
    setPlatforms(list);
  } catch (e) {
    showError(e.message);
  }
})();
