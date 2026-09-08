#!/usr/bin/env bash
# Installation automatisée du backend CYRUS SUPER ASSISTANT sur un VPS
# Ubuntu/Debian frais (ex: VM Google Cloud) — installe Docker + Docker
# Compose, clone (ou met à jour) le dépôt, puis lance le conteneur backend
# en tâche de fond avec redémarrage automatique (voir docker-compose.yml,
# restart: always).
#
# Usage : ./setup-vps.sh [URL_DU_DEPOT] [BRANCHE] [DOSSIER_CIBLE]
# Valeurs par défaut : dépôt Noe0394/BusinessAutomationEngine, branche main,
# dossier ~/business-automation-engine.
set -euo pipefail

REPO_URL="${1:-https://github.com/Noe0394/BusinessAutomationEngine.git}"
BRANCH="${2:-main}"
TARGET_DIR="${3:-$HOME/business-automation-engine}"

echo "== 1/4 : Installation de Docker et Docker Compose (si absents) =="
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  # Fonctionne aussi sur Debian : le dépôt Ubuntu Docker sert de base, seule
  # la variable $VERSION_CODENAME (Ubuntu) / $VERSION_CODENAME (Debian, via
  # os-release) change — Docker publie des paquets dédiés pour les deux,
  # mais ce script vise explicitement Ubuntu/Debian récents où le dépôt
  # "ubuntu" fonctionne aussi pour Debian en pratique via lsb_release.
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
  echo "Docker installé. Une reconnexion SSH peut être nécessaire pour utiliser docker sans sudo."
else
  echo "Docker déjà présent, étape ignorée."
fi

echo "== 2/4 : Récupération du dépôt =="
if [ -d "$TARGET_DIR/.git" ]; then
  git -C "$TARGET_DIR" fetch origin "$BRANCH"
  git -C "$TARGET_DIR" checkout "$BRANCH"
  git -C "$TARGET_DIR" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

echo "== 3/4 : Vérification du fichier .env =="
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "ATTENTION : .env créé à partir de .env.example avec des valeurs VIDES."
  echo "Éditez $TARGET_DIR/.env avec vos vraies clés AVANT de relancer ce script,"
  echo "sinon le backend démarrera avec les intégrations désactivées."
fi

echo "== 4/4 : Démarrage du conteneur (arrière-plan, redémarrage automatique) =="
if docker compose version >/dev/null 2>&1; then
  sudo docker compose up -d --build
else
  sudo docker-compose up -d --build
fi

echo ""
echo "Terminé. Backend lancé en tâche de fond sur le port 3000."
echo "Logs : cd $TARGET_DIR && sudo docker compose logs -f"
