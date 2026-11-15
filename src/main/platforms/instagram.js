const fs = require('fs');
const { request, sendFile, postImage, sleep } = require('../lib/http');
const { faststart, lighten } = require('../video');
const { lighterSize } = require('../lib/rules');
const meta = require('./meta');

// L'envoi d'un fichier local (« resumable upload ») n'existe que derrière Facebook Login for
// Business : le compte Instagram doit être professionnel ET rattaché à une Page Facebook.
const { GRAPH } = meta;
const SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
  // Sert uniquement aux statistiques : vues, portée, partages et enregistrements.
  'instagram_manage_insights',
  // Sert uniquement à la miniature choisie à part : voir hostCover.
  'pages_manage_posts',
];

async function connect(config, { choose }) {
  const { access, expiresAt } = await meta.login(config, SCOPES);
  const linked = (await meta.pages(access, 'name,instagram_business_account{id,username}')).filter((p) => p.instagram_business_account);
  if (!linked.length) {
    throw new Error(
      "Aucun compte Instagram professionnel n'est rattaché aux Pages Facebook autorisées. Passe le compte en Créateur ou Business et relie-le à une Page.",
    );
  }
  const page = await meta.pick(linked, (p) => `@${p.instagram_business_account.username}`, choose, 'Quel compte Instagram relier à ce profil ?');
  return {
    tokens: { access, expiresAt, igUserId: page.instagram_business_account.id, pageId: page.id },
    account: `@${page.instagram_business_account.username}`,
  };
}

// Instagram ne prend une couverture que par son adresse web. Une image de la vidéo se désigne par
// son instant ; une image choisie à part est déposée en photo non publiée sur la Page reliée, le
// temps qu'Instagram la récupère, puis supprimée.
async function hostCover(tokens, file) {
  const page = await request(`${GRAPH}/${tokens.pageId}?fields=access_token&access_token=${tokens.access}`);
  const pageToken = page.data.access_token;
  const photo = await postImage(`${GRAPH}/${tokens.pageId}/photos`, { published: false, access_token: pageToken }, file);
  const remove = () => request(`${GRAPH}/${photo.data.id}?access_token=${pageToken}`, { method: 'DELETE' }).catch(() => {});
  try {
    const info = await request(`${GRAPH}/${photo.data.id}?fields=images&access_token=${pageToken}`);
    const image = (info.data.images || [])[0];
    if (!image) throw new Error("Facebook n'a pas rendu l'adresse de l'image.");
    return { url: image.source, remove };
  } catch (e) {
    await remove();
    throw e;
  }
}

async function publish(ctx) {
  const { tokens, post } = ctx;
  if (Date.now() > tokens.expiresAt) {
    throw new Error('Session Instagram expirée (elle dure environ 60 jours), reconnecte le compte.');
  }
  const notes = [];
  let cover = {};
  let hosted = null;
  if (post.thumbnail && post.thumbnail.offset !== null && post.thumbnail.offset !== undefined) {
    cover = { thumb_offset: Math.round(post.thumbnail.offset * 1000) };
  } else if (post.thumbnail && !tokens.pageId) {
    notes.push('Miniature non appliquée : pour une image choisie à part, déconnecte puis reconnecte Instagram, une autorisation de plus est nécessaire.');
  } else if (post.thumbnail) {
    try {
      hosted = await hostCover(tokens, post.thumbnail.path);
      cover = { cover_url: hosted.url };
    } catch (e) {
      notes.push(`Miniature non appliquée : ${e.message}`);
    }
  }
  try {
    const result = await send({ ...ctx, cover });
    return { url: result.url, note: [...notes, result.note].filter(Boolean).join(' ') || null };
  } finally {
    if (hosted) await hosted.remove();
  }
}

