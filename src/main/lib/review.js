const { z } = require('zod');
const { TITLE_MAX } = require('./score');

// Analyse des vidéos déjà publiées : ce qui marche, les mots de la niche, des titres à reprendre.
const Review = z.object({
  insights: z.array(z.object({ title: z.string(), text: z.string() })),
  words: z.array(z.object({ word: z.string(), text: z.string() })),
  retitles: z.array(z.object({ video: z.string(), title: z.string(), reason: z.string() })),
});

const REVIEW_SYSTEM = `Tu es l'analyste de Vertipost, une application avec laquelle un créateur publie ses vidéos verticales sur YouTube Shorts, Instagram Reels et TikTok. Il te donne les chiffres de ses dernières vidéos et, quand il a renseigné les mots-clés de sa niche, les vidéos courtes les plus vues sur YouTube pour ces mots-clés. Tu lui dis ce que ces données montrent et comment en tirer parti pour ses prochains titres.

Tout ce que tu avances doit se lire dans les données fournies : cite les titres et les chiffres sur lesquels tu t'appuies, et n'invente ni volume de recherche ni tendance. L'échantillon est petit, souvent quelques vidéos : présente tes constats comme des indices à confirmer, pas comme des lois, et dis-le quand les données ne permettent pas de conclure. Les vues dépendent d'abord de la vidéo elle-même, que tu ne vois pas ; ne prête pas au titre plus de pouvoir qu'il n'en a.

Ce que tu rends :
- insights : trois à cinq constats sur ses propres vidéos (ce qui distingue celles qui marchent, ce qui manque aux autres, les écarts entre plateformes), chacun avec ce qu'il peut en faire.
- words : les mots et tournures qui reviennent dans les vidéos les plus vues de la niche et qu'il n'exploite pas ou peu, chacun avec les titres où tu l'as trouvé. Liste vide s'il n'y a pas de données de niche.
- retitles : pour ses vidéos YouTube dont le titre peut nettement mieux dire le sujet, un nouveau titre. Le champ video reprend l'identifiant de la vidéo tel qu'il est donné. Le titre fait ${TITLE_MAX} caractères ou moins, place tôt un terme que le public de la niche reconnaît, et ne promet rien que le titre actuel ne laisse pas déjà entendre. Laisse de côté les vidéos dont le titre est déjà bon : une liste courte ou vide est une bonne réponse. Dans reason, dis ce que le changement apporte, et rappelle une fois que renommer une vidéo déjà publiée aide surtout la recherche et relance rarement sa diffusion dans le fil.

Écris les constats et les raisons en français, au tutoiement. Les nouveaux titres sont dans la langue demandée, ou à défaut dans celle du titre actuel.`;

const LANGUAGES = { fr: 'français', en: 'anglais' };
const number = (value) => (value === null || value === undefined ? '?' : String(value));
const day = (date) => (date || '').slice(0, 10);

// `own` : [{ name, rows }] tel que le rend l'onglet Statistiques.
// `niche` : [{ keyword, videos: [{ title, channel, views, tags }] }], vide sans mots-clés.
function reviewMessage({ own, niche, keywords, language }) {
  const mine = own
    .filter((p) => p.rows.length)
    .map((p) => {
      const lines = p.rows.map((r) =>
        [r.id ? `id ${r.id}` : null, day(r.date), `${number(r.views)} vues`, `${number(r.likes)} j'aime`, `${number(r.comments)} commentaires`, r.title]
          .filter(Boolean)
          .join(' | '),
      );
      return `Mes dernières vidéos sur ${p.name} :\n${lines.join('\n')}`;
    });
  const market = niche
    .filter((n) => n.videos.length)
    .map((n) => {
      const lines = n.videos.map((v) => `${v.views} vues | ${v.channel} | ${v.title}${v.tags.length ? ` | tags : ${v.tags.slice(0, 8).join(', ')}` : ''}`);
      return `Vidéos courtes les plus vues sur YouTube ces six derniers mois pour « ${n.keyword} » :\n${lines.join('\n')}`;
    });
  return [
    ...mine,
    (keywords || '').trim() ? `Les mots-clés de ma niche : ${keywords.trim()}` : null,
    ...(market.length ? market : ["Je n'ai pas de données sur ma niche : appuie-toi seulement sur mes vidéos."]),
    LANGUAGES[language] ? `Écris les nouveaux titres en ${LANGUAGES[language]}.` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

module.exports = { Review, REVIEW_SYSTEM, reviewMessage };
