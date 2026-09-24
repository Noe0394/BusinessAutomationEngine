# Licences CYRUS sur Cloudflare (Worker + D1, palier gratuit)

Remplace le générateur/vérificateur de licences hébergé sur Firebase (payant). Le contrat
HTTP est identique à `firebase-functions` (`verifyLicenseOffline`, `createLicenseOffline`, …) :
seules les URL changent.

## Déploiement (à faire par vous, une seule fois — aucun déploiement n'a été fait)
```
cd cloudflare/license-worker
npx wrangler login
npx wrangler d1 create cyrus-licenses            # copier l'id dans wrangler.toml
npx wrangler d1 execute cyrus-licenses --remote --file=schema.sql
npx wrangler secret put ADMIN_SECRET              # secret admin (distinct du mot de passe VPS)
npx wrangler deploy
```
Puis, dans les `.env` :
- VPS : `CLOUDFLARE_LICENSE_URL=https://cyrus-license.<compte>.workers.dev` et `CLOUDFLARE_ADMIN_SECRET=<le secret>`
- local-client / mobile : `CLOUDFLARE_LICENSE_URL=<même URL>` (vérification : Cloudflare -> Firebase -> VPS)

## Routes
| Route | Rôle |
|---|---|
| `POST /verify` (alias `/verifyLicenseOffline`) | vérifie une clé, lie l'appareil à la 1re utilisation |
| `POST /admin/create` (alias `/createLicenseOffline`) | génère une clé `KEY-XXXXXXXX-AAAA` |
| `GET /admin/list`, `POST /admin/update`, `/admin/set-active`, `/admin/delete` (+ alias `*Offline`) | gestion |
| `POST /admin/sync` | réplication VPS -> D1 (uniquement les clés modifiées) |
| `GET /` | page d'administration (secret admin saisi dans la page) |

## Quotas gratuits (D1 : 100 k écritures/jour, 5 M lectures/jour ; Workers : 100 k requêtes/jour)
Une vérification = 1 lecture (+ 1 écriture unique lors de la liaison d'appareil). La réplication
n'écrit que les clés dont le contenu a changé.

## Passerelle IA texte
`POST /ai/text` (en-têtes `x-license-key`, `x-device-id`, corps `{prompt}`) : cascade Groq → Gemini → DeepSeek →
OpenRouter → Hugging Face → Pollinations. Secrets facultatifs : `GROQ_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY`. Guide complet : `../SETUP-PAS-A-PAS.md`.

## Passerelle Facebook/Messenger mobile

Le Worker inclut maintenant une passerelle OAuth et Graph API pour le telephone. Les jetons utilisateur et Page sont chiffres AES-GCM dans D1 avec FACEBOOK_TOKEN_ENCRYPTION_KEY. Le secret Meta reste dans les secrets Wrangler. Chaque operation exige une licence active, deja liee exactement a cet appareil et avec le module facebook autorise.

Appliquer les tables ajoutees au schema, puis configurer les secrets :
npx wrangler d1 execute cyrus-licenses --remote --file=schema.sql
npx wrangler secret put FACEBOOK_APP_ID
npx wrangler secret put FACEBOOK_APP_SECRET
npx wrangler secret put FACEBOOK_REDIRECT_URI
npx wrangler secret put FACEBOOK_TOKEN_ENCRYPTION_KEY

FACEBOOK_REDIRECT_URI doit etre l'URL HTTPS publique exacte de /facebook/oauth/callback et doit etre autorisee dans les parametres OAuth de l'application Meta. Generer une cle AES-256 aleatoire, en base64, avant de la stocker; conserver cette cle apres le deploiement, car son remplacement rendrait illisibles les jetons deja chiffres. FACEBOOK_GRAPH_API_VERSION est configuree dans wrangler.toml.

Le client mobile ne recoit aucun jeton Meta. Il peut autoriser une Page, publier/programmer texte ou image/video, lire les publications/commentaires, repondre/moderer les commentaires, charger des conversations Messenger et envoyer des messages ou une file locale avec controle d'arret. `/facebook/prospects` gere les regles de mots-cles et prospects D1, les curseurs de capture des commentaires des 20 dernieres publications et une file prudente de reponses privees. La synchronisation du telephone est manuelle ou opt-in toutes les cinq minutes au premier plan; chaque invocation lit jusqu'a cinq fils et huit commentaires bruts, et traite au plus deux reponses privees. Une reponse au resultat incertain n'est jamais relancee. Le verrou D1 serialise capture, changement de regles, reconnexion OAuth, changement de Page et deconnexion; les prospects sont cloisonnes par Page. Appliquer les nouvelles tables du `schema.sql` apres chaque evolution du schema. Les API Meta imposent toujours leurs autorisations, leur revue d'application et leurs fenetres de messagerie; la passerelle ne les contourne pas. Le raccordement a un compte reel demande un D1 Cloudflare, les secrets ci-dessus, une application Meta configuree et l'URI OAuth enregistree.
## Transcription audio mobile

POST /ai/transcribe accepte une licence (x-license-key, x-device-id) et un corps JSON {base64, mimeType, filename}. Le fichier est borne a 10 Mo et transmis a Groq Whisper depuis le Worker; GROQ_API_KEY est le secret Wrangler deja utilise par la cascade texte, et GROQ_WHISPER_MODEL peut choisir le modele. Le client mobile ne recoit jamais la cle fournisseur. L'interface telephone ne transmet que le fichier audio explicitement choisi par l'utilisateur.
