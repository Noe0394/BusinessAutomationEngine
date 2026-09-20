# Configuration Cloudflare — pas à pas (à faire ensemble)

Objectif : licences (génération + vérification) et passerelle IA texte sur Cloudflare gratuit.
Rien n'a été déployé ; tout le code est prêt et testé en local.

Données mobiles : `npx wrangler` télécharge ~60 Mo la première fois. Prévoir le Wi-Fi si possible ;
ensuite chaque commande ne transfère que quelques Ko.

## 0. Contrôle hors-ligne
`node scripts/cloudflare-preflight.js` — liste ce qui reste à faire.

## 1. Compte Cloudflare
Compte gratuit sur dash.cloudflare.com (aucune carte requise pour Workers + D1 gratuits).

## 2. Connexion de wrangler
```
cd cloudflare/license-worker
npx wrangler login
```
(ouvre le navigateur ; autoriser). Vérifier : `npx wrangler whoami`.

## 3. Base D1
```
npx wrangler d1 create cyrus-licenses
```
Copier le `database_id` affiché dans `wrangler.toml` (remplace `REMPLACER_PAR_...`), puis :
```
npx wrangler d1 execute cyrus-licenses --remote --file=schema.sql
```

## 4. Secrets
```
node ../../scripts/cloudflare-preflight.js gen-secret      # génère un secret admin (à noter dans votre gestionnaire)
npx wrangler secret put ADMIN_SECRET                       # coller ce secret
# IA (facultatif, chaque clé peut être ajoutée plus tard) :
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put HUGGINGFACE_API_KEY
```
Les clés IA sont les mêmes que celles déjà utilisées par le VPS (jamais commitées).

## 5. Déploiement
```
npx wrangler deploy
```
Noter l'URL `https://cyrus-license.<compte>.workers.dev`. Test : ouvrir `<URL>/health` -> `{"ok":true}`.

## 6. Brancher les applications
- VPS (`.env` sur la VM, via SSH) : `CLOUDFLARE_LICENSE_URL=<URL>` et `CLOUDFLARE_ADMIN_SECRET=<secret>` puis redémarrage du conteneur.
- PC / mobile (`local-client/.env`) : `CLOUDFLARE_LICENSE_URL=<URL>`.
- Page d'administration : ouvrir `<URL>/` et saisir le secret admin -> "Nouvelle licence" génère une clé.

## 7. Vérifications
1. Générer une clé dans la page admin.
2. La saisir sur le PC -> l'appareil est lié (D1) ; un second appareil doit être refusé (DEVICE_MISMATCH).
3. Après <= 15 min (ou redémarrage du VPS) la clé apparaît dans la liste du VPS (réplication).
4. Envoyer un texte IA depuis le PC : le fournisseur affiché doit se terminer par « (Cloudflare) ».

## 8. Bascule finale
Quand tout est validé : ne plus utiliser les fonctions Firebase de licences (ne PAS les supprimer — projet
partagé avec RIEA AFRIQUE, règle de non-intervention). Firebase reste simplement un repli inactif.

## Quotas gratuits à surveiller
D1 : 100 k écritures / 5 M lectures par jour. Workers : 100 k requêtes/jour. Une vérification = 1 lecture ;
la réplication n'écrit que les clés modifiées.
