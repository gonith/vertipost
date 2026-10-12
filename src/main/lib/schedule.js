// Retard toléré : Vertipost a pu être rouvert, ou l'ordinateur réveillé, un peu après l'heure.
// Au-delà, publier d'office surprendrait : la programmation est marquée manquée et l'utilisateur décide.
const GRACE_MS = 10 * 60 * 1000;

// Répartit les programmations en attente dont l'heure est passée.
function split(jobs, now) {
  const late = jobs.filter((j) => j.status === 'pending' && j.at <= now);
  return {
    due: late.filter((j) => now - j.at <= GRACE_MS),
    missed: late.filter((j) => now - j.at > GRACE_MS),
  };
}

module.exports = { GRACE_MS, split };
