FROM node:20-slim

# Installation des outils de build pour les modules natifs Node.js
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
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
