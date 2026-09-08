---
title: CYRUS SUPER ASSISTANT — Backend
emoji: 🤖
colorFrom: purple
colorTo: blue
sdk: docker
app_port: 10000
pinned: false
---

# CYRUS SUPER ASSISTANT — backend H24 (Hugging Face Spaces)

Backend Node.js/Express complet (WhatsApp/Baileys, Telegram MTProto,
Facebook Graph API, YouTube/TikTok, Studio IA, licences) — voir `index.js`
et `lib/`. Ce Space héberge uniquement le **backend** ; l'interface
(`public/dashboard.html`) est déployée séparément (Vercel ou tout hébergeur
statique) et lui parle en cross-origin via `public/config.js`
(`window.CYRUS_API_BASE`, voir `public/config.example.js`).

## Configuration requise sur ce Space

Renseigner dans **Settings → Repository secrets / Variables** les mêmes
clés que `.env.example` à la racine du dépôt (`GROQ_API_KEY`,
`GEMINI_API_KEY`, `HUGGINGFACE_API_KEY`, `OPENROUTER_API_KEY`, `FAL_KEY`,
`REPLICATE_API_TOKEN`, `GITHUB_TOKEN`, `GITHUB_DATA_REPO`,
`GITHUB_DATA_BRANCH`, `ADMIN_PASSWORD`, etc.), plus obligatoirement :

- `PUBLIC_BASE_URL` : l'URL publique de CE Space
  (`https://<votre-compte>-<nom-du-space>.hf.space`).
- `DASHBOARD_ORIGIN` : l'origine du frontend autorisée en CORS (voir
  `lockCorsToOfficialDashboard` dans `index.js`) — l'URL Vercel du
  dashboard, plusieurs origines séparées par des virgules si besoin
  (ex. domaine personnalisé en plus du sous-domaine `.vercel.app`).

Le stockage disque de ce Space est **éphémère** par défaut (comme
l'était Render en plan gratuit) — la sauvegarde de secours GitHub
(`githubStore.js`, déjà en place) reste donc nécessaire pour ne pas perdre
sessions/licences entre deux redémarrages, sauf activation du stockage
persistant payant de Hugging Face Spaces.
