const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');

const MIME = { '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

// Vrai si l'index du fichier (moov) précède les images (mdat), null si on ne sait pas le dire.
async function moovFirst(filePath) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const head = Buffer.alloc(16);
    let position = 0;
    for (let i = 0; i < 64; i++) {
      const { bytesRead } = await handle.read(head, 0, 16, position);
      if (bytesRead < 8) return null;
      const type = head.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      // Une taille de 1 annonce la vraie taille sur les huit octets suivants.
      const size = head.readUInt32BE(0) === 1 ? Number(head.readBigUInt64BE(8)) : head.readUInt32BE(0);
      if (size < 8) return null;
      position += size;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (handle) await handle.close();
  }
}

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : undefined);

// « 60000/1001 » donne 59,94.
function rate(text) {
  const [n, d] = (text || '').split('/').map(Number);
  return n && d ? n / d : undefined;
}

// Dimensions, durée et format, ou null si ffprobe est absent ou ne comprend pas le fichier :
// les contrôles de format sont un confort, pas une condition pour publier.
function probe(filePath) {
  const args = [
    '-v', 'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels:stream_side_data=rotation:format=duration,bit_rate',
    '-of', 'json',
    filePath,
  ];
  return new Promise((resolve) => {
    execFile('ffprobe', args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams.find((s) => s.codec_type === 'video');
        const audio = data.streams.find((s) => s.codec_type === 'audio') || {};
        // Un téléphone filme souvent en paysage avec une consigne de rotation : c'est l'image
        // affichée qui compte.
        const rotation = (stream.side_data_list || []).map((s) => s.rotation).find((r) => r !== undefined) || 0;
        const turned = Math.abs(rotation) % 180 === 90;
        resolve({
          width: turned ? stream.height : stream.width,
          height: turned ? stream.width : stream.height,
          duration: Number(data.format.duration),
          videoCodec: stream.codec_name,
          fps: rate(stream.avg_frame_rate),
          bitrate: number(data.format.bit_rate),
          audioCodec: audio.codec_name,
          sampleRate: number(audio.sample_rate),
          channels: number(audio.channels),
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
  const info = await probe(filePath);
  return {
    path: filePath,
    name: path.basename(filePath),
    url: pathToFileURL(filePath).href,
    size: stat.size,
    mime,
    info: info && { ...info, size: stat.size, moovFirst: await moovFirst(filePath) },
  };
}

module.exports = { inspect };
