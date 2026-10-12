const { authorize, PORT } = require('../oauth');
const { request, sendFile } = require('../lib/http');
const { categoryOf } = require('../lib/advice');

const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  // Nom de la chaîne connectée, statistiques et recherche dans la niche.
  'https://www.googleapis.com/auth/youtube.readonly',
  // Sert uniquement à renommer une vidéo déjà publiée, à la demande de l'utilisateur.
  'https://www.googleapis.com/auth/youtube.force-ssl',
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
      id: v.id,
      title: v.snippet.title,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      date: v.snippet.publishedAt,
      views: count(v.statistics.viewCount),
      likes: count(v.statistics.likeCount),
      comments: count(v.statistics.commentCount),
    })),
  };
}

// Les vidéos courtes les plus vues des six derniers mois pour chaque mot-clé. Une recherche
// coûte 100 unités du quota journalier de 10 000 : on se limite aux premiers mots-clés.
const NICHE_KEYWORDS = 3;
const NICHE_VIDEOS = 8;
const SIX_MONTHS = 182 * 24 * 3600 * 1000;

async function niche(ctx, keywords) {
  const headers = { Authorization: `Bearer ${await accessToken(ctx)}` };
  const after = new Date(Date.now() - SIX_MONTHS).toISOString();
  return Promise.all(
    keywords.slice(0, NICHE_KEYWORDS).map(async (keyword) => {
      const query = new URLSearchParams({ part: 'snippet', type: 'video', videoDuration: 'short', order: 'viewCount', maxResults: String(NICHE_VIDEOS), publishedAfter: after, q: keyword });
      const found = await request(`${DATA}/search?${query}`, { headers });
      const ids = (found.data.items || []).map((item) => item.id.videoId).filter(Boolean);
      if (!ids.length) return { keyword, videos: [] };
      const videos = await request(`${DATA}/videos?part=snippet,statistics&id=${ids.join(',')}`, { headers });
      return {
        keyword,
        videos: (videos.data.items || []).map((v) => ({
          title: v.snippet.title,
          channel: v.snippet.channelTitle,
          views: Number(v.statistics.viewCount || 0),
          tags: v.snippet.tags || [],
        })),
      };
    }),
  );
}

// Renomme une vidéo. YouTube remplace tout le bloc descriptif à la mise à jour : on le relit
// donc pour renvoyer la description, la catégorie et les tags tels quels.
async function retitle(ctx, id, title) {
  const headers = { Authorization: `Bearer ${await accessToken(ctx)}` };
  const current = await request(`${DATA}/videos?part=snippet&id=${encodeURIComponent(id)}`, { headers });
  const video = current.data.items && current.data.items[0];
  if (!video) throw new Error('Vidéo introuvable sur ta chaîne.');
  const { description, categoryId, tags, defaultLanguage } = video.snippet;
  try {
    await request(`${DATA}/videos?part=snippet`, {
      method: 'PUT',
      headers,
      json: { id, snippet: { title, description, categoryId, tags, defaultLanguage } },
    });
  } catch (e) {
    if (e.status === 403) {
      throw new Error('Pour renommer une vidéo, déconnecte puis reconnecte YouTube : une autorisation de plus est nécessaire.');
    }
    throw e;
  }
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
  niche,
  retitle,
};
