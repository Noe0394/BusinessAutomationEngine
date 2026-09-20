# Déploiement de la branche `feat/jarvis-engine` sur la VM (à lancer depuis Google Cloud Shell)

Pourquoi Cloud Shell : depuis le PC, SSH vers la VM est refusé (la clé `vps_34_135_20_27` n'existe plus).
La branche est déjà poussée sur GitHub (`origin/feat/jarvis-engine`). Aucun secret n'est dans le dépôt (public).

## 1. Connexion
```
gcloud compute ssh deploy@instance-20260909-074745 --project=rien-afrique --zone=us-central1-a
```

## 2. Point de retour (noter le résultat)
```
cd /home/cyrus2026/BusinessAutomationEngine
sudo -u cyrus2026 git rev-parse --short HEAD ; sudo -u cyrus2026 git branch --show-current
```

## 3. Récupérer la branche
```
sudo chown -R cyrus2026:cyrus2026 /home/cyrus2026/BusinessAutomationEngine
sudo -u cyrus2026 git fetch origin feat/jarvis-engine
sudo -u cyrus2026 git checkout feat/jarvis-engine
```

## 4. Variables d'environnement (fichier `.env` du checkout ; valeurs à copier depuis le `.env` du PC)
```
AUTO_REPLY_DEBOUNCE_MS=1500
JARVIS_CONFIRM_FROM=WRITE
CLOUDFLARE_LICENSE_URL=<voir .env du PC>
CLOUDFLARE_ADMIN_SECRET=<voir .env du PC>
```
(les deux dernières activent la réplication des licences VPS -> Cloudflare ; facultatif pour tester Jarvis)

## 5. Reconstruire (procédure habituelle, nettoie le disque)
```
sudo ./deploy.sh
sudo docker ps -a | grep cyrus
curl -s https://34-135-20-27.sslip.io/health
sudo docker logs cyrus-super-assistant-backend --tail 50   # chercher "Server listening", pas de MODULE_NOT_FOUND
```

## 6. Tests réels (compte de la clé de test) : voir `docs/TESTS-REELS.md`

## Retour arrière immédiat
```
cd /home/cyrus2026/BusinessAutomationEngine
sudo -u cyrus2026 git checkout main && sudo ./deploy.sh
```
Le retour n'efface aucune donnée : les nouveaux états (`conversation_state`) restent sur le volume et sont ignorés par l'ancien code.
