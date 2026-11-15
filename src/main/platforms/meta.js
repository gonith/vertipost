const { authorize, PORT } = require('../oauth');
const { request } = require('../lib/http');

// Instagram et Facebook passent par la même application Meta et le même Facebook Login for
// Business. Meta n'accepte un retour en http que sur « localhost », et seulement en mode développement.
const REDIRECT = `http://localhost:${PORT}/callback`;
const VERSION = 'v26.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;

const query = (params) => new URLSearchParams(params).toString();

// Connexion de l'utilisateur, puis échange du jeton d'une heure contre un jeton d'environ 60 jours.
async function login(config, scopes) {
  const { code } = await authorize({
    authUrl: `https://www.facebook.com/${VERSION}/dialog/oauth`,
    params: { client_id: config.clientId, response_type: 'code', scope: scopes.join(',') },
    redirectUri: REDIRECT,
    pkce: null,
  });
  const app = { client_id: config.clientId, client_secret: config.clientSecret };
  const short = await request(`${GRAPH}/oauth/access_token?${query({ ...app, redirect_uri: REDIRECT, code })}`);
  const long = await request(
    `${GRAPH}/oauth/access_token?${query({
      ...app,
      grant_type: 'fb_exchange_token',
      fb_exchange_token: short.data.access_token,
    })}`,
  );
  return {
    access: long.data.access_token,
    expiresAt: Date.now() + (long.data.expires_in || 60 * 24 * 3600) * 1000,
  };
}

// Les Pages Facebook que l'utilisateur a autorisées, avec les champs demandés.
async function pages(access, fields) {
  const res = await request(`${GRAPH}/me/accounts?${query({ fields, access_token: access, limit: 100 })}`);
  return res.data.data || [];
}

// Une seule possibilité est prise d'office ; sinon l'utilisateur choisit.
async function pick(items, label, choose, message) {
  if (items.length < 2) return items[0];
  return items[await choose(message, items.map(label))];
}

const fields = [
  { key: 'clientId', label: "ID de l'application" },
  { key: 'clientSecret', label: 'Clé secrète', secret: true },
];

module.exports = { REDIRECT, GRAPH, query, login, pages, pick, fields };
