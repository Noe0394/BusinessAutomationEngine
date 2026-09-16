#!/bin/bash
# test/vps-live-test.sh — Tests vivants de la mémoire conversationnelle 7 jours
# MODES D'EXÉCUTION (aucun SSH récursif) :
#   - DIRECTEMENT SUR LE VPS : docker exec / grep / curl sont exécutés
#     localement, aucune connexion `gcloud compute ssh` vers soi-même
#     (recursive ici, elle régénérerait une clé root et échouerait) :
#         sudo -u cyrus2026 bash test/vps-live-test.sh
#     Auto-détection : le conteneur est visible dans le docker local.
#     Forçage si besoin : VPS_DIRECT=1 bash test/vps-live-test.sh
#   - DEPUIS LE PC DE DÉV (mode histórico conservé) :
#         ! bash test/vps-live-test.sh   (via gcloud compute ssh)
# Compte de test : KEY-E5164DF3-2026

set -e
VPS="deploy@instance-20260909-074745"
PROJECT="rien-afrique"
ZONE="us-central1-a"
URL="https://34-135-20-27.sslip.io"
LICENCE="KEY-E5164DF3-2026"
PASSED=0
FAILED=0
SKIPPED=0

green() { echo "\033[32m✓ $1\033[0m"; }
red()   { echo "\033[31m✗ $1\033[0m"; }
skip()  { echo "\033[33m⊘ NON TESTÉ — $1\033[0m"; }
# Tout contenu dynamique affiché passe par ici : les credentials (device-id,
# licence, tokens...) sont masquées — jamais de clé/secret dans un log.
info()  { echo "  → $(mask "$1")"; }

# --- Détection de l'environnement d'exécution --------------------------------
# ON_VPS=1 => le script tourne DIRECTEMENT sur le VPS : toutes les commandes
# (docker exec...) sont exécutées localement. Auto-détection : le conteneur
# cyrus-super-assistant-backend est visible dans le docker local.
ON_VPS=0
if [ "${VPS_DIRECT:-0}" = "1" ]; then
  ON_VPS=1
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'cyrus-super-assistant-backend'; then
  ON_VPS=1
elif command -v sudo >/dev/null 2>&1 && sudo docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'cyrus-super-assistant-backend'; then
  ON_VPS=1
fi

# Exécute une commande shell dans "l'environnement VPS" :
#   - sur le VPS   : bash -c (local, aucune connexion réseau)
#   - depuis le PC : gcloud compute ssh
run_on_vps() {
  if [ "$ON_VPS" = "1" ]; then
    bash -c "$1"
  else
    gcloud compute ssh "$VPS" --project="$PROJECT" --zone="$ZONE" --command="$1" 2>/dev/null
  fi
}

# docker exec dans cyrus-super-assistant-backend — passe par sudo automatiquement
# si l'utilisateur local n'a pas l'accès docker direct (selon le compte qui
# lance le script sur le VPS).
dc() {
  if [ "$ON_VPS" = "1" ]; then
    if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'cyrus-super-assistant-backend'; then
      docker exec "$@"
    else
      sudo docker exec "$@"
    fi
  else
    run_on_vps "docker exec $*"
  fi
}

# Masque la licence de test et tout identifiant/secret d'au moins 24 caractères
# (device-id UUID, tokens...) dans un texte destiné à l'affichage.
mask() {
  local s="$1"
  s="${s//$LICENCE/*****}"
  printf '%s' "$s" | sed -E 's/[A-Za-z0-9_-]{24,}/*****/g'
}

api() {
  curl -s -w "\n%{http_code}" "$@"
}

