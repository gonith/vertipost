const { request, sendFile, postImage, sleep } = require('../lib/http');
const meta = require('./meta');

// Les Reels se publient sur une Page Facebook, jamais sur un profil personnel : l'API ne le
// permet pas. Même application Meta qu'Instagram, donc mêmes identifiants.
const { GRAPH, query } = meta;
const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'business_management',
  // Sert uniquement aux statistiques : nombre de lectures de chaque Reel.
  'read_insights',
];

// Le jeton d'une Page obtenu à partir d'un jeton utilisateur de longue durée n'expire pas.
async function connect(config, { choose }) {
  const { access } = await meta.login(config, SCOPES);
  const list = (await meta.pages(access, 'name,access_token')).filter((p) => p.access_token);
  if (!list.length) throw new Error("Aucune Page Facebook autorisée. Les Reels se publient sur une Page : crée-en une ou autorise-la à la connexion.");
  const page = await meta.pick(list, (p) => p.name, choose, 'Quelle Page Facebook relier à ce profil ?');
  return { tokens: { access: page.access_token, pageId: page.id }, account: page.name };
}

const absolute = (url) => (url && url.startsWith('/') ? `https://www.facebook.com${url}` : url || null);

async function publish({ tokens, video, post, caption, progress }) {
  const reels = `${GRAPH}/${tokens.pageId}/video_reels`;
  progress('Préparation', 0);
  const start = await request(reels, { form: { upload_phase: 'start', access_token: tokens.access } });
  const id = start.data.video_id;
  if (!id) throw new Error("Facebook n'a pas ouvert de session d'envoi.");

  const sent = await sendFile(start.data.upload_url || `https://rupload.facebook.com/video-upload/v26.0/${id}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${tokens.access}`, offset: '0', file_size: String(video.size) },
    filePath: video.path,
    start: 0,
    end: video.size - 1,
    onProgress: (f) => progress('Envoi', f),
  });
  if (sent.status >= 300 || sent.data.success === false) {
    throw new Error(`L'envoi à Facebook a échoué (${sent.status}) : ${sent.text.slice(0, 600)}`);
  }

  // La couverture se dépose avant la publication, pour que le Reel paraisse avec elle.
  const notes = [];
  if (post.thumbnail) {
    progress('Miniature', 1);
    try {
      await postImage(`${GRAPH}/${id}/thumbnails`, { is_preferred: true, access_token: tokens.access }, post.thumbnail.path);
    } catch (e) {
      notes.push(`Miniature non appliquée : ${e.message}`);
    }
  }

  progress('Publication', 1);
  await request(reels, {
    form: { upload_phase: 'finish', video_id: id, video_state: 'PUBLISHED', description: caption, access_token: tokens.access },
  });

  // Facebook traite la vidéo puis la publie : on attend la fin pour donner le lien.
  progress('Traitement', 1);
  for (let i = 0; ; i++) {
    const { data } = await request(`${GRAPH}/${id}?${query({ fields: 'status', access_token: tokens.access })}`);
    const status = data.status || {};
    const failed = ['uploading_phase', 'processing_phase', 'publishing_phase'].find((k) => status[k] && status[k].status === 'error');
    if (status.video_status === 'error' || failed) {
      const why = failed && status[failed].errors ? status[failed].errors.map((e) => e.message).join(' ') : status.video_status;
      throw new Error(`Facebook a rejeté la vidéo : ${why}`);
    }
    if (status.publishing_phase && status.publishing_phase.status === 'complete') break;
    if (i === 60) {
      notes.push('Facebook traite encore la vidéo : elle apparaîtra sur la Page dans quelques minutes.');
      break;
    }
    await sleep(5000);
  }
  const link = await request(`${GRAPH}/${id}?${query({ fields: 'permalink_url', access_token: tokens.access })}`);
  return { url: absolute(link.data.permalink_url), note: notes.join(' ') || null };
}

// Les derniers Reels de la Page. Les lectures demandent l'autorisation read_insights.
const RECENT = 15;

async function stats({ tokens }) {
  const fields = 'id,description,permalink_url,created_time,likes.summary(true).limit(0),comments.summary(true).limit(0)';
  const list = await request(`${GRAPH}/${tokens.pageId}/video_reels?${query({ fields, limit: RECENT, access_token: tokens.access })}`);
  let denied = 0;
  const rows = await Promise.all(
    (list.data.data || []).map(async (v) => {
      const total = (edge) => (v[edge] && v[edge].summary ? v[edge].summary.total_count : null);
      const row = {
        title: (v.description || '(sans légende)').split('\n')[0],
        url: absolute(v.permalink_url),
        date: v.created_time,
        views: null,
        likes: total('likes'),
        comments: total('comments'),
        shares: null,
        saves: null,
      };
      try {
        const insights = await request(`${GRAPH}/${v.id}/video_insights?${query({ metric: 'blue_reels_play_count', access_token: tokens.access })}`);
        const metric = (insights.data.data || [])[0];
        if (metric) row.views = metric.values[0].value;
      } catch {
        denied++;
      }
      return row;
    }),
  );
  const note = rows.length && denied === rows.length ? 'Les lectures des Reels ne sont pas disponibles pour cette Page.' : null;
  return { rows, note };
}

module.exports = {
  id: 'facebook',
  name: 'Facebook Reels',
  // Pas d'identifiants propres : ceux d'Instagram, même application Meta.
  configFrom: 'instagram',
  redirectUri: meta.REDIRECT,
  fields: meta.fields,
  consoleUrl: 'https://developers.facebook.com/apps/',
  help: [
    "Facebook utilise la même application Meta qu'Instagram : ces identifiants sont communs aux deux.",
    "Les Reels sont publiés sur une Page Facebook que tu gères, pas sur ton profil personnel : l'API de Meta ne le permet pas.",
    'Facebook accepte des Reels de 3 à 90 secondes.',
  ],
  connect,
  publish,
  stats,
};
