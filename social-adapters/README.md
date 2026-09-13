# social-adapters — couche sociale de l’intelligence (TikTok / YouTube / Facebook)

Assemble et réutilise l’existant — **ne duplique aucun moteur** :

| Module | Rôle | Réutilise |
| --- | --- | --- |
| `comment-replier.js` | Analyse émotionnelle du commentaire + choix de la réponse | `lib/intelligence/human-context-engine.js` (UMD, navigateur **et** Node) |
| `publishers.js` | Pont réseau réel (envoi / listing) par plateau | `adapters/facebook.js`, `adapters/media_publisher.js` |
| `video-generator.js` | Génération vidéo `GENERATE_VIDEO` | `lib/media/videoAiEngine.js` (cascade Fal→Replicate→HF) |
| `index.js` | Assemble `createSocialAdapters(deps)` consommable par le registre d’actions | — |

## Garanties

- **Zéro-effet par défaut** : aucune méthode ne fait d’appel réseau tant qu’un
  adaptateur réel n’est pas injecté (`{ ok:false, error:'RUNTIME_MISSING:…' }`),
  même convention que le runtime d’actions `lib/intelligence/action-executor.js`
  et que le bridge VPS `lib/intelligence/vps-bridge.js` (`runtime: null` = parité
  de non-effet entre les trois couches).
- **Honnêteté des replis** : TikTok n’a pas d’API publique de réponse à un
  commentaire → erreur explicite `NO_PUBLIC_REPLY_API:TIKTOK` + suggestion
  (réponse manuelle / liens `wa.me`, `t.me` = Mode Manuel Express existant).
  Aucun fournisseur vidéo configuré → `kind:'not_configured'`, le repli officiel
  de `videoAiEngine.js` est l’export Ken Burns client (déjà en production).

## Branchement (optionnel — à la main de l’intégrateur)

```js
const { createSocialAdapters } = require('./social-adapters');
const FacebookAdapter = require('./adapters/facebook');
const { MediaPublisherAdapter } = require('./adapters/media_publisher');

const social = createSocialAdapters({
  humanContext: require('./lib/intelligence/human-context-engine'),
  publishers: { facebook: new FacebookAdapter(), media: new MediaPublisherAdapter() },
});

// Actions utilisables comme runtime du bridge :
//   social.replyComment('FACEBOOK', commentId, text, payload)
//   social.publishVideo({ buffer, title }, { channel: 'TIKTOK' })
//   social.analyzeComments(comments)
```

Depuis `lib/intelligence/action-executor.js`, les actions `REPLY_COMMENT` et
`GENERATE_VIDEO` appellent `runtime.replyComment(...)` / `runtime.generateVideo(...)`
— injecter `createSocialAdapters` en tant que runtime (ou fusionner ses méthodes)
branche la couche sociale sur l’Automation Engine sans modifier un seul moteur.

## Note sur les tokens

Les adaptateurs réels lèvent leurs propres erreurs (`FB_NOT_CONFIGURED`,
`YOUTUBE_NOT_CONFIGURED`, `TIKTOK_NOT_CONFIGURED`) quand les jetons des
`token.json` / variables d’environnement sont absents — cohérent avec le
principe "zéro-coût" (aucune clé payante requise pour l’analyse/réponse de
commentaire hors envoi effectif).