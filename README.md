# Vertipost

Application Windows qui publie une vidéo verticale sur YouTube Shorts, Instagram Reels, TikTok
et X en une fois, par les API officielles de chaque plateforme.

```
npm install
npm start        # lancer l'application
npm test         # tests unitaires
npm run dist     # construire l'installateur Windows dans dist/
```

## Avant la première publication

Chaque plateforme demande de créer une « application développeur » à ton nom. Dans Vertipost,
le bouton **Configurer** de chaque carte donne les étapes, l'adresse de redirection à déclarer
et les champs où coller les identifiants. Ils sont enregistrés chiffrés par Windows, dans le
profil de l'application, et ne quittent pas la machine.

| Plateforme | Ce qu'il faut savoir |
|---|---|
| YouTube | Les vidéos restent en privé tant que le projet Google n'a pas passé l'audit de conformité. 100 envois par jour. |
| Instagram | Compte Créateur ou Business, relié à une Page Facebook. Connexion à refaire tous les 60 jours environ. |
| TikTok | Envoi en brouillon : la légende et la publication se font dans l'application TikTok. |
| X | API payante à l'usage, crédits prépayés. |

## Assistant de référencement

L'assistant propose un titre, une catégorie YouTube et une légende par plateforme à partir d'une
description de la vidéo, et explique ses choix. Il appelle au choix Gemini (clé gratuite de Google
AI Studio) ou Claude (clé Anthropic, facturée à l'usage), à régler avec le bouton **Configurer** de
l'assistant. Il n'a pas accès à des données de recherche ou de tendances : ses propositions
reposent sur les règles générales du format court.

La grille **Pertinence** fonctionne sans IA : elle coche, à partir de tes mots-clés de niche, les
bonnes pratiques que ton titre et ta légende respectent (`src/main/lib/score.js`).

## Organisation du code

- `src/main/platforms/` : une plateforme par fichier, avec la même forme (`connect`, `publish`).
- `src/main/oauth.js` : connexion par le navigateur, retour sur `127.0.0.1:8765`.
- `src/main/assistant.js` : appel à Gemini ou à Claude ; la consigne et le schéma de réponse sont dans `src/main/lib/advice.js`.
- `src/main/store.js` : identifiants et jetons chiffrés.
- `src/main/lib/` : logique sans dépendance à Electron, couverte par `test/`.
- `src/renderer/` : l'interface.

`ffprobe` est facultatif : s'il est dans le `PATH`, l'application vérifie l'orientation et la
durée de la vidéo avant l'envoi.
