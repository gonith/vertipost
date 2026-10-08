const MB = 1024 * 1024;

// Découpe [0, size) en tranches de `chunkSize` octets, la dernière prenant le reste.
function fixedChunks(size, chunkSize) {
  const chunks = [];
  for (let start = 0; start < size; start += chunkSize) {
    chunks.push({ start, end: Math.min(start + chunkSize, size) - 1 });
  }
  return chunks;
}

// Règles TikTok : une tranche fait entre 5 et 64 Mo, le nombre de tranches est
// floor(taille / tranche), et c'est la DERNIÈRE qui absorbe le reste (128 Mo au plus).
// En dessous de 64 Mo, le fichier part d'un seul bloc.
function tiktokPlan(size, chunkSize = 10 * MB) {
  if (size <= 64 * MB) {
    return { chunkSize: size, chunks: [{ start: 0, end: size - 1 }] };
  }
  const count = Math.floor(size / chunkSize);
  const chunks = [];
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    chunks.push({ start, end: i === count - 1 ? size - 1 : start + chunkSize - 1 });
  }
  return { chunkSize, chunks };
}

module.exports = { MB, fixedChunks, tiktokPlan };
