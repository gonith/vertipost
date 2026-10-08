const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

// Dimensions et durée, ou null si ffprobe est absent ou ne comprend pas le fichier :
// les contrôles de format sont un confort, pas une condition pour publier.
function probe(filePath) {
  const args = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
    '-of', 'json',
    filePath,
  ];
  return new Promise((resolve) => {
    execFile('ffprobe', args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams[0];
        // Un téléphone filme souvent en paysage avec une consigne de rotation : c'est l'image
        // affichée qui compte.
        const rotation = (stream.side_data_list || []).map((s) => s.rotation).find((r) => r !== undefined) || 0;
        const turned = Math.abs(rotation) % 180 === 90;
        resolve({
          width: turned ? stream.height : stream.width,
          height: turned ? stream.width : stream.height,
          duration: Number(data.format.duration),
        });
      } catch {
        resolve(null);
      }
    });
  });
}

async function inspect(filePath) {
  const mime = MIME[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error('Format non pris en charge : il faut un fichier .mp4 ou .mov.');
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error('Fichier vide ou illisible.');
  return {
    path: filePath,
    name: path.basename(filePath),
    url: pathToFileURL(filePath).href,
    size: stat.size,
    mime,
    info: await probe(filePath),
  };
}

module.exports = { inspect };