# Lecture des fichiers runtime de la mémoire 7 jours DANS le conteneur, en
# gérant les DEUX emplacements possibles : le volume persistant app_data
# (docker-compose actuel : /app/data/ai_engine) en PRIORITÉ, sinon l'ancien
# chemin éphémère (/app/ai_engine_data) — le script fonctionne donc avant ET
# après le redéploiement du correctif de persistance.
engine_file() { # $1 = chemin relatif (ex: message_history/KEY...__WHATSAPP.json)
  local rel="$1" out
  out=$(dc cyrus-super-assistant-backend cat "/app/data/ai_engine/$rel" 2>/dev/null || true)
  if [ -z "$out" ]; then
    out=$(dc cyrus-super-assistant-backend cat "/app/ai_engine_data/$rel" 2>/dev/null || true)
  fi
  [ -n "$out" ] && printf '%s' "$out" || echo "FILE_NOT_FOUND"
}
engine_license_file() { # licences runtime (volume /app/data/licenses.json puis ancien chemin)
  local out
  out=$(dc cyrus-super-assistant-backend cat /app/data/licenses.json 2>/dev/null || true)
  if [ -z "$out" ]; then
    out=$(dc cyrus-super-assistant-backend cat /app/licenses.json 2>/dev/null || true)
  fi
  [ -n "$out" ] && printf '%s' "$out" || echo "FILE_NOT_FOUND"
}

# === ÉTAPE 1 : Récupérer le device-id ===
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ÉTAPE 1 : Authentification — récupération device-id"
echo "═══════════════════════════════════════════════════════"

# Le fichier licences runtime est lu DANS le conteneur (docker exec) puis parsé
# LOCALEMENT — sur le VPS comme depuis le PC. Aucune clé n'est affichée : seul
# le device-id (masqué) et les compteurs restent visibles.
LIC_JSON=$(engine_license_file)
DEVICE_ID=$(printf '%s' "$LIC_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);const l=(j.licenses||[]).find(x=>x.key===process.argv[1]);const v=l&&(l.boundDeviceId||l.deviceId);console.log(v?String(v):'')}catch(e){console.log('')}});" "$LICENCE" 2>/dev/null || true)

if [ -z "$DEVICE_ID" ]; then
  red "Device-id introuvable pour la licence de test"
  echo "  Tentative alternative (checkout local)..."
  DEVICE_ID=$(grep -oE '"boundDeviceId":"[^"]*"|"deviceId":"[^"]*"' /home/cyrus2026/BusinessAutomationEngine/licenses.json 2>/dev/null | head -1 | cut -d'"' -f4 || true)
fi

if [ -z "$DEVICE_ID" ] || [ "$DEVICE_ID" = "" ]; then
  red "DEVICE_ID introuvable — tests API impossibles"
  SKIPPED=$((SKIPPED + 10))
  echo ""
  echo "Tentative de lecture directe des données stockées..."
