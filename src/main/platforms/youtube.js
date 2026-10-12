const { authorize, PORT } = require('../oauth');
const { request, sendFile } = require('../lib/http');
const { categoryOf } = require('../lib/advice');

const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  // Sert uniquement à afficher le nom de la chaîne connectée.
  'https://www.googleapis.com/auth/youtube.readonly',
];

const toTokens = (data, previous = {}) => ({
  access: data.access_token,
  refresh: data.refresh_token || previous.refresh,
  expiresAt: Date.now() + data.expires_in * 1000,
});

async function connect(config) {
  const { code, verifier } = await authorize({
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    params: {
      client_id: config.clientId,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    },
    redirectUri: REDIRECT,
  });
  const { data } = await request(TOKEN_URL, {
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: REDIRECT,
    },
  });
  const tokens = toTokens(data);
  const channels = await request('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${tokens.access}` },
  });
  const channel = channels.data.items && channels.data.items[0];
  if (!channel) throw new Error("Ce compte Google n'a pas de chaîne YouTube.");
  return { tokens, account: channel.snippet.title };
}

async function accessToken({ config, tokens, saveTokens }) {
  if (Date.now() < tokens.expiresAt - 60_000) return tokens.access;
  let data;
  try {
    ({ data } = await request(TOKEN_URL, {
      form: {
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      },
    }));
  } catch (e) {
    // Tant que l'écran de consentement est en mode « Test », Google révoque le jeton au bout de 7 jours.
    throw new Error(`Session YouTube expirée, reconnecte le compte. (${e.message})`);
  }
  const next = toTokens(data, tokens);
  saveTokens(next);
  return next.access;
}

async function publish(ctx) {
  const { video, post, caption, progress } = ctx;
  const access = await accessToken(ctx);
  const wanted = post.privacy || 'public';

  progress('Préparation', 0);
  const init = await request(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      headers: {
        Authorization: `Bearer ${access}`,
        'X-Upload-Content-Length': String(video.size),
        'X-Upload-Content-Type': video.mime,
      },
      json: {
        snippet: { title: post.title.trim(), description: caption, categoryId: categoryOf(post.categoryId) },
        status: { privacyStatus: wanted, selfDeclaredMadeForKids: false },
      },
    },
  );
  const location = init.headers.get('location');
  if (!location) throw new Error("YouTube n'a pas renvoyé d'adresse d'envoi.");

  const sent = await sendFile(location, {
    method: 'PUT',
    headers: { 'Content-Type': video.mime },
    filePath: video.path,
    start: 0,
    end: video.size - 1,
    onProgress: (f) => progress('Envoi', f),
  });
  if (sent.status >= 300 || !sent.data.id) {
    throw new Error(`L'envoi à YouTube a échoué (${sent.status}) : ${sent.text.slice(0, 600)}`);
  }

  const got = sent.data.status && sent.data.status.privacyStatus;
  const note =
    got && got !== wanted
      ? `YouTube l'a enregistrée en « ${got} » au lieu de « ${wanted} ». C'est le verrou des projets Google non audités.`
      : null;
  return { url: `https://www.youtube.com/shorts/${sent.data.id}`, note };
}

// Les dernières vidéos de la chaîne avec leurs compteurs. La liste des envois de la chaîne
// contient aussi les vidéos privées, pour son propriétaire.
const RECENT = 15;
const DATA = 'https://www.googleapis.com/youtube/v3';

async function stats(ctx) {
  const headers = { Authorization: `Bearer ${await accessToken(ctx)}` };
  const channels = await request(`${DATA}/channels?part=contentDetails&mine=true`, { headers });
  const channel = channels.data.items && channels.data.items[0];
  if (!channel) return { rows: [] };
  const uploads = channel.contentDetails.relatedPlaylists.uploads;
  const list = await request(`${DATA}/playlistItems?part=contentDetails&maxResults=${RECENT}&playlistId=${uploads}`, { headers });
  const ids = (list.data.items || []).map((item) => item.contentDetails.videoId);
  if (!ids.length) return { rows: [] };
  const videos = await request(`${DATA}/videos?part=snippet,statistics&id=${ids.join(',')}`, { headers });
  const count = (value) => (value === undefined ? null : Number(value));
  return {
    rows: (videos.data.items || []).map((v) => ({
      title: v.snippet.title,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      date: v.snippet.publishedAt,
      views: count(v.statistics.viewCount),
      likes: count(v.statistics.likeCount),
      comments: count(v.statistics.commentCount),
    })),
  };
}

module.exports = {
  id: 'youtube',
  name: 'YouTube Shorts',
  redirectUri: REDIRECT,
  fields: [
    { key: 'clientId', label: 'ID client' },
    { key: 'clientSecret', label: 'Code secret du client', secret: true },
  ],
  consoleUrl: 'https://console.cloud.google.com/apis/credentials',
  help: [
    'Crée un projet sur Google Cloud et active « YouTube Data API v3 ».',
    "Configure l'écran de consentement OAuth en mode Test et ajoute ton adresse Google comme utilisateur test.",
    "Crée un identifiant « ID client OAuth » de type « Application de bureau ». Ce type n'a pas d'adresse de redirection à déclarer.",
    "Tant que le projet n'a pas passé l'audit de conformité YouTube, les vidéos envoyées restent en privé. En mode Test, la connexion est à refaire tous les 7 jours.",
  ],
  connect,
  publish,
  stats,
};
