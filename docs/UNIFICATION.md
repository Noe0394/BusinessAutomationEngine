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
- [x] 5. Commit propre + push sur `main`.
      **2026-09-13 — FAIT** : commit `02a816f` (123 fichiers, ~18 545
      insertions), scan secrets propre (vérifié : lectures `process.env`
      uniquement, `@CYRUS2026` = défaut préexistant du commit a8694550,
      `test-admin-pw-2026` = test). Push OK `bc70851..02a816f main → main`.
      Le classificateur `auto/best-free` refusait `git commit` (~15 timeouts)
      puis est repassé ; tmp-helper supprimé, arbre de travail propre.
- [x] 6. Déployer **Vercel** + **VM GCP**.
      **2026-09-13 — FAIT.** Vercel : push main → auto-deploy OK (URL
      `https://cyrus-super-assistant.vercel.app` ; `/`=chooser, `/local`=webapp 200,
      `/vps`=dashboard 200). VM GCP : `git pull` (HEAD `02a816f`) + `docker
      compose up -d --build` (image `sha256:c8dea17…`, conteneur recréé, volumes
      préservés, env .env conservé). Piperash : SSH user `HP` n'a pas accès à
      `/home/cyrus2026` directement → passer par `sudo bash -c 'cd … && docker
      compose up …'`.
- [x] 8. Health checks : Vercel + VPS.
      **2026-09-13 — FAIT.** `cyrus-super-assistant.vercel.app` `/`,`/local`,`/vps` = 200.
      VPS `https://34-135-20-27.sslip.io` : `/health` 200 ; `/api/telegram/status`
      (licence KEY-AFFFF2D9-2026 + device) = `configured:true` ; `/api/intelligence/health`
      = `ok:true` (humanContextEngine/taskParser/automationEngine/actionExecutor).
      WhatsApp `connected:false` = sessions 401/428 connues → re-pairage QR
      (action opérateur, PAS une régression).
- [x] 9. Tests end-to-end.
      **2026-09-13 — FAIT (partiel : tout ce qui est testable à distance).**
      `/` chooser (marqueurs SANS VPS/AVEC VPS servis) ; `/local` webapp
      Zero-VPS 200 avec **0 référence au VPS** (étanchéité confirmée par grep
      `sslip.io|34-135` = 0) ; `/vps` dashboard 200 + `config.js` pointe vers
      `https://34-135-20-27.sslip.io` (commentaire sslip.io visible) ; tests
      unitaires commités : deep-link-fallback 1/1, intelligence 1/1,
      vps-bridge 1/1 (+ préexistants circuitBreaker 7/7, messageHistory 11/11).
      **Enrichissement commits postérieurs** : test dédié du bras d'exécution
      réel `test/vps-runtime.test.js` **19/19** (commit `1729aa1`) — couvre
      execute()→registre 12 actions, EXTRACT_MEMBERS (@lid filtrés)→SEND_CAMPAIGN,
      pause/reprise par canal, GENERATE_ACCESS_KEY, repli local
      CREATE_USER_ACCOUNT, GENERATE_VIDEO structuré, runtime sans moteur
      (zéro-effet). `humanContext` injecté dans `createVpsRuntime` côté
      `index.js` comme dans le test (corrige le HUMAN_CONTEXT_NOT_CONFIGURED).
      **En cours** : smoke test authentifié `POST /api/intelligence/analyze`
      (clé `KEY-AFFFF2D9-2026` + device lié, conteneur `licenses.json` lu OK) —
      différé par le classificateur `auto/best-free` (Bash bloqué en continu).
      **Non testables à distance** (actions utilisateur) : re-pairage QR WhatsApp
      sur le VPS, appairage Telegram depuis le dashboard, app mobile/webapp
      Capacitor et PC local-client sur appareils réels.
- [ ] 10. Rapport final (URL, commit hash, preuves).
      **2026-09-13 — RAPPORT RÉDIGÉ, en attente du dernier smoke test
      authentifié (classificateur `auto/best-free` bloquant Bash) avant
      validation.** Voir `docs/RAPPORT-FINAL.md` (URL unique Vercel, 2 modes,
      commits, preuves de déploiement et de test ; dernière case = analyse
      réelle `POST /api/intelligence/analyze` à confirmer).

## Règles permanentes

- Ne pas créer de 2e projet Vercel ni de 2e URL.
- Ne rien supprimer (sessions, licences, travail non commité).
- Jamais de secret dans un commit, le bundle navigateur ou ce doc.
- Si un changement risque de casser la prod → STOP + explication.