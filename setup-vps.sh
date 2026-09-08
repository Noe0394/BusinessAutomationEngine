#!/usr/bin/env bash
# Installation automatisée du backend CYRUS SUPER ASSISTANT sur un VPS
# Ubuntu/Debian frais (ex: VM Google Cloud) — installe Docker + Docker
# Compose, clone (ou met à jour) le dépôt, lance le conteneur backend en
# tâche de fond avec redémarrage automatique (voir docker-compose.yml,
# restart: always), puis installe et configure Caddy comme reverse proxy
# HTTPS gratuit (voir Caddyfile) : sslip.io résout SSLIP_DOMAIN directement
# vers l'IP publique de ce VPS sans achat de nom de domaine, ce qui permet à
# Let's Encrypt (via Caddy, entièrement automatique) d'émettre un vrai
# certificat — impossible sur une IP nue. Sans ce reverse proxy, un
# navigateur bloquerait silencieusement tout appel du dashboard Vercel
# (HTTPS) vers ce backend (HTTP brut, "mixed content").
#
# Usage : ./setup-vps.sh [URL_DU_DEPOT] [BRANCHE] [DOSSIER_CIBLE] [SSLIP_DOMAIN]
# Valeurs par défaut : dépôt Noe0394/BusinessAutomationEngine, branche main,
# dossier ~/business-automation-engine, domaine 34-68-84-124.sslip.io.
set -euo pipefail

REPO_URL="${1:-https://github.com/Noe0394/BusinessAutomationEngine.git}"
BRANCH="${2:-main}"
TARGET_DIR="${3:-$HOME/business-automation-engine}"
SSLIP_DOMAIN="${4:-34-68-84-124.sslip.io}"

echo "== 1/5 : Installation de Docker et Docker Compose (si absents) =="
if ! command -v docker >/dev/null 2>&1; then
  # BUG CORRIGÉ (constaté en test réel sur une VM Google Cloud) : la version
  # précédente pointait TOUJOURS vers le dépôt Docker "ubuntu", en supposant
  # à tort qu'il fonctionnait aussi pour Debian. Faux : Docker publie deux
  # dépôts distincts (linux/ubuntu et linux/debian) et les CODENAMES ne se
  # recoupent pas entre les deux distributions — "trixie" (Debian 13)
  # n'existe pas dans le dépôt Ubuntu, d'où un 404 systématique et un script
  # qui s'arrêtait net (set -e) avant même de cloner le dépôt. $ID (dans
  # /etc/os-release) donne la VRAIE distribution ("debian" ou "ubuntu") :
  # utiliser le dépôt Docker correspondant, jamais "ubuntu" par défaut.
  . /etc/os-release
  DOCKER_OFFICIAL_OK=false

  # Nettoyage d'un éventuel fichier laissé par une exécution PRÉCÉDENTE de ce
  # script qui aurait échoué après avoir déjà écrit ce fichier (cas constaté
  # en test réel : le tout premier `apt-get update` ci-dessous continuait de
  # buter sur l'ancienne ligne "linux/ubuntu" écrite lors d'un essai
  # antérieur, alors même que la logique de détection ci-dessous avait déjà
  # été corrigée — la correction ne servait à rien tant que ce résidu n'était
  # pas supprimé en premier).
  sudo rm -f /etc/apt/sources.list.d/docker.list

  sudo apt-get update
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  if curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /tmp/docker.gpg; then
    sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg < /tmp/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} \
      ${VERSION_CODENAME} stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    # Le dépôt Docker peut malgré tout ne pas encore publier cette codename
    # précise (distribution très récente) — on ne suppose jamais que l'ajout
    # du dépôt a réussi, on vérifie explicitement avant d'installer dessus,
    # avec un repli automatique sinon plutôt qu'un script qui plante.
    if sudo apt-get update 2>/tmp/apt-docker-update.log && ! grep -q '^E:' /tmp/apt-docker-update.log; then
      if sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin; then
        DOCKER_OFFICIAL_OK=true
      fi
    fi
  fi

  if [ "$DOCKER_OFFICIAL_OK" = false ]; then
    echo "Dépôt officiel Docker indisponible pour ${ID} ${VERSION_CODENAME} — repli sur les paquets Docker fournis directement par la distribution."
    sudo rm -f /etc/apt/sources.list.d/docker.list
    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose-v2
  fi

  sudo usermod -aG docker "$USER" || true
  echo "Docker installé. Une reconnexion SSH peut être nécessaire pour utiliser docker sans sudo."
else
  echo "Docker déjà présent, étape ignorée."
fi

echo "== 2/5 : Récupération du dépôt =="
if [ -d "$TARGET_DIR/.git" ]; then
  git -C "$TARGET_DIR" fetch origin "$BRANCH"
  git -C "$TARGET_DIR" checkout "$BRANCH"
  git -C "$TARGET_DIR" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
fi
cd "$TARGET_DIR"

echo "== 3/5 : Vérification du fichier .env =="
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "ATTENTION : .env créé à partir de .env.example avec des valeurs VIDES."
  echo "Éditez $TARGET_DIR/.env avec vos vraies clés AVANT de relancer ce script,"
  echo "sinon le backend démarrera avec les intégrations désactivées."
fi

echo "== 4/5 : Démarrage du conteneur (arrière-plan, redémarrage automatique) =="
if docker compose version >/dev/null 2>&1; then
  sudo docker compose up -d --build
else
  sudo docker-compose up -d --build
fi

echo "== 5/5 : Installation et configuration de Caddy (HTTPS gratuit via sslip.io) =="
if ! command -v caddy >/dev/null 2>&1; then
  # Caddy est déjà empaqueté nativement dans les dépôts Debian/Ubuntu depuis
  # plusieurs versions — tenté EN PREMIER (même raisonnement que pour Docker
  # ci-dessus : éviter un dépôt tiers dont la codename précise de cette
  # distribution pourrait ne pas encore être publiée). Le dépôt officiel
  # Cloudsmith (spécifique Debian, voir l'URL "debian.deb.txt" ci-dessous)
  # ne sert que de repli si le paquet natif est absent.
  sudo apt-get update
  if ! sudo apt-get install -y caddy; then
    echo "Paquet caddy natif indisponible — repli sur le dépôt officiel Cloudsmith."
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
    sudo apt-get update
    sudo apt-get install -y caddy
  fi
else
  echo "Caddy déjà présent, étape d'installation ignorée."
fi

# Remplace TOUT le Caddyfile système par celui du dépôt (voir ./Caddyfile) —
# SSLIP_DOMAIN y est substitué dynamiquement pour rester cohérent avec
# l'argument passé à ce script (utile si l'IP de ce VPS change un jour).
sed "s/34-68-84-124\.sslip\.io/${SSLIP_DOMAIN}/" "$TARGET_DIR/Caddyfile" | sudo tee /etc/caddy/Caddyfile > /dev/null
sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy
sudo systemctl enable caddy

echo ""
echo "Terminé. Backend lancé en tâche de fond sur le port 3000 (local),"
echo "exposé publiquement en HTTPS via Caddy sur https://${SSLIP_DOMAIN}."
echo "Logs backend : cd $TARGET_DIR && sudo docker compose logs -f"
echo "Logs Caddy   : sudo journalctl -u caddy -f"
echo ""
echo "IMPORTANT : si le certificat HTTPS n'est pas délivré immédiatement,"
echo "vérifiez que les ports 80 ET 443 sont ouverts dans le pare-feu VPC"
echo "Google Cloud (Caddy en a besoin pour la validation Let's Encrypt) —"
echo "ce script ne peut pas modifier les règles de pare-feu GCP lui-même."
