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
  categories: [],
  assistant: null,
  advice: null,
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
    categoryId: $('category').value,
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
    renderScore(await api.score(currentPost(), $('keywords').value));
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

for (const id of ['title', 'caption', 'keywords']) $(id).addEventListener('input', scheduleCheck);
function setKeywords(value) {
  $('keywords').value = value;
  try {
    localStorage.setItem('keywords', value);
  } catch {}
}
$('keywords').addEventListener('input', () => setKeywords($('keywords').value));

// La raison n'est affichée que pour ce qui reste à faire.
function renderScore(rules) {
  $('score-total').textContent = `${rules.filter((r) => r.ok).length} / ${rules.length}`;
  $('score-list').replaceChildren(
    ...rules.map((r) =>
      el(
        'li',
        { className: r.ok ? '' : 'todo' },
        el('input', { type: 'checkbox', checked: r.ok, disabled: true }),
        el('div', {}, r.label, ...(r.ok ? [] : [el('br'), el('span', { textContent: r.why })])),
      ),
    ),
  );
}

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

// Programmations.
const JOB_STATUS = {
  pending: 'Programmée',
  running: 'Publication en cours...',
  missed: "Manquée : Vertipost était fermé à l'heure prévue",
};

function jobStatus(job) {
  if (job.status !== 'done') return JOB_STATUS[job.status];
  return job.results.every((r) => r.ok) ? 'Publiée' : 'Terminée avec des échecs';
}

function jobCard(job) {
  const name = (id) => (state.platforms.find((p) => p.id === id) || { name: id }).name;
  const when = new Date(job.at).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
  const good = job.status === 'done' && job.results.every((r) => r.ok);
  const row = el(
    'div',
    { className: 'row' },
    el('span', { className: 'name', textContent: when }),
    el('span', { className: good ? 'good' : job.status === 'pending' || job.status === 'running' ? 'muted' : 'bad', textContent: jobStatus(job) }),
    el('span', { className: 'grow' }),
  );
  const act = (label, call) => {
    const button = el('button', { className: 'ghost', textContent: label });
    button.addEventListener('click', async () => {
      try {
        renderJobs(await call(job.id));
      } catch (e) {
        showError(e.message);
      }
    });
    row.append(button);
  };
  if (job.status === 'missed') act('Publier maintenant', api.scheduleRun);
  if (job.status !== 'running') act(job.status === 'pending' ? 'Annuler' : 'Retirer', api.scheduleRemove);

  const node = el(
    'div',
    { className: 'card' },
    row,
    el('p', { className: 'result muted', textContent: `${job.name} : ${job.post.title || '(sans titre)'} → ${job.targets.map(name).join(', ')}` }),
  );
  for (const result of job.results || []) {
    const text = result.ok ? `${name(result.id)} : envoyé. ${result.url || result.note || ''}` : `${name(result.id)} : échec. ${result.error}`;
    node.append(el('p', { className: `result ${result.ok ? 'good' : 'bad'}`, textContent: text }));
  }
  return node;
}

function renderJobs(jobs) {
  $('jobs-section').hidden = jobs.length === 0;
  $('jobs').replaceChildren(...jobs.map(jobCard));
}

$('schedule').addEventListener('click', async () => {
  showError('');
  if (!state.video) return showError("Choisis d'abord une vidéo.");
  if (targets().length === 0) return showError('Coche au moins une plateforme connectée.');
  if (!$('when').value) return showError("Choisis la date et l'heure de publication.");
  try {
    renderJobs(await api.scheduleAdd({ filePath: state.video.path, post: currentPost(), targets: targets(), at: new Date($('when').value).getTime() }));
    $('when').value = '';
  } catch (e) {
    showError(e.message);
  }
});

api.onSchedule(renderJobs);

// Onglets.
function showTab(name) {
  for (const tab of ['publish', 'settings']) {
    $(`page-${tab}`).hidden = tab !== name;
    $(`tab-${tab}`).classList.toggle('active', tab === name);
  }
}
$('tab-publish').addEventListener('click', () => showTab('publish'));
$('tab-settings').addEventListener('click', () => showTab('settings'));
showTab('publish');

// Paramètres de l'assistant. L'affichage et la langue sont des préférences de l'interface ;
// l'IA choisie et les clés partent dans le stockage chiffré.
function assistantEnabled() {
  try {
    return localStorage.getItem('assistant') !== 'off';
  } catch {
    return true;
  }
}

function renderAssistantSettings() {
  const a = state.assistant;
  $('assistant-enabled').checked = assistantEnabled();
  $('assistant-help').replaceChildren(...a.help.map((line) => el('li', { textContent: line })));
  $('assistant-fields').replaceChildren(...a.fields.map(fieldNode));
  $('assistant-links').replaceChildren(
    ...a.links.map((link) => {
      const button = el('button', { type: 'button', className: 'ghost', textContent: link.label });
      button.addEventListener('click', () => api.open(link.url));
      return button;
    }),
  );
}

$('assistant-enabled').addEventListener('change', (e) => {
  try {
    localStorage.setItem('assistant', e.target.checked ? 'on' : 'off');
  } catch {}
  renderAssistant();
});

$('assistant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = {};
  for (const input of $('assistant-fields').querySelectorAll('input, select')) values[input.name] = input.value;
  $('assistant-form-error').hidden = true;
  try {
    state.assistant = await api.saveAssistant(values);
    renderAssistantSettings();
    renderAssistant();
    $('assistant-saved').hidden = false;
    setTimeout(() => ($('assistant-saved').hidden = true), 2500);
  } catch (err) {
    $('assistant-form-error').textContent = err.message;
    $('assistant-form-error').hidden = false;
  }
});

