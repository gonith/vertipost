const { z } = require('zod');
const { Anthropic } = require('@anthropic-ai/sdk');
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { request, sleep } = require('./lib/http');
const { Advice, SYSTEM, adviceMessage, categoryOf, geminiSchema } = require('./lib/advice');

const CLAUDE_MODEL = 'claude-opus-5-5';
// Modèles gratuits, du meilleur au plus léger : on descend quand l'un est saturé ou a épuisé son quota.
const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const BUSY = [429, 503];

function explain(error) {
  if (error instanceof Anthropic.AuthenticationError) return "Clé API refusée par Anthropic : vérifie-la dans les réglages de l'assistant.";
  if (error instanceof Anthropic.PermissionDeniedError) return `Cette clé API n'a pas accès au modèle ${CLAUDE_MODEL}.`;
  if (error instanceof Anthropic.RateLimitError) return 'Trop de demandes ou crédits épuisés chez Anthropic : réessaie dans un moment.';
  if (error instanceof Anthropic.APIConnectionError) return 'Impossible de joindre Anthropic : vérifie la connexion Internet.';
  if (error instanceof Anthropic.APIError) return `Anthropic a répondu ${error.status} : ${error.message.slice(0, 600)}`;
  return error.message;
}

async function claude(apiKey, input) {
  const client = new Anthropic({ apiKey });
  let response;
  try {
    response = await client.beta.messages.parse({
      model: CLAUDE_MODEL,
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
  return response.parsed_output;
}

async function geminiCall(apiKey, input) {
  const json = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: adviceMessage(input) }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: geminiSchema(z.toJSONSchema(Advice)) },
  };
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      return (await request(url, { headers: { 'x-goog-api-key': apiKey }, json })).data;
    } catch (e) {
      if (!BUSY.includes(e.status)) throw e;
      await sleep(1000);
    }
  }
  throw new Error('Gemini est saturé ou ton quota gratuit du jour est épuisé. Réessaie dans quelques minutes.');
}

async function gemini(apiKey, input) {
  const data = await geminiCall(apiKey, input);
  const candidate = (data.candidates || [])[0];
  if (!candidate) {
    const reason = data.promptFeedback && data.promptFeedback.blockReason;
    throw new Error(`Gemini n'a rien répondu${reason ? ` (${reason})` : ''}. Reformule la description de la vidéo.`);
  }
  // Les passages de réflexion du modèle arrivent dans la même liste, marqués `thought`.
  const text = ((candidate.content && candidate.content.parts) || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('');
  try {
    return Advice.parse(JSON.parse(text));
  } catch {
    throw new Error(`La réponse de Gemini est incomplète (${candidate.finishReason || 'raison inconnue'}). Réessaie.`);
  }
}

const PROVIDERS = {
  gemini: { key: 'geminiKey', run: gemini },
  claude: { key: 'anthropicKey', run: claude },
};

const providerOf = (config) => PROVIDERS[config.provider] || PROVIDERS.gemini;
const configured = (config) => Boolean(config[providerOf(config).key]);

async function advise(config, input) {
  const provider = providerOf(config);
  const advice = await provider.run(config[provider.key], input);
  // Aucun des deux schémas ne borne la catégorie à la liste : une valeur inconnue retombe sur celle par défaut.
  return { ...advice, categoryId: categoryOf(advice.categoryId) };
}

// Même forme que les réglages d'une plateforme, pour réutiliser la même fenêtre.
const settings = {
  id: 'assistant',
  name: "l'assistant",
  fields: [
    {
      key: 'provider',
      label: 'IA utilisée',
      options: [
        { value: 'gemini', label: 'Gemini (Google), gratuit' },
        { value: 'claude', label: 'Claude (Anthropic), payant' },
      ],
    },
    { key: 'geminiKey', label: 'Clé API Gemini', secret: true, optional: true },
    { key: 'anthropicKey', label: 'Clé API Anthropic', secret: true, optional: true },
  ],
  consoleUrl: 'https://aistudio.google.com/apikey',
  help: [
    "L'assistant propose un titre, une catégorie YouTube et une légende par plateforme, et explique ses choix. Il lui faut la clé API de l'IA choisie ; l'autre peut rester vide.",
    'Gemini : crée une clé gratuite sur Google AI Studio (bouton ci-dessous). Le nombre de demandes par jour est limité, et Google utilise le contenu des demandes gratuites pour améliorer ses produits.',
    'Claude : crée une clé sur platform.claude.com après y avoir ajouté des crédits prépayés. Chaque proposition est facturée à l\'usage.',
    "La description de ta vidéo, tes mots-clés, ton titre et ta légende sont envoyés à l'IA choisie ; la vidéo elle-même ne l'est pas.",
  ],
};

module.exports = { advise, configured, settings };
