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

// Deux façons d'envoyer, chacune avec son autorisation :
// - draft : la vidéo arrive en brouillon dans la boîte de réception TikTok du compte ;
// - private : elle est publiée directement, visible de son auteur seul. Tant que l'application
//   n'est pas auditée par TikTok, c'est la seule visibilité que la publication directe accepte.
const MODES = {
  draft: { scope: 'user.info.basic,video.upload', init: '/post/publish/inbox/video/init/' },
  private: { scope: 'user.info.basic,video.publish', init: '/post/publish/video/init/' },
};
const modeOf = (config) => (MODES[config.mode] ? config.mode : 'draft');

async function call(path, access, json) {
  const { data } = await request(`${API}${path}`, { headers: { Authorization: `Bearer ${access}` }, json });
  if (data.error && data.error.code !== 'ok') {
    throw new Error(`TikTok : ${data.error.code} ${data.error.message || ''}`);
  }
  return data.data;
}

async function connect(config) {
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
  // L'autorisation obtenue à la connexion ne vaut que pour un mode. Une connexion d'avant
  // l'existence des modes est un brouillon.
  if ((tokens.mode || 'draft') !== mode) {
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
    { key: 'clientId', label: 'Client key' },
    { key: 'clientSecret', label: 'Client secret', secret: true },
    {
      key: 'mode',
      label: "Mode d'envoi",
      optional: true,
      options: [
        { value: 'draft', label: 'Brouillon dans la boîte de réception TikTok' },
        { value: 'private', label: 'Publication directe, en privé' },
      ],
    },
  ],
  consoleUrl: 'https://developers.tiktok.com/apps/',
  help: [
    'Crée une application sur TikTok for Developers, plateforme « Desktop », et travaille dans son Sandbox avec ton compte en « Target user ».',
    'Ajoute les produits « Login Kit » et « Content Posting API ».',
    'Mode brouillon (scope « video.upload ») : tu reçois une notification dans TikTok, tu y colles la légende et tu publies. 5 brouillons en attente au maximum par 24 heures.',
    "Mode publication directe (active « Direct Post » dans Content Posting API, scope « video.publish ») : la vidéo est publiée avec sa légende, visible de toi seul tant que TikTok n'a pas audité l'application ; tu changes sa visibilité dans TikTok.",
    "Après un changement de mode, déconnecte puis reconnecte le compte : l'autorisation n'est pas la même.",
  ],
  connect,
  publish,
};
