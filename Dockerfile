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

# Garde-fou de déploiement : ce VPS ne doit exécuter QUE Baileys
# (adapters/whatsapp.js), jamais whatsapp-web.js/Puppeteer (moteur
# WHATSAPP_ENGINE=wwebjs réservé au PC local, voir adapters/whatsapp-wwebjs.js
# et le .env local — cette variable n'est jamais définie ici). Si ces paquets
# sont un jour ajoutés par erreur à package.json sur la branche déployée, ce
# build échoue explicitement au lieu d'installer silencieusement Puppeteer +
# Chromium (~300 Mo, sandbox/mémoire non adaptés à ce serveur) sur le VPS.
RUN if grep -qE '"(whatsapp-web\.js|puppeteer)"[[:space:]]*:' package.json; then \
      echo "ERREUR : whatsapp-web.js/puppeteer détectés dans package.json — réservés au moteur LOCAL (PC), jamais au VPS. Retirez-les avant de redéployer." >&2; \
      exit 1; \
    fi

RUN npm install

COPY . .

# Obscurcissement Frontend : génère public/dist/dashboard.html (JS client
# minifié/obscurci) — voir scripts/build-dashboard.js. index.js sert
# automatiquement cette version dès qu'elle existe.
RUN npm run build

EXPOSE 10000

CMD ["npm", "start"]
