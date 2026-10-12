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

// À la fin d'un envoi, Meta passe 20 à 35 secondes sur la vidéo et abandonne vers 32 secondes avec
// un 400 « ProcessingFailedError ». Ce délai grandit avec le volume d'images (largeur x hauteur x
// cadence x durée). Mesuré en octobre 2026 : jusqu'à 1,9 milliard de pixels l'envoi a toujours
// abouti, au-delà de 3,5 milliards presque jamais, quels que soient le poids et le contenu du fichier.
const REEL_PIXELS = 1.9e9;
const LIGHT_FPS = 30;

// Dimensions d'une copie qui tient sous ce volume, ou null si la vidéo y tient déjà.
function lighterSize(info) {
  if (!info || !info.width || !info.height || !info.duration) return null;
  const fps = Math.min(info.fps || LIGHT_FPS, LIGHT_FPS);
  const factor = Math.sqrt(REEL_PIXELS / (info.width * info.height * fps * info.duration));
  if (factor >= 1 && fps === (info.fps || LIGHT_FPS)) return null;
  // Les encodeurs veulent des dimensions paires.
  return { width: Math.floor((info.width * Math.min(factor, 1)) / 2) * 2, fps };
}

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
  const light = lighterSize(info);
  if (light) out.push(`Vidéo lourde pour l'envoi à Instagram, qui refuse souvent ce volume d'images. En cas de refus, Vertipost publiera une copie allégée : ${light.width} pixels de large${light.fps < info.fps ? `, ${light.fps} images par seconde` : ''}.`);
  if (info.moovFirst === false) out.push("L'index de la vidéo est en fin de fichier, ce qu'Instagram refuse : Vertipost lui enverra une copie corrigée, sans perte de qualité.");
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

module.exports = { LIMITS, captionFor, warnings, lighterSize };
