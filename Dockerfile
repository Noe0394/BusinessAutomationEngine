FROM node:20-slim

# Installation des outils de build pour les modules natifs Node.js, PLUS
# ffmpeg système : le binaire statique fourni par le paquet npm
# "ffmpeg-static" pour Linux est compilé SANS libfreetype (constaté en
# production, voir lib/media/videoMixerEngine.js) — le filtre "drawtext"
# y est donc absent ("Filter not found" dans le filter_complex), alors
# qu'il fonctionne normalement en développement local (Windows/macOS,
# binaires ffmpeg-static complets sur ces plateformes). Le paquet ffmpeg
# officiel Debian inclut toujours libfreetype/drawtext — voir la variable
# FFMPEG_BIN ci-dessous, respectée nativement par ffmpeg-static
# (node_modules/ffmpeg-static/index.js), qui bascule dessus UNIQUEMENT ici
# (en local, sans FFMPEG_BIN défini, le binaire embarqué habituel reste
# utilisé sans changement de comportement).
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_BIN=/usr/bin/ffmpeg

# Bibliothèques partagées nécessaires à Chromium headless (moteur WhatsApp
# "wwebjs", voir adapters/whatsappEngineWwebjs.js — actif uniquement si
# WHATSAPP_ENGINE=wwebjs) — le paquet npm "puppeteer" télécharge son propre
# binaire Chromium à l'installation, seules ces libs système lui manquent
# encore sur l'image "node:20-slim" (Debian bookworm), noms de paquets
# vérifiés directement sur cette image avant écriture de ce Dockerfile.
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Obscurcissement Frontend : génère public/dist/dashboard.html (JS client
# minifié/obscurci) — voir scripts/build-dashboard.js. index.js sert
# automatiquement cette version dès qu'elle existe.
RUN npm run build

EXPOSE 10000

CMD ["npm", "start"]
