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
