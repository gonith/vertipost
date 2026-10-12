const test = require('node:test');
const assert = require('node:assert/strict');
const { challenge } = require('../src/main/lib/pkce');
const { MB, tiktokPlan } = require('../src/main/lib/chunks');
const { captionFor, warnings, lighterSize } = require('../src/main/lib/rules');
const { adviceMessage, categoryOf, geminiSchema } = require('../src/main/lib/advice');
const { keywordsOf, checklist } = require('../src/main/lib/score');
const { reviewMessage } = require('../src/main/lib/review');

test('challenge PKCE : vecteur de la RFC 7636 en base64url, même condensat en hex pour TikTok', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(challenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(challenge(verifier, 'hex'), Buffer.from(challenge(verifier), 'base64url').toString('hex'));
});

function assertCovers(chunks, size) {
  let next = 0;
  for (const c of chunks) {
    assert.equal(c.start, next);
    assert.ok(c.end >= c.start);
    next = c.end + 1;
  }
  assert.equal(next, size);
}

test('tiktokPlan : un seul bloc jusqu\'à 64 Mo', () => {
  for (const size of [1, 3 * MB, 64 * MB]) {
    const plan = tiktokPlan(size);
    assert.equal(plan.chunks.length, 1);
    assert.equal(plan.chunkSize, size);
    assertCovers(plan.chunks, size);
  }
});

test('tiktokPlan : au-delà, floor(taille / tranche) tranches et la dernière absorbe le reste', () => {
  for (const size of [64 * MB + 1, 100 * MB, 105 * MB + 7, 999 * MB + 999]) {
    const plan = tiktokPlan(size);
    assertCovers(plan.chunks, size);
    assert.equal(plan.chunks.length, Math.floor(size / plan.chunkSize));
    const sizes = plan.chunks.map((c) => c.end - c.start + 1);
    for (const s of sizes.slice(0, -1)) assert.equal(s, plan.chunkSize);
    assert.ok(sizes.at(-1) >= plan.chunkSize && sizes.at(-1) <= 128 * MB);
    assert.ok(plan.chunkSize >= 5 * MB && plan.chunkSize <= 64 * MB);
  }
});

test('captionFor préfère la légende propre à la plateforme, sauf si elle est vide', () => {
  const post = { caption: 'commune', overrides: { tiktok: 'pour TikTok', youtube: '   ' } };
  assert.equal(captionFor('tiktok', post), 'pour TikTok');
  assert.equal(captionFor('youtube', post), 'commune');
  assert.equal(captionFor('instagram', post), 'commune');
});

test('warnings signale longueur, titre, orientation et durée', () => {
  const vertical = { width: 1080, height: 1920, duration: 30 };
  assert.deepEqual(warnings('youtube', { title: 'ok', caption: 'ok' }, vertical), []);
  assert.equal(warnings('youtube', { title: '', caption: '' }, vertical).length, 1);
  assert.equal(warnings('tiktok', { caption: 'a'.repeat(2201) }, vertical).length, 1);
  assert.equal(warnings('tiktok', { caption: 'a'.repeat(2201), overrides: { tiktok: 'court' } }, vertical).length, 0);
  assert.equal(warnings('instagram', { caption: '' }, { width: 1920, height: 1080, duration: 30 }).length, 1);
  assert.equal(warnings('tiktok', { caption: '' }, { ...vertical, duration: 601 }).length, 1);
  assert.deepEqual(warnings('tiktok', { caption: '' }, null), []);
});

test("adviceMessage porte la description, le brouillon, les limites et les catégories ; categoryOf retombe sur la catégorie par défaut", () => {
  const message = adviceMessage({ brief: ' Mon jeu de plateforme ', post: { title: 'Niveau 3', caption: '' }, info: null });
  assert.match(message, /Ma vidéo :\nMon jeu de plateforme\n/);
  assert.match(message, /Titre : Niveau 3\nLégende : \(vide\)/);
  assert.match(message, /- tiktok : légende 2200 caractères/);
  assert.doesNotMatch(message, /- x :/);
  assert.match(message, /- 20 : Jeux vidéo/);
  assert.match(message, /pas encore choisi les mots-clés/);
  assert.match(message, /dans ses 40 premiers caractères, et fait 60 caractères ou moins/);
  assert.match(adviceMessage({ brief: 'x', keywords: ' roguelike ', post: {}, info: null }), /Les mots-clés de ma niche : roguelike\n/);
  assert.doesNotMatch(message, /Format :/);
  assert.doesNotMatch(message, /Écris le titre/);
  assert.match(adviceMessage({ brief: 'x', language: 'en', post: {}, info: null }), /Écris le titre, les légendes et les hashtags en anglais/);
  assert.equal(categoryOf('20'), '20');
  assert.equal(categoryOf('999'), '22');
  assert.equal(categoryOf(undefined), '22');
});

