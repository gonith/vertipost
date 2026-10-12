// Grille de relecture du titre et de la légende. Ce sont des repères de bonnes pratiques du
// format court, pas une prédiction d'audience : les seuils sont des ordres de grandeur.
const TITLE_START = 40;
const TITLE_MAX = 60;
const CAPTION_START = 125;
const HASHTAGS = { min: 3, max: 5 };

// Comparaison sans casse ni accents : « Plateformer » et « plateformer » sont le même mot-clé.
const fold = (text) => (text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function keywordsOf(text) {
  return [...new Set((text || '').split(/[,;\n]/).map((k) => fold(k).trim()).filter(Boolean))];
}

const hashtagsOf = (text) => (text || '').match(/#[\p{L}\p{N}_]+/gu) || [];

function checklist({ title, caption, keywords }) {
  const words = keywordsOf(keywords);
  const has = (text) => words.some((k) => fold(text).includes(k));
  const tags = hashtagsOf(caption);
  const head = (title || '').trim();
  const body = (caption || '').trim();
  const rule = (ok, label, why) => ({ ok: Boolean(ok), label, why });
  return [
    rule(words.length, 'Tes mots-clés de niche sont renseignés', 'Sans eux, la grille ne peut pas vérifier que ton texte parle bien de ta niche.'),
    rule(has(head), 'Le titre contient un de tes mots-clés', "C'est le premier texte que la plateforme lit pour savoir à qui montrer la vidéo."),
    rule(has(head.slice(0, TITLE_START)), `Ce mot-clé arrive dans les ${TITLE_START} premiers caractères du titre`, 'La fin du titre est souvent coupée à l\'affichage.'),
    rule(head && head.length <= TITLE_MAX, `Le titre fait ${TITLE_MAX} caractères ou moins`, 'Un titre court se lit en entier dans le fil.'),
    rule(body && !body.startsWith('#'), 'La légende commence par une phrase, pas par un hashtag', "Seul le début s'affiche avant le bouton « plus » : il doit donner envie et dire le sujet."),
    rule(has(body.slice(0, CAPTION_START)), `La légende reprend un de tes mots-clés dans ses ${CAPTION_START} premiers caractères`, 'Le début de la légende pèse le plus pour le classement et pour la recherche.'),
    rule(tags.length >= HASHTAGS.min && tags.length <= HASHTAGS.max, `La légende compte ${HASHTAGS.min} à ${HASHTAGS.max} hashtags`, "Quelques hashtags justes classent mieux qu'une longue liste, qui brouille le sujet."),
    rule(tags.some((t) => words.includes(fold(t.slice(1))) || words.some((k) => k.replace(/\s+/g, '') === fold(t.slice(1)))), 'Un hashtag reprend un de tes mots-clés', 'Un hashtag de niche range la vidéo avec celles que ton public regarde déjà.'),
  ];
}

module.exports = { keywordsOf, hashtagsOf, checklist };