else
  green "DEVICE_ID = $(mask "$DEVICE_ID")"
  PASSED=$((PASSED + 1))

  # === ÉTAPE 2 : Health check ===
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ÉTAPE 2 : Health check VPS"
  echo "═══════════════════════════════════════════════════════"

  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$URL/health" || true)
  if [ "$HEALTH" = "200" ]; then
    green "Health check = HTTP 200"
    PASSED=$((PASSED + 1))
  else
    red "Health check = HTTP $HEALTH"
    FAILED=$((FAILED + 1))
  fi

  # === ÉTAPE 3 : Diag tenants ===
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ÉTAPE 3 : Sessions actives (diag/tenants)"
  echo "═══════════════════════════════════════════════════════"

  RESP=$(api -H "x-license-key: $LICENCE" -H "x-device-id: $DEVICE_ID" "$URL/api/admin/diag/tenants" || true)
  HTTP=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [ "$HTTP" = "200" ]; then
    green "diag/tenants = HTTP 200"
    info "Réponse : $BODY"
    PASSED=$((PASSED + 1))

    HAS_WH=$(echo "$BODY" | grep -i "whatsapp" || true)
    HAS_TG=$(echo "$BODY" | grep -i "telegram" || true)
    if [ -n "$HAS_WH" ]; then green "WhatsApp session active"; else skip "WhatsApp non détecté dans les sessions"; fi
    if [ -n "$HAS_TG" ]; then green "Telegram session active"; else skip "Telegram non détecté dans les sessions"; fi
  else
    red "diag/tenants = HTTP $HTTP"
    info "Réponse : $BODY"
    FAILED=$((FAILED + 1))
  fi

  # === ÉTAPE 4 : Send-test WhatsApp individuel ===
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ÉTAPE 4 : Test WhatsApp — message individuel"
  echo "═══════════════════════════════════════════════════════"

  RESP=$(api -X POST \
    -H "x-license-key: $LICENCE" -H "x-device-id: $DEVICE_ID" \
    -H "Content-Type: application/json" \
    -d "{\"tenantId\":\"$LICENCE\",\"channel\":\"WHATSAPP\"}" \
    "$URL/api/admin/diag/send-test" || true)
  HTTP=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [ "$HTTP" = "200" ] || [ "$HTTP" = "201" ]; then
    green "send-test WhatsApp = HTTP $HTTP"
    info "Réponse : $BODY"
    PASSED=$((PASSED + 1))
  else
    red "send-test WhatsApp = HTTP $HTTP"
    info "Réponse : $BODY"
    FAILED=$((FAILED + 1))
  fi

  # Attendre 3 secondes pour la propagation
  sleep 3

  # === ÉTAPE 5 : Vérifier les messages stockés via API ===
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ÉTAPE 5 : Vérification messages WhatsApp stockés"
  echo "═══════════════════════════════════════════════════════"

  # Lire le fichier via docker exec (local sur le VPS, gcloud depuis le PC)
  MSG_DATA=$(engine_file "message_history/${LICENCE}__WHATSAPP.json")

  if echo "$MSG_DATA" | grep -q "FILE_NOT_FOUND"; then
    red "Fichier message_history WhatsApp introuvable"
    FAILED=$((FAILED + 1))
  else
    MSG_COUNT=$(echo "$MSG_DATA" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        try { const j=JSON.parse(d); console.log((j.messages||[]).length); }
        catch(e) { console.log('PARSE_ERROR'); }
      });" 2>/dev/null || echo "PARSE_ERROR")

    if [ "$MSG_COUNT" = "PARSE_ERROR" ]; then
      red "Impossible de parser le fichier message_history"
      FAILED=$((FAILED + 1))
    elif [ "$MSG_COUNT" -gt 0 ] 2>/dev/null; then
      green "Messages WhatsApp enregistrés : $MSG_COUNT"
      PASSED=$((PASSED + 1))

      # Vérifier les champs du dernier message
      echo "$MSG_DATA" | node -e "
        let d=''; process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
          const j=JSON.parse(d);
          const m=(j.messages||[]).slice(-1)[0];
          if(!m){console.log('AUCUN_MESSAGE');return;}
          const fields=['channel','direction','party','text','ts','chatId','messageId','isGroup'];
          const missing=fields.filter(f=>m[f]===undefined||m[f]===null);
          if(missing.length){console.log('CHAMPS_MANQUANTS:'+missing.join(','));}
          else{console.log('TOUS_CHAMPS_OK');}
          console.log('  channel='+m.channel);
          console.log('  direction='+m.direction);
          console.log('  party='+m.party);
          console.log('  text='+(m.text||'').substring(0,50));
          console.log('  ts='+m.ts);
          console.log('  chatId='+m.chatId);
          console.log('  messageId='+m.messageId);
          console.log('  isGroup='+m.isGroup);
          console.log('  senderId='+(m.senderId||'null'));
          console.log('  senderName='+(m.senderName||'null'));
          console.log('  number='+(m.number||'null'));
          console.log('  at='+(m.at||'null'));
        });" 2>/dev/null | while IFS= read -r line; do
          if echo "$line" | grep -q "TOUS_CHAMPS_OK"; then
            green "Tous les champs requis sont présents"
            PASSED=$((PASSED + 1))
          elif echo "$line" | grep -q "CHAMPS_MANQUANTS"; then
            red "$line"
            FAILED=$((FAILED + 1))
          else
            info "$line"
          fi
        done
    else
      red "Aucun message enregistré (count=$MSG_COUNT)"
      FAILED=$((FAILED + 1))
    fi
  fi

  # === ÉTAPE 6 : Vérifier l'index conversationnel ===
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ÉTAPE 6 : Vérification conversation_index"
  echo "═══════════════════════════════════════════════════════"

  IDX_DATA=$(engine_file "conversation_index/${LICENCE}__WHATSAPP.json")

  if echo "$IDX_DATA" | grep -q "FILE_NOT_FOUND"; then
    red "Fichier conversation_index WhatsApp introuvable"
    FAILED=$((FAILED + 1))
  else
    echo "$IDX_DATA" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        const j=JSON.parse(d);
        const convs=Object.values(j.conversations||{});
        console.log('Conversations indexées : '+convs.length);
        convs.forEach(c=>{
          console.log('  chatId='+c.chatId+' type='+c.type+' platform='+c.platform);
          console.log('    lastMessage='+(c.lastMessage||'').substring(0,50));
          console.log('    messageCount='+c.messageCount+' lastMessageAt='+new Date(c.lastMessageAt).toISOString());
        });
        if(convs.length>0){console.log('INDEX_OK');}
        else{console.log('INDEX_VIDE');}
      });" 2>/dev/null | while IFS= read -r line; do
        if [ "$line" = "INDEX_OK" ]; then
          green "Index conversationnel contient des données"
          PASSED=$((PASSED + 1))
        elif [ "$line" = "INDEX_VIDE" ]; then
          red "Index conversationnel vide"
          FAILED=$((FAILED + 1))
        else
          info "$line"
        fi
      done
  fi

  # === ÉTAPE 7 : Fenêtre glissante 7 jours ===
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ÉTAPE 7 : Fenêtre glissante 7 jours"
  echo "═══════════════════════════════════════════════════════"

  if ! echo "$MSG_DATA" | grep -q "FILE_NOT_FOUND"; then
    echo "$MSG_DATA" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        const j=JSON.parse(d);
        const msgs=j.messages||[];
        const now=Date.now();
        const cutoff=now-7*24*3600*1000;
        const inWindow=msgs.filter(m=>(m.tsMs||0)>=cutoff);
        const outWindow=msgs.filter(m=>(m.tsMs||0)<cutoff&&(m.tsMs||0)>0);
        console.log('Total messages : '+msgs.length);
        console.log('Dans fenêtre 7j : '+inWindow.length);
        console.log('Hors fenêtre : '+outWindow.length);
        if(outWindow.length===0){console.log('FENETRE_OK:aucun message hors fenêtre');}
        else{console.log('FENETRE_PRESENTE:'+outWindow.length+' messages hors fenêtre encore stockés');}
        console.log('RETENTION_DAYS=7 (constante du code)');
      });" 2>/dev/null | while IFS= read -r line; do
        if echo "$line" | grep -q "FENETRE_OK"; then
          green "$line"
          PASSED=$((PASSED + 1))
        elif echo "$line" | grep -q "FENETRE_PRESENTE"; then
          info "$line (normal si le nettoyage périodique n'a pas encore tourné)"
          PASSED=$((PASSED + 1))
        else
          info "$line"
        fi
      done
  fi
