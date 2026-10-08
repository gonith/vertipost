// Limites connues de chaque plateforme. Ce sont des avertissements, pas des blocages :
// elles bougent, et un compte payant peut en dépasser certaines (X Premium, par exemple).
const LIMITS = {
  youtube: { title: 100, caption: 5000, seconds: 180 },
  instagram: { caption: 2200, seconds: 900 },
  tiktok: { caption: 2200, seconds: 600 },
  x: { caption: 280, seconds: 140 },
};

function captionFor(platform, post) {
  const own = post.overrides && post.overrides[platform];
  return (own && own.trim()) || post.caption || '';
}

// `info` vient de ffprobe et peut être null quand ffprobe est absent.
function warnings(platform, post, info) {
  const limit = LIMITS[platform];
  const out = [];
  const caption = captionFor(platform, post);
  if (caption.length > limit.caption) {
    out.push(`Légende trop longue : ${caption.length} caractères pour ${limit.caption} autorisés.`);
  }
  if (platform === 'youtube') {
    const title = (post.title || '').trim();
    if (!title) out.push('Titre manquant.');
    else if (title.length > limit.title) out.push(`Titre trop long : ${title.length} caractères pour ${limit.title} autorisés.`);
  }
  if (info) {
    if (info.width >= info.height) {
      out.push(`La vidéo n'est pas verticale (${info.width}x${info.height}).`);
    }
    if (info.duration > limit.seconds) {
      out.push(`Durée de ${Math.round(info.duration)} s, au-delà des ${limit.seconds} s admises.`);
    }
  }
  return out;
}

module.exports = { LIMITS, captionFor, warnings };