// Assistant de référencement.
function renderAssistant() {
  $('assistant-block').hidden = !assistantEnabled();
  const ready = Boolean(state.assistant && state.assistant.configured);
  $('assistant-status').textContent = ready ? '' : 'Clé API à renseigner';
  $('advise').disabled = !ready;
}

function proposal(label, text) {
  return el(
    'div',
    { className: 'proposal' },
    el('p', { className: 'muted', textContent: label }),
    el('p', { className: 'text', textContent: text }),
  );
}

function renderAdvice() {
  const advice = state.advice;
  $('advice').hidden = !advice;
  if (!advice) return;
  const category = state.categories.find((c) => c.id === advice.categoryId);
  const apply = el('button', { id: 'apply', className: 'primary', textContent: 'Appliquer au formulaire' });
  apply.addEventListener('click', applyAdvice);
  $('advice').replaceChildren(
    proposal('Mots-clés de niche', advice.keywords.join(', ')),
    proposal('Titre YouTube', advice.title),
    proposal('Catégorie YouTube', category.name),
    proposal('Description YouTube', advice.captions.youtube),
    proposal('Légende Instagram', advice.captions.instagram),
    proposal("Légende TikTok, à coller dans l'application TikTok", advice.captions.tiktok),
    proposal('Post X', advice.captions.x),
    apply,
    el('h3', { textContent: 'Pourquoi ces choix' }),
    el('ul', {}, ...advice.tips.map((t) => el('li', {}, el('strong', { textContent: t.title }), ' ', t.text))),
  );
}

// La description YouTube devient la légende commune ; Instagram et X reçoivent la leur.
// Les mots-clés proposés ne remplacent pas ceux que l'utilisateur a déjà choisis.
function applyAdvice() {
  const { title, categoryId, captions, keywords } = state.advice;
  if (!$('keywords').value.trim()) setKeywords(keywords.join(', '));
  $('title').value = title;
  $('caption').value = captions.youtube;
  setCategory(categoryId);
  state.overrides.instagram = captions.instagram;
  state.overrides.x = captions.x;
  scheduleCheck();
  render();
}

function setCategory(id) {
  $('category').value = id;
  try {
    localStorage.setItem('category', id);
  } catch {}
}

$('category').addEventListener('change', (e) => setCategory(e.target.value));
$('language').addEventListener('change', (e) => {
  try {
    localStorage.setItem('language', e.target.value);
  } catch {}
});
$('assistant-configure').addEventListener('click', () => showTab('settings'));
$('advise').addEventListener('click', async () => {
  const button = $('advise');
  const label = button.textContent;
  $('assistant-error').hidden = true;
  button.disabled = true;
  button.textContent = 'Réflexion en cours...';
  try {
    state.advice = await api.advise({ brief: $('brief').value, keywords: $('keywords').value, language: $('language').value, post: currentPost(), info: state.video && state.video.info });
    renderAdvice();
  } catch (e) {
    $('assistant-error').textContent = e.message;
    $('assistant-error').hidden = false;
  }
  button.textContent = label;
  renderAssistant();
});

// Champ de réglage : liste de choix, ou texte masqué quand c'est un secret.
function fieldNode(f) {
  if (f.options) {
    const select = el('select', { name: f.key }, ...f.options.map((o) => el('option', { value: o.value, textContent: o.label })));
    if (f.value) select.value = f.value;
    return el('label', { textContent: f.label }, select);
  }
  return el(
    'label',
    { textContent: f.label },
    el('input', {
      type: f.secret ? 'password' : 'text',
      name: f.key,
      value: f.value,
      placeholder: f.secret && f.filled ? 'Déjà enregistré, laisse vide pour le garder' : '',
    }),
  );
}

// Réglages d'une plateforme.
let editing = null;

function openSettings(p) {
  editing = p;
  $('settings-title').textContent = `Configurer ${p.name}`;
  $('settings-help').replaceChildren(...p.help.map((line) => el('li', { textContent: line })));
  $('settings-redirect').value = p.redirectUri;
  $('settings-error').hidden = true;
  $('settings-fields').replaceChildren(...p.fields.map(fieldNode));
  $('settings').showModal();
}

$('settings-redirect').addEventListener('focus', (e) => e.target.select());
$('settings-console').addEventListener('click', () => api.open(editing.consoleUrl));
$('settings-cancel').addEventListener('click', () => $('settings').close());
$('settings').querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = {};
  for (const input of $('settings-fields').querySelectorAll('input, select')) values[input.name] = input.value;
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
    const categories = await api.categories();
    state.categories = categories.list;
    $('category').replaceChildren(...categories.list.map((c) => el('option', { value: c.id, textContent: c.name })));
    let category = null;
    try {
      category = localStorage.getItem('category');
    } catch {}
    $('category').value = categories.list.some((c) => c.id === category) ? category : categories.initial;
    try {
      $('keywords').value = localStorage.getItem('keywords') || '';
      $('language').value = localStorage.getItem('language') || '';
    } catch {}
    scheduleCheck();
    state.assistant = await api.assistantState();
    renderAssistantSettings();
    renderAssistant();
    const list = await api.state();
    state.platforms = list;
    renderJobs(await api.scheduleList());
    state.selected = loadSelection() || new Set(list.filter((p) => p.connected).map((p) => p.id));
    setPlatforms(list);
  } catch (e) {
    showError(e.message);
  }
})();
