# 🎯 CYRUS SUPER ASSISTANT — MISSION D'UNIFICATION (Suivi vivant)

> Document de travail/maintenance créé le 2026-09-13.
> **Pis redémarrable** : une session future peut reprendre la mission ici.
> S'actualise au fur et à mesure (micro-étapes, jamais de gros saut).

## Objectif final (rappel du master prompt)

UNE seule plateforme web, **UNE seule URL Vercel existante** (le projet
`cyrus-super-assistant`, déjà lié via `.vercel/project.json`), **deux modes** :

- `/` → `chooser.html` : page de choix du mode (🟢 SANS VPS / 🔵 AVEC VPS)
- `/local` → mode Zero-VPS (moteur local, IndexedDB, WhatsApp/Telegram local)
- `/vps` → `dashboard.html` : mode VPS (backend Google Cloud, Baileys, Scheduler, IA)

**Zéro reconstruction** : Baileys, backend VPS, sessions, licences, Human
Context, vps-bridge restent intacts.

## ✅ Audit (fait le 2026-09-13) — ce qui EXISTE déjà

| Élément | État | Fichiers |
|---|---|---|
| Choix du mode `/` | ✅ existe | `public/chooser.html` |
| Routing `/local` → webapp | ✅ dans `vercel.json` | `retwrite /local/(.*) → /webapp/$1` |
| Mode local (Zero-VPS) | ✅ source existe | `webapp-core/` (index, app-core, adapter, connexions…), copié au build par `scripts/build-public.js` → `public/webapp/` |
| Mode VPS interface | ✅ existe | `public/dashboard.html` + `public/config.js` (`CYRUS_API_BASE = https://34-135-20-27.sslip.io`) |
| Projet Vercel | ✅ identifié | `cyrus-super-assistant` — `prj_C2YDbiOYHz1riZ7pC2EsoXcgB8K0` / team `XFbi60W2C3xxaId9ryNFbgka` |
| Backend VPS | ✅ en ligne | conteneur `cyrus-super-assistant-backend`, health 200 |
| Courbe "local" non commitée | ⚠️ worktree | `local-client/`, `mobile/`, `lib/intelligence/`, `adapters/whatsapp-wwebjs.js`, `public/chooser.html`, `vercel.json` (mod), `index.js` (+14, mount vps-bridge) |

## ✅ Réparation VPS (faite le 2026-09-13, avant l'unification)

- **Auth/licences** : OK. `requireAccess` : 200 avec clé + device liés ; 403 si
  autre device. Les « 401 partout » = artéfact de copies collées cassant le
  header `x-device-id` (retesté propre = 200).
- **Telegram** : réparé. `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` manquaient dans
  le `.env` VM (migration VPS non complète) → ajoutés + `docker compose up -d
  --no-build` (volumes préservés). Désormais `configured:true`. À faire :
  login/code depuis le dashboard (volume `telegram_sessions` vide sur ce VPS).
- **WhatsApp/Baileys** : sessions présentes sur le volume `whatsapp_auth`
  (`KEY-5B49C041`, `KEY-E3836704`, `KEY-E5164DF3`, `__admin__`, `wwebjs`) MAIS
  déconnectées : `KEY-E5164DF3-2026` = code **401** (session révoquée côté
  WhatsApp → re-pairage QR requis), `__admin__`/`KEY-E3836704-2026` = **428**
  (rate-limit temporaire). Reste une action operateur (QR), **pas** un bug code.
- Backup précaution : `licenses.json.pre-fix.bak` dans le conteneur (701 o).

## Référentiel VPS (pour toute session future)

| | |
|---|---|
| Projet GCP | `rien-afrique` |
| Instance | `instance-20260909-074745` (zone `us-central1-a`) |
| IP / domaine public | `34.135.20.27` / `https://34-135-20-27.sslip.io` |
| Conteneur | `cyrus-super-assistant-backend` (port 3000, restart always) |
| Repo sur la VM | `/home/cyrus2026/BusinessAutomationEngine` (compose `env_file .env`) |
| SSH | voir `docs/VPS-SSH.md` (clé `~/.ssh/vps_34_135_20_27`) |
| Accès gcloud | `gcloud compute ssh instance-20260909-074745 --project=rien-afrique --zone=us-central1-a` |

## 🔜 Plan en micro-étapes (checklist vivante)

- [ ] 1. Vérifier le build local : `node scripts/build-public.js` puis
      `node scripts/build-dashboard.js` (produit `public/webapp/` + `public/dist/`).
- [ ] 2. Identifier URL Vercel réelle (CLI `vercel` : `vercel ls` / `vercel whoami`).
- [ ] 3. Vérifier étanchéité : `/local` ne touche pas le VPS ; `/vps` pointe
      sur le backend (config.js → 34-135-20-27.sslip.io déjà OK).
- [ ] 4. Petits correctifs éventuels (routing, choix du mode, badges mode).
- [ ] 5. Commit propre (sans secrets/sessions/.env) + push sur `main`.
      **2026-09-13 — staging terminé** : 123 fichiers, ~18 545 insertions.
      Scan secrets sur le diff stagé : propre (`TELEGRAM_API_*` = lectures
      `process.env` + refs docs ; `@CYRUS2026` = défaut préexistant
      commit a8694550 du 2026-09-03 ; `test-admin-pw-2026` = test seulement).
      Pas de sortie de build (public/webapp, APK, .gradle) ni de clé privée.
      Commit en cours (classificateur instable, retries).
- [ ] 6. Déployer **Vercel** (projet existant, buildCommand déjà
      `node scripts/build-public.js`, output `public`).
- [ ] 7. Déployer **VM GCP** (git pull sur `/home/cyrus2026/BusinessAutomationEngine`
      + `docker compose up -d --build` — sessions/volumes préservés).
- [ ] 8. Health checks : Vercel + `/health` VPS + `/api/intelligence/health`.
- [ ] 9. Tests end-to-end (chooser, /local, /vps, étanchéité, mobile, desktop).
- [ ] 10. Rapport final (URL, commit hash, preuves).

## Règles permanentes

- Ne pas créer de 2e projet Vercel ni de 2e URL.
- Ne rien supprimer (sessions, licences, travail non commité).
- Jamais de secret dans un commit, le bundle navigateur ou ce doc.
- Si un changement risque de casser la prod → STOP + explication.