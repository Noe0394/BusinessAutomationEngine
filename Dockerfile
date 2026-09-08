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
