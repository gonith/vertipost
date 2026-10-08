const { authorize, PORT } = require('../oauth');
const { request, sendFile, sleep } = require('../lib/http');

// L'envoi d'un fichier local (« resumable upload ») n'existe que derrière Facebook Login for
// Business : le compte Instagram doit être professionnel ET rattaché à une Page Facebook.
// Meta n'accepte un retour en http que sur « localhost », et seulement en mode développement.
const REDIRECT = `http://localhost:${PORT}/callback`;
const VERSION = 'v26.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
];

const query = (params) => new URLSearchParams(params).toString();

async function connect(config) {
  const { code } = await authorize({
    authUrl: `https://www.facebook.com/${VERSION}/dialog/oauth`,
    params: { client_id: config.clientId, response_type: 'code', scope: SCOPES.join(',') },
    redirectUri: REDIRECT,
    pkce: null,
  });
  const app = { client_id: config.clientId, client_secret: config.clientSecret };
  const short = await request(`${GRAPH}/oauth/access_token?${query({ ...app, redirect_uri: REDIRECT, code })}`);
  // Le jeton obtenu dure une heure ; on l'échange contre un jeton d'environ 60 jours.
  const long = await request(
    `${GRAPH}/oauth/access_token?${query({
      ...app,
      grant_type: 'fb_exchange_token',
      fb_exchange_token: short.data.access_token,
    })}`,
  );
  const access = long.data.access_token;
  const pages = await request(
    `${GRAPH}/me/accounts?${query({ fields: 'name,instagram_business_account{id,username}', access_token: access })}`,
  );
  const page = (pages.data.data || []).find((p) => p.instagram_business_account);
  if (!page) {
    throw new Error(
      "Aucun compte Instagram professionnel n'est rattaché aux Pages Facebook autorisées. Passe le compte en Créateur ou Business et relie-le à une Page.",
    );
  }
  return {
    tokens: {
      access,
      expiresAt: Date.now() + (long.data.expires_in || 60 * 24 * 3600) * 1000,
      igUserId: page.instagram_business_account.id,
    },
    account: `@${page.instagram_business_account.username}`,
  };
}

async function publish({ tokens, video, caption, progress }) {
  if (Date.now() > tokens.expiresAt) {
    throw new Error('Session Instagram expirée (elle dure environ 60 jours), reconnecte le compte.');
  }
  const auth = { Authorization: `OAuth ${tokens.access}` };

  progress('Préparation', 0);
  const container = await request(`${GRAPH}/${tokens.igUserId}/media`, {
    headers: { Authorization: `Bearer ${tokens.access}` },
    json: { media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: true },
  });
  const { id, uri } = container.data;
  if (!id || !uri) throw new Error("Instagram n'a pas ouvert de session d'envoi.");

  const sent = await sendFile(uri, {
    method: 'POST',
    headers: { ...auth, offset: '0', file_size: String(video.size) },
    filePath: video.path,
    start: 0,
    end: video.size - 1,
    onProgress: (f) => progress('Envoi', f),
  });
  if (sent.status >= 300 || sent.data.success === false) {
    throw new Error(`L'envoi à Instagram a échoué (${sent.status}) : ${sent.text.slice(0, 600)}`);
  }

  // Instagram réencode la vidéo avant d'accepter la publication.
  progress('Traitement', 1);
  let status;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    ({ data: status } = await request(`${GRAPH}/${id}?fields=status_code,status`, { headers: auth }));
    if (status.status_code === 'FINISHED') break;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`Instagram a rejeté la vidéo : ${status.status || status.status_code}`);
    }
  }
  if (status.status_code !== 'FINISHED') {
    throw new Error('Instagram traite encore la vidéo après 5 minutes. Rien n\'a été publié.');
  }

  progress('Publication', 1);
  const published = await request(`${GRAPH}/${tokens.igUserId}/media_publish`, {
    headers: auth,
    form: { creation_id: id },
  });
  const media = await request(`${GRAPH}/${published.data.id}?fields=permalink`, { headers: auth });
  return { url: media.data.permalink || null, note: null };
}

module.exports = {
  id: 'instagram',
  name: 'Instagram Reels',
  redirectUri: REDIRECT,
  fields: [
    { key: 'clientId', label: "ID de l'application" },
    { key: 'clientSecret', label: 'Clé secrète', secret: true },
  ],
  consoleUrl: 'https://developers.facebook.com/apps/',
  help: [
    'Le compte Instagram doit être Créateur ou Business, et relié à une Page Facebook que tu gères.',
    'Crée une application de type « Business » sur Meta for Developers et ajoute le produit « Facebook Login for Business ».',
    "Laisse l'application en mode développement : c'est suffisant pour ton propre compte, et c'est ce qui autorise le retour sur localhost.",
    'La connexion dure environ 60 jours, puis il faut la refaire.',
  ],
  connect,
  publish,
};
