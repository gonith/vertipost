// Limites connues de chaque plateforme. Ce sont des avertissements, pas des blocages :
// elles bougent, et un compte payant peut en dépasser certaines (X Premium, par exemple).
const LIMITS = {
  youtube: { title: 100, caption: 5000, seconds: 180 },
  instagram: { caption: 2200, seconds: 900 },
  tiktok: { caption: 2200, seconds: 600 },
  x: { caption: 280, seconds: 140 },
};

// Format exigé par Instagram pour un Reel envoyé par l'API, plus strict que les autres plateformes.
const REEL = { megabytes: 300, codecs: ['h264', 'hevc'], fps: [23, 60], width: 1920, mbps: 25, sampleRate: 48000, seconds: 3 };

// Chaque champ de `info` peut manquer : un contrôle sans donnée ne dit rien.
function reelWarnings(info) {
  const out = [];
  const megabytes = info.size / 1024 / 1024;
  if (megabytes > REEL.megabytes) out.push(`Fichier de ${Math.round(megabytes)} Mo : Instagram refuse au-delà de ${REEL.megabytes} Mo.`);
  if (info.videoCodec && !REEL.codecs.includes(info.videoCodec)) out.push(`Codec vidéo ${info.videoCodec} : Instagram attend du H.264 ou du HEVC.`);
  if (info.fps && (info.fps < REEL.fps[0] || info.fps > REEL.fps[1])) out.push(`${Math.round(info.fps)} images par seconde : Instagram en accepte de ${REEL.fps[0]} à ${REEL.fps[1]}.`);
  if (info.width > REEL.width) out.push(`Largeur de ${info.width} pixels : Instagram s'arrête à ${REEL.width}.`);
  if (info.bitrate > REEL.mbps * 1e6) out.push(`Débit de ${Math.round(info.bitrate / 1e6)} Mbit/s : Instagram s'arrête à ${REEL.mbps}.`);
  if (info.audioCodec && info.audioCodec !== 'aac') out.push(`Codec audio ${info.audioCodec} : Instagram attend de l'AAC.`);
  if (info.sampleRate > REEL.sampleRate) out.push(`Audio à ${info.sampleRate} Hz : Instagram s'arrête à ${REEL.sampleRate}.`);
  if (info.channels > 2) out.push(`Audio à ${info.channels} canaux : Instagram attend du mono ou du stéréo.`);
  if (info.duration < REEL.seconds) out.push(`Durée inférieure à ${REEL.seconds} secondes, le minimum d'Instagram.`);
  if (info.moovFirst === false) out.push("L'index de la vidéo est en fin de fichier : Instagram le veut au début (option « fast start » ou « optimisé pour le web » à l'export).");
  return out;
}

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
    if (platform === 'instagram') out.push(...reelWarnings(info));
  }
  return out;
}

module.exports = { LIMITS, captionFor, warnings };
