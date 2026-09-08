FROM node:20-slim

# Outils de build pour les dépendances natives de Baileys (crypto Signal) —
# PAS de ffmpeg ici, contrairement au Dockerfile principal à la racine du
# dépôt : ce service ne fait que relayer WhatsApp, aucun traitement média.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8000

CMD ["npm", "start"]
