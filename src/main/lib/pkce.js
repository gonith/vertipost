const crypto = require('crypto');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// TikTok attend le SHA256 en hexadécimal, là où la RFC 7636 (Google) le veut en base64url.
function challenge(verifier, encoding = 'base64url') {
  return crypto.createHash('sha256').update(verifier).digest(encoding);
}

module.exports = { randomToken, challenge };
