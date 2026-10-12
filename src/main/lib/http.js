const https = require('https');
const fs = require('fs');

// L'URL complète n'apparaît jamais dans une erreur : chez Meta, le jeton voyage en paramètre.
function label(method, url) {
  const u = new URL(url);
  return `${method} ${u.host}${u.pathname}`;
}

function parse(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function request(url, { method, headers = {}, form, json, body } = {}) {
  const h = { ...headers };
  if (form) {
    body = new URLSearchParams(form).toString();
    h['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (json !== undefined) {
    body = JSON.stringify(json);
    h['Content-Type'] = 'application/json; charset=UTF-8';
  }
  const verb = method || (body === undefined ? 'GET' : 'POST');
  const res = await fetch(url, { method: verb, headers: h, body });
  const text = await res.text();
  if (!res.ok) {
    throw Object.assign(new Error(`${label(verb, url)} a répondu ${res.status} : ${text.slice(0, 600)}`), { status: res.status });
  }
  return { status: res.status, headers: res.headers, data: parse(text) };
}

// Envoie les octets [start, end] d'un fichier sans le charger en mémoire.
// Ne rejette que sur une panne réseau : c'est à l'appelant de juger le code HTTP.
function sendFile(url, { method = 'PUT', headers = {}, filePath, start, end, onProgress }) {
  return new Promise((resolve, reject) => {
    const length = end - start + 1;
    const req = https.request(url, { method, headers: { ...headers, 'Content-Length': length } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, data: parse(text) });
      });
    });
    req.on('error', reject);
    const stream = fs.createReadStream(filePath, { start, end });
    let sent = 0;
    stream.on('data', (c) => {
      sent += c.length;
      if (onProgress) onProgress(sent / length);
    });
    stream.on('error', (e) => req.destroy(e));
    stream.pipe(req);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { request, sendFile, sleep, label };