test('geminiSchema retire $schema et additionalProperties à tous les niveaux', () => {
  const schema = { $schema: 'x', type: 'object', additionalProperties: false, properties: { a: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['b'] } } } };
  assert.deepEqual(geminiSchema(schema), { type: 'object', properties: { a: { type: 'array', items: { type: 'object', required: ['b'] } } } });
});

test('checklist : tout est coché sur un texte conforme, sans casse ni accents', () => {
  assert.deepEqual(keywordsOf(' Bomb Arena, Jeu Indé ,,bomb arena'), ['bomb arena', 'jeu inde']);
  const rules = checklist({
    title: 'Bomb Arena : le combo impossible',
    caption: 'Un combo jamais vu dans ce jeu indé.\n#BombArena #jeuindé #gaming',
    keywords: 'Bomb Arena, jeu indé',
  });
  assert.deepEqual(rules.filter((r) => !r.ok).map((r) => r.label), []);
});

test('checklist : signale chaque manque', () => {
  const failed = (input) => checklist(input).filter((r) => !r.ok).length;
  assert.equal(failed({ title: '', caption: '', keywords: '' }), 8);
  const long = `${'x'.repeat(50)} bomb arena ${'x'.repeat(20)}`;
  const rules = checklist({ title: long, caption: '#bombarena en premier', keywords: 'bomb arena' });
  assert.deepEqual(rules.map((r) => r.ok), [true, true, false, false, false, false, false, true]);
});

test("warnings : le format d'un Reel n'est contrôlé que pour Instagram, et seulement sur les données connues", () => {
  const post = { title: 'T', caption: 'c' };
  const good = { width: 1080, height: 1920, duration: 30, size: 50 * MB, videoCodec: 'h264', fps: 30, bitrate: 8e6, audioCodec: 'aac', sampleRate: 48000, channels: 2, moovFirst: true };
  assert.deepEqual(warnings('instagram', post, good), []);
  assert.deepEqual(warnings('instagram', post, { width: 1080, height: 1920, duration: 30 }), []);
  const bad = { ...good, width: 2160, height: 3840, size: 400 * MB, videoCodec: 'vp9', fps: 120, bitrate: 40e6, audioCodec: 'opus', sampleRate: 96000, channels: 6, duration: 2, moovFirst: false };
  assert.equal(warnings('instagram', post, bad).length, 11);
  assert.deepEqual(warnings('youtube', post, bad), []);
});

test('lighterSize : rien pour une vidéo courte, une largeur paire sous le volume admis sinon', () => {
  const hd = { width: 1080, height: 1920, fps: 30 };
  assert.equal(lighterSize({ ...hd, duration: 30 }), null);
  assert.equal(lighterSize(null), null);
  const long = lighterSize({ ...hd, duration: 66 });
  assert.equal(long.width % 2, 0);
  assert.ok(long.width >= 720 && long.width < 760, String(long.width));
  assert.ok(long.width * (long.width * 16 / 9) * 30 * 66 <= 1.9e9);
  // Une cadence élevée est ramenée à 30 images par seconde avant de toucher à la taille.
  assert.deepEqual(lighterSize({ ...hd, fps: 60, duration: 20 }), { width: 1080, fps: 30 });
});

test("reviewMessage : mes vidéos avec leur identifiant, la niche quand elle existe, la langue demandée", () => {
  const own = [
    { name: 'YouTube Shorts', rows: [{ id: 'abc', title: 'Mon titre', date: '2026-10-08T10:00:00Z', views: 543, likes: 5, comments: 4 }] },
    { name: 'Instagram Reels', rows: [{ title: 'Un Reel', date: '2026-10-07T10:00:00Z', views: null, likes: 11, comments: 0 }] },
    { name: 'TikTok', rows: [] },
  ];
  const bare = reviewMessage({ own, niche: [], keywords: '', language: '' });
  assert.match(bare, /Mes dernières vidéos sur YouTube Shorts :\nid abc \| 2026-10-08 \| 543 vues \| 5 j'aime \| 4 commentaires \| Mon titre/);
  assert.match(bare, /Instagram Reels :\n2026-10-07 \| \? vues \| 11 j'aime/);
  assert.doesNotMatch(bare, /TikTok/);
  assert.match(bare, /pas de données sur ma niche/);
  const niche = [{ keyword: 'bomberman', videos: [{ title: 'Top', channel: 'Chaîne', views: 90000, tags: ['a', 'b'] }] }];
  const full = reviewMessage({ own, niche, keywords: 'bomberman', language: 'en' });
  assert.match(full, /pour « bomberman » :\n90000 vues \| Chaîne \| Top \| tags : a, b/);
  assert.match(full, /nouveaux titres en anglais/);
  assert.doesNotMatch(full, /pas de données sur ma niche/);
});
