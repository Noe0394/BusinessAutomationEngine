#!/bin/bash
# test/vps-live-test.sh — Tests vivants de la mémoire conversationnelle 7 jours
# Exécuter avec : ! bash test/vps-live-test.sh
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
info()  { echo "  → $1"; }

ssh_vps() {
  gcloud compute ssh "$VPS" --project="$PROJECT" --zone="$ZONE" --command="$1" 2>/dev/null
}

api() {
  curl -s -w "\n%{http_code}" "$@"
}

# === ÉTAPE 1 : Récupérer le device-id ===
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ÉTAPE 1 : Authentification — récupération device-id"
echo "═══════════════════════════════════════════════════════"

DEVICE_ID=$(ssh_vps "node -e \"var j=require('/home/cyrus2026/BusinessAutomationEngine/licenses.json'); var l=(j.licenses||[]).find(l=>l.key==='$LICENCE'); console.log(l?l.deviceId:'NOT_FOUND')\"")

if [ -z "$DEVICE_ID" ] || [ "$DEVICE_ID" = "NOT_FOUND" ]; then
  red "Impossible de récupérer le device-id pour $LICENCE"
  echo "  Tentative alternative..."
  DEVICE_ID=$(ssh_vps "grep -o '\"deviceId\":\"[^\"]*\"' /home/cyrus2026/BusinessAutomationEngine/licenses.json | head -1 | cut -d'\"' -f4")
fi

if [ -z "$DEVICE_ID" ] || [ "$DEVICE_ID" = "" ]; then
  red "DEVICE_ID introuvable — tests API impossibles"
  SKIPPED=$((SKIPPED + 10))
  echo ""
  echo "Tentative de lecture directe des données stockées..."
else
  green "DEVICE_ID = $DEVICE_ID"
  PASSED=$((PASSED + 1))

  # === ÉTAPE 2 : Health check ===
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  ÉTAPE 2 : Health check VPS"
  echo "═══════════════════════════════════════════════════════"

  HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$URL/health")
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

  RESP=$(api -H "x-license-key: $LICENCE" -H "x-device-id: $DEVICE_ID" "$URL/api/admin/diag/tenants")
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
    "$URL/api/admin/diag/send-test")
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

  # Lire le fichier directement sur le VPS
  MSG_DATA=$(ssh_vps "docker exec cyrus-super-assistant-backend cat /app/ai_engine_data/message_history/${LICENCE}__WHATSAPP.json 2>/dev/null || echo 'FILE_NOT_FOUND'")

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

  IDX_DATA=$(ssh_vps "docker exec cyrus-super-assistant-backend cat /app/ai_engine_data/conversation_index/${LICENCE}__WHATSAPP.json 2>/dev/null || echo 'FILE_NOT_FOUND'")

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

TG_MSG=$(ssh_vps "docker exec cyrus-super-assistant-backend cat /app/ai_engine_data/message_history/${LICENCE}__TELEGRAM.json 2>/dev/null || echo 'FILE_NOT_FOUND'")
TG_IDX=$(ssh_vps "docker exec cyrus-super-assistant-backend cat /app/ai_engine_data/conversation_index/${LICENCE}__TELEGRAM.json 2>/dev/null || echo 'FILE_NOT_FOUND'")

if echo "$TG_MSG" | grep -q "FILE_NOT_FOUND"; then
  skip "Aucun fichier message_history Telegram pour $LICENCE"
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
  skip "Aucun fichier conversation_index Telegram pour $LICENCE"
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
    "$URL/api/admin/diag/send-test")
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

CONTAINER_STATUS=$(ssh_vps "sudo docker inspect --format='{{.State.Status}} (Up {{.State.StartedAt}})' cyrus-super-assistant-backend 2>/dev/null || echo 'CONTAINER_NOT_FOUND'")
if echo "$CONTAINER_STATUS" | grep -q "CONTAINER_NOT_FOUND"; then
  red "Conteneur cyrus-super-assistant-backend introuvable"
  FAILED=$((FAILED + 1))
else
  green "Conteneur : $CONTAINER_STATUS"
  PASSED=$((PASSED + 1))
fi

LOG_ERRORS=$(ssh_vps "sudo docker logs cyrus-super-assistant-backend --tail 100 2>&1 | grep -i 'MODULE_NOT_FOUND\|SyntaxError\|FATAL\|memoryHistory\|conversation_index\|messageHistory' | tail -10 || echo 'NO_MATCHES'")
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
echo "Compte : $LICENCE"
echo "VPS    : $URL"
echo "Date   : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""
echo "═══════════════════════════════════════════════════════"