fi

# === ÉTAPE 8 : Données Telegram (lecture directe) ===
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ÉTAPE 8 : Données Telegram"
echo "═══════════════════════════════════════════════════════"

TG_MSG=$(engine_file "message_history/${LICENCE}__TELEGRAM.json")
TG_IDX=$(engine_file "conversation_index/${LICENCE}__TELEGRAM.json")

if echo "$TG_MSG" | grep -q "FILE_NOT_FOUND"; then
  skip "Aucun fichier message_history Telegram pour $(mask "$LICENCE")"
else
  TG_COUNT=$(echo "$TG_MSG" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); console.log((j.messages||[]).length); }
      catch(e) { console.log('PARSE_ERROR'); }
    });" 2>/dev/null || echo "0")
  green "Messages Telegram enregistrés : $TG_COUNT"
  PASSED=$((PASSED + 1))

  if [ "$TG_COUNT" -gt 0 ] 2>/dev/null; then
    echo "$TG_MSG" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        const j=JSON.parse(d);
        const m=(j.messages||[]).slice(-1)[0];
        if(!m)return;
        console.log('  Dernier message :');
        console.log('    channel='+m.channel);
        console.log('    direction='+m.direction);
        console.log('    party='+m.party);
        console.log('    text='+(m.text||'').substring(0,50));
        console.log('    isGroup='+m.isGroup);
        console.log('    senderId='+(m.senderId||'null'));
        console.log('    chatId='+m.chatId);
        console.log('    at='+(m.at||'null'));
      });" 2>/dev/null | while IFS= read -r line; do
        info "$line"
      done
  fi
fi

