const http = require('http');
const { shell } = require('electron');
const { randomToken, challenge } = require('./lib/pkce');

// Un seul port pour toutes les plateformes : X, TikTok et Meta exigent que l'adresse de
// retour soit déclarée à l'avance, caractère pour caractère.
const PORT = 8765;
const TIMEOUT_MS = 5 * 60 * 1000;

const PAGE = (message) => `<!doctype html><meta charset="utf-8"><title>Vertipost</title>
<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<p>${message}</p></body>`;

let pending = null;

// Ouvre le navigateur sur la page d'autorisation et attend le retour sur 127.0.0.1.
// `pkce` vaut 'base64url', 'hex' (TikTok) ou null (Meta n'en veut pas).
function authorize({ authUrl, params, redirectUri, pkce = 'base64url' }) {
  if (pending) pending.cancel(new Error('Connexion remplacée par une nouvelle demande.'));

  const state = randomToken(16);
  const verifier = pkce ? randomToken(48) : null;
  const url = new URL(authUrl);
  for (const [k, v] of Object.entries({ ...params, redirect_uri: redirectUri, state })) {
    url.searchParams.set(k, v);
  }
  if (pkce) {
    url.searchParams.set('code_challenge', challenge(verifier, pkce));
    url.searchParams.set('code_challenge_method', 'S256');
  }

  return new Promise((resolve, reject) => {
    const servers = [];
    const finish = (fn, value) => {
      clearTimeout(timer);
      pending = null;
      for (const s of servers) s.close();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Aucune réponse du navigateur après 5 minutes.')), TIMEOUT_MS);
    pending = { cancel: (e) => finish(reject, e) };

    const handler = (req, res) => {
      const got = new URL(req.url, redirectUri);
      if (!got.pathname.startsWith('/callback')) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const error = got.searchParams.get('error_description') || got.searchParams.get('error');
      if (error) {
        res.end(PAGE('La connexion a été refusée. Tu peux fermer cet onglet.'));
        finish(reject, new Error(`Autorisation refusée : ${error}`));
      } else if (got.searchParams.get('state') !== state) {
        res.end(PAGE('Réponse inattendue. Relance la connexion depuis Vertipost.'));
        finish(reject, new Error("Le paramètre state ne correspond pas : la réponse ne vient pas de cette demande."));
      } else {
        res.end(PAGE('Connexion réussie. Tu peux fermer cet onglet et revenir dans Vertipost.'));
        finish(resolve, { code: got.searchParams.get('code'), verifier, redirectUri });
      }
    };

    // « localhost » peut se résoudre en ::1 selon le navigateur : on écoute les deux.
    // L'IPv6 peut manquer sur la machine : seul l'échec en 127.0.0.1 est bloquant.
    for (const host of ['127.0.0.1', '::1']) {
      const server = http.createServer(handler);
      server.on('error', (e) => {
        if (host === '127.0.0.1') finish(reject, new Error(`Impossible d'écouter sur le port ${PORT} : ${e.message}`));
      });
      server.listen(PORT, host, () => {
        if (host === '127.0.0.1') shell.openExternal(url.toString());
      });
      servers.push(server);
    }
  });
}

module.exports = { authorize, PORT };
