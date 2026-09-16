#!/usr/bin/env bash
# Redéploiement du backend (rebuild + redémarrage + nettoyage disque) — à
# utiliser à la place d'un simple "docker-compose up -d --build" pour tout
# déploiement sur ce VPS. Le disque (9,7 Go) est petit : un rebuild garde
# temporairement l'ancienne ET la nouvelle image le temps du build, et sans
# nettoyage systématique après coup, les anciennes images/couches de build
# s'accumulent jusqu'à saturer le disque (constaté en production le
# 2026-09-09 : 97% plein après un seul rebuild non suivi d'un nettoyage).
set -euo pipefail

cd "$(dirname "$0")"

echo "== Espace disque avant build =="
df -h /

# --- MIGRATION UNE FOIS : données éphémères -> volume persistant app_data ---
# Depuis le docker-compose.yml actuel, les LICENCES (licenses.json) et la
# MÉMOIRE 7 JOURS (ai_engine_data) vivent dans le volume nommé `app_data`
# (/app/data dans le conteneur). AVANT la première mise en production de ce
# volume, ces données vivaient sur le disque ÉPHÉMÈRE du conteneur
# (/app/licenses.json et /app/ai_engine_data) et étaient perdues à CHAQUE
# rebuild — d'où les clés "rejetées" systématiquement après redéploiement.
# Ce bloc copie UNE SEULE FOIS les données du conteneur actuel dans le volume
# (uniquement si le volume est vide), puis ne fait plus rien aux déploiements
# suivants. Rien n'est supprimé, aucun risque sur les données existantes.
if sudo docker volume create app_data >/dev/null 2>&1; then :; fi
if [ -z "$(sudo docker run --rm -v app_data:/d alpine sh -c 'ls -A /d' 2>/dev/null)" ]; then
  echo "== Migration (1ère fois) : conteneur actuel -> volume app_data =="
  sudo docker cp cyrus-super-assistant-backend:/app/licenses.json /tmp/mig_licenses.json 2>/dev/null || true
  sudo docker cp cyrus-super-assistant-backend:/app/ai_engine_data /tmp/mig_ai_engine 2>/dev/null || true
  sudo docker run --rm \
    -v app_data:/d \
    -v /tmp/mig_licenses.json:/src_licenses.json \
    -v /tmp/mig_ai_engine:/src_ai_engine \
    alpine sh -c 'd=/d; [ -e /src_licenses.json ] && cp /src_licenses.json $d/licenses.json; [ -d /src_ai_engine ] && cp -a /src_ai_engine $d/ai_engine; echo "Contenu du volume :"; ls -la $d'
  rm -f /tmp/mig_licenses.json
  rm -rf /tmp/mig_ai_engine
else
  echo "== Volume app_data déjà initialisé — pas de migration nécessaire =="
fi

echo "== Build + redémarrage =="
sudo docker-compose up -d --build

echo "== Nettoyage des anciennes images/couches de build devenues orphelines =="
sudo docker image prune -af
sudo docker builder prune -af

echo "== Espace disque après nettoyage =="
df -h /

echo "== Statut du conteneur =="
sudo docker ps --format 'table {{.Names}}\t{{.Status}}'
