const { authorize, PORT } = require('../oauth');
const { request, readRange, sleep } = require('../lib/http');
const { MB, fixedChunks } = require('../lib/chunks');

const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const API = 'https://api.x.com/2';
const TOKEN_URL = `${API}/oauth2/token`;
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
// X conseille 5 Mo au plus par segment et en refuse plus de 8.
const SEGMENT = 4 * MB;

// Une application « native » n'a pas de secret et s'identifie par son client_id dans le corps ;
// une application « web » s'authentifie en Basic.
function tokenRequest(config, form) {
  if (config.clientSecret) {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    return request(TOKEN_URL, { headers: { Authorization: `Basic ${basic}` }, form });
  }
  return request(TOKEN_URL, { form: { ...form, client_id: config.clientId } });
}

const toTokens = (data) => ({
  access: data.access_token,
  refresh: data.refresh_token,
  expiresAt: Date.now() + data.expires_in * 1000,
});

async function connect(config) {
  const { code, verifier } = await authorize({
    authUrl: 'https://x.com/i/oauth2/authorize',
    params: { client_id: config.clientId, response_type: 'code', scope: SCOPES.join(' ') },
    redirectUri: REDIRECT,
  });
  const { data } = await tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
  });
  const tokens = toTokens(data);
  const me = await request(`${API}/users/me`, { headers: { Authorization: `Bearer ${tokens.access}` } });
  return { tokens, account: `@${me.data.data.username}` };
}

async function accessToken({ config, tokens, saveTokens }) {
  if (Date.now() < tokens.expiresAt - 60_000) return tokens.access;
  let data;
  try {
    ({ data } = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: tokens.refresh }));
  } catch (e) {
    throw new Error(`Session X expirée, reconnecte le compte. (${e.message})`);
  }
  // X renouvelle aussi le jeton de rafraîchissement : l'ancien ne vaut plus rien.
  const next = toTokens(data);
  saveTokens(next);
  return next.access;
}

async function publish(ctx) {
  const { video, caption, progress } = ctx;
  const access = await accessToken(ctx);
  const auth = { Authorization: `Bearer ${access}` };

  progress('Préparation', 0);
  const init = await request(`${API}/media/upload/initialize`, {
    headers: auth,
    json: { media_type: video.mime, total_bytes: video.size, media_category: 'tweet_video' },
  });
  const mediaId = init.data.data.id;

  const segments = fixedChunks(video.size, SEGMENT);
  for (const [index, segment] of segments.entries()) {
    const body = new FormData();
    body.set('segment_index', String(index));
    body.set('media', new Blob([await readRange(video.path, segment.start, segment.end)]), 'segment');
    await request(`${API}/media/upload/${mediaId}/append`, { headers: auth, body });
    progress('Envoi', (segment.end + 1) / video.size);
  }

  progress('Traitement', 1);
  let { data } = await request(`${API}/media/upload/${mediaId}/finalize`, { method: 'POST', headers: auth });
  for (let i = 0; i < 60; i++) {
    const info = data.data && data.data.processing_info;
    if (!info || info.state === 'succeeded') break;
    if (info.state === 'failed') {
      throw new Error(`X a rejeté la vidéo : ${(info.error && info.error.message) || 'raison non précisée'}`);
    }
    await sleep((info.check_after_secs || 5) * 1000);
    ({ data } = await request(`${API}/media/upload?command=STATUS&media_id=${mediaId}`, { headers: auth }));
  }

  progress('Publication', 1);
  const post = await request(`${API}/tweets`, {
    headers: auth,
    json: { text: caption, media: { media_ids: [mediaId] } },
  });
  return { url: `https://x.com/i/status/${post.data.data.id}`, note: null };
}

module.exports = {
  id: 'x',
  name: 'X',
  redirectUri: REDIRECT,
  fields: [
    { key: 'clientId', label: 'Client ID (OAuth 2.0)' },
    { key: 'clientSecret', label: 'Client Secret (vide pour une application native)', secret: true, optional: true },
  ],
  consoleUrl: 'https://console.x.com/',
  help: [
    "Crée une application dans la console développeur de X et active l'authentification OAuth 2.0, type « Native App », en lecture et écriture.",
    "L'API est payante à l'usage : il faut des crédits prépayés. Compte environ 0,015 $ par post, et 0,20 $ si la légende contient un lien (tarifs relevés en octobre 2026 sur des sources tierces, à confirmer dans la console).",
    'Sans X Premium, la vidéo est limitée à 140 secondes et la légende à 280 caractères.',
  ],
  connect,
  publish,
};
