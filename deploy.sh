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

echo "== Build + redémarrage =="
sudo docker-compose up -d --build

echo "== Nettoyage des anciennes images/couches de build devenues orphelines =="
sudo docker image prune -af
sudo docker builder prune -af

echo "== Espace disque après nettoyage =="
df -h /

echo "== Statut du conteneur =="
sudo docker ps --format 'table {{.Names}}\t{{.Status}}'
