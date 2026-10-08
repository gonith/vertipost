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

const toTokens = (data) => ({
  access: data.access_token,
  refresh: data.refresh_token,
  expiresAt: Date.now() + data.expires_in * 1000,
});

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
    params: { client_key: config.clientId, response_type: 'code', scope: 'user.info.basic,video.upload' },
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
  const next = toTokens(data);
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

// Envoi en BROUILLON : la vidéo arrive dans la boîte de réception TikTok du compte, et la
// publication se termine dans l'application. C'est le seul mode utile tant que l'application
// n'est pas auditée, la publication directe étant alors forcée en privé.
async function publish(ctx) {
  const { video, progress } = ctx;
  const access = await accessToken(ctx);
  const plan = tiktokPlan(video.size);

  progress('Préparation', 0);
  const init = await call('/post/publish/inbox/video/init/', access, {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: video.size,
      chunk_size: plan.chunkSize,
      total_chunk_count: plan.chunks.length,
    },
  });

  for (const chunk of plan.chunks) {
    await putChunk(init.upload_url, video, chunk, (f) =>
      progress('Envoi', (chunk.start + f * (chunk.end - chunk.start + 1)) / video.size),
    );
  }

  progress('Traitement', 1);
  const done = 'Brouillon envoyé : ouvre la notification dans TikTok pour ajouter la légende et publier.';
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    const status = await call('/post/publish/status/fetch/', access, { publish_id: init.publish_id });
    if (status.status === 'SEND_TO_USER_INBOX' || status.status === 'PUBLISH_COMPLETE') {
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
  ],
  consoleUrl: 'https://developers.tiktok.com/apps/',
  help: [
    'Crée une application sur TikTok for Developers, plateforme « Desktop ».',
    'Ajoute les produits « Login Kit » et « Content Posting API », avec le scope « video.upload ».',
    "Vertipost envoie la vidéo en brouillon : tu reçois une notification dans TikTok, tu y colles la légende et tu publies. La publication directe n'a d'intérêt qu'après l'audit de TikTok, sans lequel elle reste en privé.",
    '5 brouillons en attente au maximum par tranche de 24 heures.',
  ],
  connect,
  publish,
};
