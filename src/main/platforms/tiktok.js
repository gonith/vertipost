const { clipboard, shell } = require('electron');
const { authorize, PORT } = require('../oauth');
const { request, sendFile, sleep } = require('../lib/http');
const { tiktokPlan } = require('../lib/chunks');

const REDIRECT = `http://127.0.0.1:${PORT}/callback/`;
const API = 'https://open.tiktokapis.com/v2';
const TOKEN_URL = `${API}/oauth/token/`;

// Le point d'accès des jetons répond 200 même en cas d'échec, avec un champ `error`.
async function token(form) {
  const { data } = await request(TOKEN_URL, { form });
  if (!data.access_token) {
    throw new Error(`TikTok a refusé le jeton : ${data.error_description || data.error || 'réponse vide'}`);
  }
  return data;
}

const toTokens = (data, mode) => ({
  access: data.access_token,
  refresh: data.refresh_token,
  expiresAt: Date.now() + data.expires_in * 1000,
  mode,
});

// Trois façons d'envoyer :
// - assisted : Vertipost prépare tout et l'utilisateur termine sur le site de TikTok. C'est le
//   mode par défaut, parce que TikTok refuse d'auditer un outil d'envoi à usage personnel et que
//   les deux modes par API restent bridés sans audit ;
// - draft : par l'API, la vidéo arrive en brouillon dans la boîte de réception TikTok du compte.
//   En Sandbox, TikTok confirme le dépôt mais la notification n'apparaît pas dans l'application ;
// - private : par l'API, publication directe visible de son auteur seul, et seulement si le
//   compte est privé au moment de l'envoi.
// Les deux modes par API ont chacun leur autorisation.
const MODES = {
  assisted: {},
  draft: { scope: 'user.info.basic,video.upload', init: '/post/publish/inbox/video/init/' },
  private: { scope: 'user.info.basic,video.publish', init: '/post/publish/video/init/' },
};
const modeOf = (config) => (MODES[config.mode] ? config.mode : 'assisted');
const assisted = (config) => modeOf(config) === 'assisted';
const STUDIO = 'https://www.tiktok.com/tiktokstudio/upload';

// Rien n'est envoyé : la légende va dans le presse-papiers, le fichier est montré dans
// l'Explorateur et la page d'envoi de TikTok s'ouvre dans le navigateur.
async function assist({ video, caption }) {
  clipboard.writeText(caption);
  shell.showItemInFolder(video.path);
  await shell.openExternal(STUDIO);
  return {
    url: null,
    label: 'À terminer dans TikTok.',
    note: "La page d'envoi de TikTok est ouverte, ta vidéo est affichée dans l'Explorateur et la légende est copiée : glisse la vidéo dans la page, colle la légende (Ctrl+V) et publie.",
  };
}

async function call(path, access, json) {
  const { data } = await request(`${API}${path}`, { headers: { Authorization: `Bearer ${access}` }, json });
  if (data.error && data.error.code !== 'ok') {
    throw new Error(`TikTok : ${data.error.code} ${data.error.message || ''}`);
  }
  return data.data;
}

async function connect(config) {
  if (assisted(config)) throw new Error("Le mode assisté n'a pas besoin de connexion.");
  if (!config.clientId || !config.clientSecret) throw new Error("Ce mode d'envoi demande le Client key et le Client secret.");
  const { code, verifier } = await authorize({
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    params: { client_key: config.clientId, response_type: 'code', scope: MODES[modeOf(config)].scope },
    redirectUri: REDIRECT,
    pkce: 'hex',
  });
  const tokens = toTokens(
    await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_key: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: REDIRECT,
    }),
    modeOf(config),
  );
  const info = await call('/user/info/?fields=display_name', tokens.access);
  return { tokens, account: info.user.display_name };
}

async function accessToken({ config, tokens, saveTokens }) {
  if (Date.now() < tokens.expiresAt - 60_000) return tokens.access;
  let data;
  try {
    data = await token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh,
      client_key: config.clientId,
      client_secret: config.clientSecret,
    });
  } catch (e) {
    throw new Error(`Session TikTok expirée, reconnecte le compte. (${e.message})`);
  }
  const next = toTokens(data, tokens.mode);
  saveTokens(next);
  return next.access;
}

