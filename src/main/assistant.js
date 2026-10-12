const { Anthropic } = require('@anthropic-ai/sdk');
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { Advice, SYSTEM, adviceMessage, categoryOf } = require('./lib/advice');

const MODEL = 'claude-opus-5-5';

function explain(error) {
  if (error instanceof Anthropic.AuthenticationError) return 'Clé API refusée par Anthropic : vérifie-la dans les réglages de l\'assistant.';
  if (error instanceof Anthropic.PermissionDeniedError) return `Cette clé API n'a pas accès au modèle ${MODEL}.`;
  if (error instanceof Anthropic.RateLimitError) return 'Trop de demandes ou crédits épuisés chez Anthropic : réessaie dans un moment.';
  if (error instanceof Anthropic.APIConnectionError) return "Impossible de joindre Anthropic : vérifie la connexion Internet.";
  if (error instanceof Anthropic.APIError) return `Anthropic a répondu ${error.status} : ${error.message.slice(0, 600)}`;
  return error.message;
}

async function advise(apiKey, input) {
  const client = new Anthropic({ apiKey });
  let response;
  try {
    response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // Si le modèle décline la demande, Anthropic la rejoue sur son modèle de repli.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content: adviceMessage(input) }],
      output_config: { effort: 'medium', format: betaZodOutputFormat(Advice) },
    });
  } catch (e) {
    throw new Error(explain(e));
  }
  if (response.stop_reason === 'refusal') throw new Error("L'assistant a décliné cette demande. Reformule la description de la vidéo.");
  if (!response.parsed_output) throw new Error("La réponse de l'assistant est incomplète. Réessaie.");
  // Le schéma ne peut pas borner la catégorie à la liste : une valeur inconnue retombe sur celle par défaut.
  return { ...response.parsed_output, categoryId: categoryOf(response.parsed_output.categoryId) };
}

// Même forme que les réglages d'une plateforme, pour réutiliser la même fenêtre.
const settings = {
  id: 'assistant',
  name: "l'assistant",
  fields: [{ key: 'apiKey', label: 'Clé API Anthropic', secret: true }],
  consoleUrl: 'https://platform.claude.com/settings/keys',
  help: [
    "L'assistant propose un titre, une catégorie YouTube et une légende par plateforme, et explique ses choix. Il s'appuie sur Claude, le modèle d'Anthropic.",
    'Crée un compte sur la console Anthropic, ajoute des crédits prépayés, puis génère une clé API.',
    "Chaque proposition est facturée à l'usage sur ces crédits. La description de ta vidéo, ton titre et ta légende sont envoyés à Anthropic ; la vidéo elle-même ne l'est pas.",
  ],
};

module.exports = { advise, settings };