async function send({ tokens, video, caption, progress, cover }) {
  const auth = { Authorization: `OAuth ${tokens.access}` };

  progress('Préparation', 0);
  const copies = [];
  const sized = async (file) => {
    copies.push(file);
    return { path: file, size: (await fs.promises.stat(file)).size };
  };
  const light = lighterSize(video.info);
  let id;
  let note = null;
  try {
    // Instagram refuse un fichier dont l'index est à la fin : on lui en envoie une copie réordonnée.
    const file = video.info && video.info.moovFirst === false ? await sized(await faststart(video.path)) : video;
    try {
      id = await upload({ tokens, auth, caption, cover, progress, file, attempts: light ? 2 : 4 });
    } catch (e) {
      // Un fichier refusé pour son volume d'images passe une fois allégé : voir lighterSize.
      if (!e.flaky || !light) throw e;
      progress('Allègement de la vidéo', 0);
      id = await upload({ tokens, auth, caption, cover, progress, file: await sized(await lighten(video.path, light)), attempts: 3 });
      note = `Instagram a refusé le fichier d'origine : c'est une copie allégée (${light.width} pixels de large) qui a été publiée.`;
    }
  } finally {
    for (const file of copies) fs.promises.unlink(file).catch(() => {});
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
  return { url: media.data.permalink || null, note };
}

// Envoie le fichier dans un conteneur et rend son identifiant.
// Meta refuse certains envois pourtant complets avec un 400 « ProcessingFailedError » qu'il dit
// non rejouable, alors que le même fichier peut passer à l'essai suivant quand son volume
// d'images est proche de la limite (voir lighterSize). Un conteneur refusé est perdu, chaque
// essai en ouvre donc un neuf. L'erreur finale porte `flaky` quand c'est ce refus-là.
async function upload({ tokens, auth, caption, cover, progress, file, attempts }) {
  let last;
  let flaky = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const phase = attempt === 1 ? 'Envoi' : `Envoi, nouvel essai ${attempt} sur ${attempts}`;
    const container = await request(`${GRAPH}/${tokens.igUserId}/media`, {
      headers: { Authorization: `Bearer ${tokens.access}` },
      json: { media_type: 'REELS', upload_type: 'resumable', caption, share_to_feed: true, ...cover },
    });
    const { id, uri } = container.data;
    if (!id || !uri) throw new Error("Instagram n'a pas ouvert de session d'envoi.");

    last = await sendFile(uri, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/octet-stream', offset: '0', file_size: String(file.size) },
      filePath: file.path,
      start: 0,
      end: file.size - 1,
      onProgress: (f) => progress(phase, f),
    });
    if (last.status < 300 && last.data.success !== false) return id;
    flaky = Boolean(last.status === 400 && last.data.debug_info && last.data.debug_info.type === 'ProcessingFailedError');
    if (!flaky) break;
  }
  throw Object.assign(new Error(`L'envoi à Instagram a échoué (${last.status}) : ${last.text.slice(0, 600)}`), { flaky });
}

// Les dernières publications du compte. Les mentions J'aime et les commentaires viennent avec la
// liste ; vues, partages et enregistrements demandent une autorisation de plus, absente d'une
// connexion faite avant l'ajout des statistiques.
const RECENT = 15;
const INSIGHTS = { views: 'views', shares: 'shares', saved: 'saves' };

async function stats({ tokens }) {
  if (Date.now() > tokens.expiresAt) {
    throw new Error('Session Instagram expirée (elle dure environ 60 jours), reconnecte le compte.');
  }
  const headers = { Authorization: `OAuth ${tokens.access}` };
  const fields = 'id,caption,permalink,timestamp,like_count,comments_count';
  const media = await request(`${GRAPH}/${tokens.igUserId}/media?fields=${fields}&limit=${RECENT}`, { headers });
  let denied = 0;
  const rows = await Promise.all(
    (media.data.data || []).map(async (m) => {
      const row = {
        title: (m.caption || '(sans légende)').split('\n')[0],
        url: m.permalink,
        date: m.timestamp,
        views: null,
        likes: m.like_count === undefined ? null : m.like_count,
        comments: m.comments_count === undefined ? null : m.comments_count,
        shares: null,
        saves: null,
      };
      try {
        const insights = await request(`${GRAPH}/${m.id}/insights?metric=${Object.keys(INSIGHTS).join(',')}`, { headers });
        for (const metric of insights.data.data || []) row[INSIGHTS[metric.name]] = metric.values[0].value;
      } catch {
        denied++;
      }
      return row;
    }),
  );
  const note = rows.length && denied === rows.length ? 'Pour voir les vues, les partages et les enregistrements, déconnecte puis reconnecte Instagram : une autorisation de plus est nécessaire.' : null;
  return { rows, note };
}

module.exports = {
  id: 'instagram',
  name: 'Instagram Reels',
  redirectUri: meta.REDIRECT,
  fields: meta.fields,
  consoleUrl: 'https://developers.facebook.com/apps/',
  help: [
    'Le compte Instagram doit être Créateur ou Business, et relié à une Page Facebook que tu gères.',
    'Crée une application de type « Business » sur Meta for Developers et ajoute le produit « Facebook Login for Business ».',
    "Laisse l'application en mode développement : c'est suffisant pour ton propre compte, et c'est ce qui autorise le retour sur localhost.",
    'La connexion dure environ 60 jours, puis il faut la refaire.',
    'Ces identifiants servent aussi à Facebook : la même application Meta publie sur les deux.',
  ],
  connect,
  publish,
  stats,
};