async function putChunk(url, video, chunk, onProgress) {
  for (let attempt = 1; ; attempt++) {
    const res = await sendFile(url, {
      method: 'PUT',
      headers: {
        'Content-Type': video.mime,
        'Content-Range': `bytes ${chunk.start}-${chunk.end}/${video.size}`,
      },
      filePath: video.path,
      start: chunk.start,
      end: chunk.end,
      onProgress,
    });
    if (res.status === 201 || res.status === 206) return;
    if (res.status < 500 || attempt === 3) {
      throw new Error(`L'envoi à TikTok a échoué (${res.status}) : ${res.text.slice(0, 600)}`);
    }
    await sleep(2000 * attempt);
  }
}

async function publish(ctx) {
  const { config, tokens, video, caption, progress } = ctx;
  const mode = modeOf(config);
  if (mode === 'assisted') return assist(ctx);
  // L'autorisation obtenue à la connexion ne vaut que pour un mode. Une connexion d'avant
  // l'existence des modes est un brouillon.
  if (!tokens || (tokens.mode || 'draft') !== mode) {
    throw new Error("Le mode d'envoi a changé depuis la connexion : déconnecte puis reconnecte le compte TikTok.");
  }
  const access = await accessToken(ctx);
  const plan = tiktokPlan(video.size);

  progress('Préparation', 0);
  const body = {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: video.size,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.chunks.length,
    },
  };
  if (mode === 'private') {
    // TikTok exige cette consultation avant toute publication directe.
    await call('/post/publish/creator_info/query/', access, {});
    body.post_info = { title: caption, privacy_level: 'SELF_ONLY' };
  }
  const init = await call(MODES[mode].init, access, body);

  for (const chunk of plan.chunks) {
    await putChunk(init.upload_url, video, chunk, (f) =>
      progress('Envoi', (chunk.start + f * (chunk.end - chunk.start + 1)) / video.size),
    );
  }

  progress('Traitement', 1);
  const done =
    mode === 'private'
      ? "Publiée en privé sur ton profil TikTok : ouvre la vidéo dans l'application et passe sa visibilité sur « Tout le monde »."
      : 'Brouillon envoyé : ouvre la notification dans TikTok pour ajouter la légende et publier.';
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const status = await call('/post/publish/status/fetch/', access, { publish_id: init.publish_id });
    if (status.status === 'PUBLISH_COMPLETE' || (mode === 'draft' && status.status === 'SEND_TO_USER_INBOX')) {
      return { url: null, note: done };
    }
    if (status.status === 'FAILED') {
      throw new Error(`TikTok a rejeté la vidéo : ${status.fail_reason || 'raison non précisée'}`);
    }
  }
  return { url: null, note: 'Vidéo envoyée, TikTok la traite encore. La notification arrivera dans l\'application.' };
}

module.exports = {
  id: 'tiktok',
  name: 'TikTok',
  redirectUri: REDIRECT,
  fields: [
    {
      key: 'mode',
      label: "Mode d'envoi",
      optional: true,
      options: [
        { value: 'assisted', label: 'Assisté : tu termines sur le site de TikTok' },
        { value: 'draft', label: 'API : brouillon dans la boîte de réception TikTok' },
        { value: 'private', label: 'API : publication directe, en privé' },
      ],
    },
    { key: 'clientId', label: 'Client key (modes API seulement)', optional: true },
    { key: 'clientSecret', label: 'Client secret (modes API seulement)', secret: true, optional: true },
  ],
  consoleUrl: 'https://developers.tiktok.com/apps/',
  help: [
    "Mode assisté, sans rien configurer : à la publication, Vertipost ouvre la page d'envoi de TikTok, affiche ta vidéo dans l'Explorateur et copie la légende. Tu glisses la vidéo, tu colles la légende et tu publies.",
    "Les modes API demandent une application TikTok for Developers (plateforme « Desktop », produits « Login Kit » et « Content Posting API », ton compte en « Target user » du Sandbox). TikTok ne valide pas un outil à usage personnel, et sans validation ils restent bridés.",
    'API, brouillon (scope « video.upload ») : TikTok confirme le dépôt, mais en Sandbox la notification peut ne jamais arriver dans son application.',
    "API, publication directe (option « Direct Post », scope « video.publish ») : ton compte TikTok doit être privé au moment de l'envoi et la vidéo n'est visible que de toi.",
    "Après un changement de mode API, déconnecte puis reconnecte le compte : l'autorisation n'est pas la même.",
  ],
  assisted,
  connect,
  publish,
};
