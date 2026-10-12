const { z } = require('zod');
const { LIMITS } = require('./rules');
const { TITLE_START, TITLE_MAX, CAPTION_START, HASHTAGS } = require('./score');

// Catégories que YouTube accepte à l'envoi d'une vidéo. Les autres plateformes n'en ont pas :
// leur classement se fait sur la légende et les hashtags.
const CATEGORIES = [
  { id: '1', name: 'Films et animations' },
  { id: '2', name: 'Autos et véhicules' },
  { id: '10', name: 'Musique' },
  { id: '15', name: 'Animaux' },
  { id: '17', name: 'Sport' },
  { id: '19', name: 'Voyages et événements' },
  { id: '20', name: 'Jeux vidéo' },
  { id: '22', name: 'People et blogs' },
  { id: '23', name: 'Humour' },
  { id: '24', name: 'Divertissement' },
  { id: '25', name: 'Actualités et politique' },
  { id: '26', name: 'Vie pratique et style' },
  { id: '27', name: 'Éducation' },
  { id: '28', name: 'Science et technologie' },
  { id: '29', name: 'Organisations à but non lucratif' },
];
const DEFAULT_CATEGORY = '22';

const categoryOf = (id) => (CATEGORIES.some((c) => c.id === id) ? id : DEFAULT_CATEGORY);

const Advice = z.object({
  title: z.string(),
  categoryId: z.string(),
  captions: z.object({
    youtube: z.string(),
    instagram: z.string(),
    tiktok: z.string(),
    x: z.string(),
  }),
  tips: z.array(z.object({ title: z.string(), text: z.string() })),
  keywords: z.array(z.string()),
});

const SYSTEM = `Tu es l'assistant de référencement de Vertipost, une application de bureau avec laquelle un créateur publie la même vidéo verticale sur YouTube Shorts, Instagram Reels, TikTok et X. Le créateur te décrit sa vidéo et te donne, s'il en a un, son brouillon de titre et de légende. Tu lui proposes un titre, une catégorie YouTube et une légende par plateforme, puis tu lui expliques tes choix : le but est qu'il comprenne les enjeux et sache faire seul la prochaine fois.

Ce qui compte en format court. La diffusion passe surtout par le fil de recommandation, qui se règle sur le comportement des spectateurs. Le titre, la légende et les hashtags servent à dire à la plateforme de quoi parle la vidéo, pour qu'elle la montre d'abord au bon public, et à capter la recherche, qui pèse moins mais dure dans le temps. Les termes précis de la niche (le nom du jeu, son genre, ce qui se passe à l'écran) classent donc mieux qu'un hashtag générique, quelques hashtags justes valent mieux qu'une longue liste, et les premiers mots doivent porter l'essentiel parce que la suite est tronquée à l'affichage.

Ce que chaque plateforme attend :
- YouTube : un titre, une description (captions.youtube) et une catégorie (categoryId) à choisir dans la liste fournie. C'est la seule plateforme qui a une catégorie déclarée.
- Instagram et TikTok : pas de catégorie, tout passe par la légende et les hashtags. Sur TikTok la vidéo part en brouillon et le créateur collera lui-même la légende dans l'application.
- X : la légende est un post, hashtags compris dans la limite de caractères ; un ou deux hashtags suffisent.
Les limites de longueur sont données avec la demande, respecte-les.

Les mots-clés de niche (keywords) sont les deux à quatre termes que le public de cette vidéo taperait ou suit déjà : le nom du jeu, son genre, son thème. Si le créateur te donne les siens, reprends-les tels quels dans keywords ; sinon propose-les à partir de sa description. L'application relit ensuite le titre et la description YouTube avec une grille fondée sur ces mots-clés, rappelée dans la demande : ta proposition doit la respecter entièrement, en comptant les caractères et les hashtags avant de répondre.

Tu n'as accès à aucune donnée en direct : ni volumes de recherche, ni tendances du moment. Ne cite donc pas de chiffres, et quand un choix mérite d'être vérifié, dis où le faire (l'onglet Recherche des statistiques de YouTube Studio, TikTok Creative Center).

Écris le titre et les légendes dans la langue de la description du créateur, sauf s'il demande autre chose, et n'invente rien sur le contenu de la vidéo : si un élément utile manque, le conseil correspondant le lui dit. Les conseils (tips) sont en français, au tutoiement, entre trois et cinq, chacun rattaché à un choix concret que tu viens de faire ; l'un d'eux explique la catégorie retenue.`;

// Gemini attend un sous-ensemble d'OpenAPI et refuse ces deux mots-clés de JSON Schema.
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const { $schema, additionalProperties, ...rest } = schema;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, geminiSchema(v)]));
}

// Les mêmes seuils que la grille de l'interface, pour que la proposition la remplisse.
const GRID = `Grille que le titre et la description YouTube doivent respecter :
- le titre reprend un mot-clé de niche, écrit tel quel, dans ses ${TITLE_START} premiers caractères, et fait ${TITLE_MAX} caractères ou moins ;
- la description commence par une phrase, pas par un hashtag, et reprend un mot-clé de niche, écrit tel quel, dans ses ${CAPTION_START} premiers caractères ;
- la description compte ${HASHTAGS.min} à ${HASHTAGS.max} hashtags, dont un formé d'un mot-clé de niche écrit sans espaces.`;

// `info` vient de ffprobe et peut être null.
function adviceMessage({ brief, keywords, post, info }) {
  const draft = (label, text) => `${label} : ${(text || '').trim() || '(vide)'}`;
  const limits = Object.entries(LIMITS)
    .map(([id, l]) => `- ${id} : ${l.title ? `titre ${l.title} caractères, ` : ''}légende ${l.caption} caractères`)
    .join('\n');
  return [
    `Ma vidéo :\n${brief.trim()}`,
    (keywords || '').trim()
      ? `Les mots-clés de ma niche : ${keywords.trim()}`
      : "Je n'ai pas encore choisi les mots-clés de ma niche : propose-les.",
    info ? `Format : ${info.width}x${info.height}, ${Math.round(info.duration)} secondes.` : null,
    `Mon brouillon :\n${draft('Titre', post.title)}\n${draft('Légende', post.caption)}`,
    `Limites de longueur :\n${limits}`,
    GRID,
    `Catégories YouTube :\n${CATEGORIES.map((c) => `- ${c.id} : ${c.name}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

module.exports = { CATEGORIES, DEFAULT_CATEGORY, categoryOf, Advice, SYSTEM, adviceMessage, geminiSchema };
