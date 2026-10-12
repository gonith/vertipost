const test = require('node:test');
const assert = require('node:assert/strict');
const { challenge } = require('../src/main/lib/pkce');
const { MB, fixedChunks, tiktokPlan } = require('../src/main/lib/chunks');
const { captionFor, warnings } = require('../src/main/lib/rules');
const { adviceMessage, categoryOf, geminiSchema } = require('../src/main/lib/advice');
const { keywordsOf, checklist } = require('../src/main/lib/score');
const { GRACE_MS, split } = require('../src/main/lib/schedule');

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

test('fixedChunks couvre le fichier sans trou ni recouvrement', () => {
  for (const size of [1, 4 * MB, 4 * MB + 1, 9 * MB + 123]) {
    const chunks = fixedChunks(size, 4 * MB);
    assertCovers(chunks, size);
    assert.equal(chunks.length, Math.ceil(size / (4 * MB)));
  }
});

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
  const post = { caption: 'commune', overrides: { x: 'pour X', youtube: '   ' } };
  assert.equal(captionFor('x', post), 'pour X');
  assert.equal(captionFor('youtube', post), 'commune');
  assert.equal(captionFor('instagram', post), 'commune');
});

test('warnings signale longueur, titre, orientation et durée', () => {
  const vertical = { width: 1080, height: 1920, duration: 30 };
  assert.deepEqual(warnings('youtube', { title: 'ok', caption: 'ok' }, vertical), []);
  assert.equal(warnings('youtube', { title: '', caption: '' }, vertical).length, 1);
  assert.equal(warnings('x', { caption: 'a'.repeat(281) }, vertical).length, 1);
  assert.equal(warnings('x', { caption: 'a'.repeat(281), overrides: { x: 'court' } }, vertical).length, 0);
  assert.equal(warnings('instagram', { caption: '' }, { width: 1920, height: 1080, duration: 30 }).length, 1);
  assert.equal(warnings('x', { caption: '' }, { ...vertical, duration: 141 }).length, 1);
  assert.deepEqual(warnings('tiktok', { caption: '' }, null), []);
});

test("adviceMessage porte la description, le brouillon, les limites et les catégories ; categoryOf retombe sur la catégorie par défaut", () => {
  const message = adviceMessage({ brief: ' Mon jeu de plateforme ', post: { title: 'Niveau 3', caption: '' }, info: null });
  assert.match(message, /Ma vidéo :\nMon jeu de plateforme\n/);
  assert.match(message, /Titre : Niveau 3\nLégende : \(vide\)/);
  assert.match(message, /- x : légende 280 caractères/);
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

test('split : une programmation en retard part dans le délai toléré, sinon elle est manquée', () => {
  const now = 1_000_000_000;
  const job = (id, at, status = 'pending') => ({ id, at, status });
  const jobs = [job('futur', now + 1), job('pile', now), job('limite', now - GRACE_MS), job('tard', now - GRACE_MS - 1), job('faite', now - 5, 'done')];
  const { due, missed } = split(jobs, now);
  assert.deepEqual(due.map((j) => j.id), ['pile', 'limite']);
  assert.deepEqual(missed.map((j) => j.id), ['tard']);
});
