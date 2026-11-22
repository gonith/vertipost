// Limites connues de chaque plateforme. Ce sont des avertissements, pas des blocages :
// elles bougent, et un compte payant peut en dépasser certaines (X Premium, par exemple).
const LIMITS = {
  youtube: { title: 100, caption: 5000, seconds: 180 },
  instagram: { caption: 2200, seconds: 900 },
  facebook: { caption: 2200, seconds: 90 },
  tiktok: { caption: 2200, seconds: 600 },
};

// Format exigé par Instagram pour un Reel envoyé par l'API, plus strict que les autres plateformes.
const REEL = { megabytes: 300, codecs: ['h264', 'hevc'], fps: [23, 60], width: 1920, mbps: 25, sampleRate: 48000, seconds: 3 };

// À la fin d'un envoi, Meta passe 20 à 30 secondes sur la vidéo et abandonne vers 33 secondes avec
// un 400 « ProcessingFailedError ». Ce délai grandit avec le volume d'images (largeur x hauteur x
// cadence x durée) mais change aussi d'un moment à l'autre : en novembre 2026, une même copie de
// 1,2 milliard de pixels échouait quatre fois sur cinq quand une autre de 1,5 milliard passait.
// Au-delà de 1,9 milliard presque rien ne passe. Aucun seuil n'étant sûr, l'envoi descend une
// échelle de copies de plus en plus légères jusqu'à ce que l'une soit acceptée.
const REEL_PIXELS = 1.9e9;
const LIGHT_FPS = 30;
// Petit côté de chaque copie, et nombre de copies à tenter au plus.
const LADDER = [1080, 720, 540, 480, 360, 240, 160];
const RUNGS = 4;

const measurable = (info) => Boolean(info && info.width && info.height && info.duration);

// Vrai quand l'original est trop lourd pour valoir un essai.
function tooHeavy(info) {
  return measurable(info) && info.width * info.height * (info.fps || LIGHT_FPS) * info.duration > REEL_PIXELS;
}

// Copies à tenter, de la plus nette à la plus légère, toutes plus légères que l'original.
function lighterSizes(info) {
  if (!measurable(info)) return [];
  const fps = Math.min(info.fps || LIGHT_FPS, LIGHT_FPS);
  const side = Math.min(info.width, info.height);
  return LADDER.filter((short) => short < side || (short === side && info.fps > fps))
    .map((short) => ({ width: Math.round((info.width * short) / side / 4) * 4, fps }))
    .filter(({ width }) => width * width * (info.height / info.width) * fps * info.duration <= REEL_PIXELS)
    .slice(0, RUNGS);
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
  const [light] = tooHeavy(info) ? lighterSizes(info) : [];
  if (light) out.push(`Vidéo trop lourde pour l'envoi à Instagram : Vertipost publiera une copie allégée, au plus ${light.width} pixels de large${light.fps < info.fps ? ` et ${light.fps} images par seconde` : ''}.`);
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

module.exports = { LIMITS, captionFor, warnings, tooHeavy, lighterSizes };