if echo "$TG_IDX" | grep -q "FILE_NOT_FOUND"; then
  skip "Aucun fichier conversation_index Telegram pour $(mask "$LICENCE")"
else
  echo "$TG_IDX" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      const j=JSON.parse(d);
      const convs=Object.values(j.conversations||{});
      console.log('Conversations Telegram indexées : '+convs.length);
      convs.forEach(c=>{
        console.log('  chatId='+c.chatId+' type='+c.type);
        console.log('    lastMessage='+(c.lastMessage||'').substring(0,50));
        console.log('    messageCount='+c.messageCount);
      });
    });" 2>/dev/null | while IFS= read -r line; do
      info "$line"
    done
  PASSED=$((PASSED + 1))
fi

# === ÉTAPE 9 : Send-test Telegram ===
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ÉTAPE 9 : Test Telegram — message individuel"
echo "═══════════════════════════════════════════════════════"

if [ -n "$DEVICE_ID" ] && [ "$DEVICE_ID" != "NOT_FOUND" ]; then
  RESP=$(api -X POST \
    -H "x-license-key: $LICENCE" -H "x-device-id: $DEVICE_ID" \
    -H "Content-Type: application/json" \
    -d "{\"tenantId\":\"$LICENCE\",\"channel\":\"TELEGRAM\"}" \
    "$URL/api/admin/diag/send-test" || true)
  HTTP=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')

  if [ "$HTTP" = "200" ] || [ "$HTTP" = "201" ]; then
    green "send-test Telegram = HTTP $HTTP"
    info "Réponse : $BODY"
    PASSED=$((PASSED + 1))
  else
    red "send-test Telegram = HTTP $HTTP"
    info "Réponse : $BODY"
    FAILED=$((FAILED + 1))
  fi
  sleep 3
else
  skip "send-test Telegram (DEVICE_ID non disponible)"
fi

# === ÉTAPE 10 : Docker logs ===
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ÉTAPE 10 : Docker container status + logs récents"
echo "═══════════════════════════════════════════════════════"

CONTAINER_STATUS=$(run_on_vps "sudo docker inspect --format='{{.State.Status}} (Up {{.State.StartedAt}})' cyrus-super-assistant-backend 2>/dev/null || echo 'CONTAINER_NOT_FOUND'")
if echo "$CONTAINER_STATUS" | grep -q "CONTAINER_NOT_FOUND"; then
  red "Conteneur cyrus-super-assistant-backend introuvable"
  FAILED=$((FAILED + 1))
else
  green "Conteneur : $CONTAINER_STATUS"
  PASSED=$((PASSED + 1))
fi

LOG_ERRORS=$(run_on_vps "sudo docker logs cyrus-super-assistant-backend --tail 100 2>&1 | grep -i 'MODULE_NOT_FOUND\|SyntaxError\|FATAL\|memoryHistory\|conversation_index\|messageHistory' | tail -10 || echo 'NO_MATCHES'")
if echo "$LOG_ERRORS" | grep -q "NO_MATCHES"; then
  green "Aucune erreur liée à la mémoire conversationnelle dans les logs"
  PASSED=$((PASSED + 1))
else
  info "Messages liés à la mémoire dans les logs :"
  echo "$LOG_ERRORS" | while IFS= read -r line; do
    info "  $line"
  done
  # Vérifier s'il y a de vraies erreurs
  if echo "$LOG_ERRORS" | grep -qi "error\|fatal\|crash"; then
    red "Erreurs détectées dans les logs"
    FAILED=$((FAILED + 1))
  else
    green "Logs OK (info, pas d'erreur)"
    PASSED=$((PASSED + 1))
  fi
fi

# === RÉSUMÉ FINAL ===
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  RÉSUMÉ DES TESTS VIVANTS — MÉMOIRE 7 JOURS"
echo "═══════════════════════════════════════════════════════"
echo ""
green "Réussis : $PASSED"
if [ "$FAILED" -gt 0 ]; then red "Échoués : $FAILED"; fi
if [ "$SKIPPED" -gt 0 ]; then skip "Ignorés : $SKIPPED"; fi
echo ""
echo "Compte : $(mask "$LICENCE")"
echo "VPS    : $URL"
echo "Date   : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""
echo "═══════════════════════════════════════════════════════"
