/**
 * Moteur WhatsApp reel via WebView Android + injection JS — alternative a
 * Baileys embarque (bloque par le plafond Node 18 de
 * nodejs-mobile-react-native, voir CLAUDE.md et main.js). Connexion, envoi
 * et reception de texte tous valides de bout en bout sur appareil reel le
 * 2026-09-10 (voir CLAUDE.md).
 *
 * La WebView WhatsApp Web reste visible UNIQUEMENT pendant l'appairage (ou
 * une reconnexion) : l'utilisateur doit voir le QR ou saisir un code sur son
 * telephone. Une fois connectee, elle est reduite hors-ecran (pas demontee :
 * le JS injecte doit continuer de tourner pour recevoir les messages) et
 * remplacee visuellement par l'UI Cyrus : une liste de conversations
 * (deduite des messages vus depuis l'ouverture de l'app, pas d'historique
 * charge ni de persistance disque) puis, par conversation, un fil de
 * discussion avec bulles animees et saisie — un contact ouvert a la fois,
 * toujours dans l'esprit "texte seul" du spike qu'il remplace. Si la
 * session se coupe apres une connexion reussie, un bandeau invite a se
 * reconnecter et la WebView redevient visible automatiquement.
 *
 * Toujours "zero serveur" : tout tourne dans la WebView, sur le telephone.
 *
 * @format
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Animated,
  Easing,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {WebView, WebViewMessageEvent} from 'react-native-webview';
import {WHATSAPP_WEB_BRIDGE_SCRIPT} from './whatsappWebBridge';

const COLORS = {
  bg: '#0A0E14',
  card: '#131A24',
  cardBorder: '#1F2A38',
  cyan: '#22D3EE',
  cyanDim: 'rgba(34, 211, 238, 0.12)',
  green: '#34D399',
  red: '#F87171',
  textPrimary: '#F1F5F9',
  textSecondary: '#7C8A9C',
  bubbleMine: 'rgba(34, 211, 238, 0.16)',
  bubbleOther: '#1B2430',
};

const STATE_LABELS: Record<string, string> = {
  CONNECTED: 'Connecte',
  UNPAIRED: 'Non appaire — scannez le QR',
  UNPAIRED_IDLE: 'Non appaire',
  OPENING: 'Connexion en cours…',
  PAIRING: 'Appairage en cours…',
  TIMEOUT: 'Delai depasse',
  CONFLICT: 'Session ouverte ailleurs',
  UNLAUNCHED: 'Demarrage…',
  DEPRECATED_VERSION: 'Version obsolete',
  CHARGEMENT: 'Chargement…',
};

// Meme UA que WebViewTest.tsx — WhatsApp Web sert une page degradee
// ("utilisez un navigateur pris en charge") aux User-Agents mobiles.
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

type ChatMessage = {
  id: string;
  from: string;
  to: string;
  body: string;
  fromMe: boolean;
  t: number;
};

type BridgeEvent =
  | {type: 'state'; payload: {state: string}}
  | {type: 'bridge-ready'; payload: {}}
  | {type: 'bridge-error'; payload: {where: string; message: string}}
  | {type: 'message'; payload: ChatMessage}
  | {type: 'send-result'; payload: {ok: boolean; chatId: string; error?: string}};

// Un ID WhatsApp est "numero@suffixe" (@c.us, @s.whatsapp.net, @lid...) - on
// ne compare que la partie numerique pour savoir si un message appartient a
// la conversation actuellement ouverte, quel que soit le suffixe exact.
function normalizeWid(raw: string): string {
  return (raw || '').split('@')[0].replace(/\D/g, '');
}

// Pastille de statut avec pulsation en boucle quand connecte — meme
// technique que App.tsx (PulseDot), dupliquee ici volontairement : ce
// fichier reste autonome comme WebViewTest.tsx qu'il prolonge.
function PulseDot({active}: {active: boolean}) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {toValue: 1, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true}),
        Animated.timing(pulse, {toValue: 0, duration: 900, easing: Easing.in(Easing.ease), useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const scale = pulse.interpolate({inputRange: [0, 1], outputRange: [1, 1.9]});
  const opacity = pulse.interpolate({inputRange: [0, 1], outputRange: [0.55, 0]});

  return (
    <View style={styles.statusDotWrap}>
      {active && (
        <Animated.View
          style={[styles.statusDotGlow, {backgroundColor: COLORS.green, transform: [{scale}], opacity}]}
        />
      )}
      <View style={[styles.statusDot, {backgroundColor: active ? COLORS.green : COLORS.textSecondary}]} />
    </View>
  );
}

// Apparition douce d'une bulle de message (fondu + leger glissement) plutot
// qu'un simple pop instantane — demande explicite d'interface "addictive".
function MessageBubble({item}: {item: ChatMessage}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(anim, {toValue: 1, duration: 220, easing: Easing.out(Easing.ease), useNativeDriver: true}).start();
  }, [anim]);

  const translateY = anim.interpolate({inputRange: [0, 1], outputRange: [8, 0]});

  return (
    <Animated.View
      style={[
        styles.bubbleRow,
        item.fromMe ? styles.bubbleRowMine : styles.bubbleRowOther,
        {opacity: anim, transform: [{translateY}]},
      ]}>
      <View style={[styles.bubble, item.fromMe ? styles.bubbleMine : styles.bubbleOther]}>
        <Text style={styles.bubbleText}>{item.body}</Text>
      </View>
    </Animated.View>
  );
}

function WhatsAppWebEngine(): React.JSX.Element {
  const webViewRef = useRef<WebView>(null);
  const [waState, setWaState] = useState<string>('CHARGEMENT');
  const [bridgeReady, setBridgeReady] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [allMessages, setAllMessages] = useState<ChatMessage[]>([]);
  const [activeContact, setActiveContact] = useState(''); // chiffres seuls, sans suffixe
  const [contactInput, setContactInput] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const threadListRef = useRef<FlatList<ChatMessage>>(null);
  const [wasConnected, setWasConnected] = useState(false);

  const connected = waState === 'CONNECTED';

  useEffect(() => {
    if (connected) setWasConnected(true);
  }, [connected]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    let data: BridgeEvent;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    switch (data.type) {
      case 'state':
        setWaState(data.payload.state);
        break;
      case 'bridge-ready':
        setBridgeReady(true);
        break;
      case 'bridge-error':
        setLastError(`${data.payload.where}: ${data.payload.message}`);
        break;
      case 'message':
        setAllMessages(prev => [data.payload, ...prev].slice(0, 200));
        break;
      case 'send-result':
        setSending(false);
        setSendStatus(
          data.payload.ok ? null : `Echec d'envoi : ${data.payload.error}`,
        );
        break;
    }
  }, []);

  const thread = useMemo(() => {
    if (!activeContact) return [];
    // allMessages est du plus recent au plus ancien (on prepend a la
    // reception) ; la liste de conversation se lit du plus ancien en haut
    // au plus recent en bas, d'ou l'inversion ici plutot qu'un FlatList
    // "inverted" (qui mirroir aussi le rendu des enfants, y compris
    // ListEmptyComponent - constate sur appareil, non retenu).
    return allMessages
      .filter(m => normalizeWid(m.fromMe ? m.to : m.from) === activeContact)
      .slice()
      .reverse();
  }, [allMessages, activeContact]);

  // Liste des conversations derivee des messages vus depuis l'ouverture de
  // l'app (pas d'historique WhatsApp charge, pas de persistance disque -
  // reste dans l'esprit "spike" : ce que l'app a vu passer, rien de plus).
  const chatList = useMemo(() => {
    const byPeer = new Map<string, ChatMessage>();
    for (const m of allMessages) {
      const peer = normalizeWid(m.fromMe ? m.to : m.from);
      if (!peer) continue;
      const existing = byPeer.get(peer);
      if (!existing || m.t > existing.t) byPeer.set(peer, m);
    }
    return Array.from(byPeer.entries())
      .map(([peer, lastMessage]) => ({peer, lastMessage}))
      .sort((a, b) => b.lastMessage.t - a.lastMessage.t);
  }, [allMessages]);

  const openContact = useCallback(
    (peer?: string) => {
      const digits = (peer ?? contactInput).replace(/\D/g, '');
      if (!digits) return;
      setActiveContact(digits);
      setContactInput('');
      setSendStatus(null);
    },
    [contactInput],
  );

  const closeContact = useCallback(() => {
    setActiveContact('');
    setSendStatus(null);
  }, []);

  const send = useCallback(() => {
    if (!bridgeReady || !activeContact || !text.trim() || sending) return;
    setSending(true);
    setSendStatus(null);
    const script = `window.__cyrusSend && window.__cyrusSend(${JSON.stringify(
      `${activeContact}@c.us`,
    )}, ${JSON.stringify(text.trim())}); true;`;
    webViewRef.current?.injectJavaScript(script);
    setText('');
  }, [bridgeReady, activeContact, text, sending]);

  const canSend = bridgeReady && !!activeContact && text.trim().length > 0 && !sending;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.statusBar}>
        {activeContact && connected && (
          <Pressable onPress={closeContact} hitSlop={8}>
            <Text style={styles.backArrow}>←</Text>
          </Pressable>
        )}
        <PulseDot active={connected} />
        <Text style={styles.statusText}>
          {activeContact && connected
            ? activeContact
            : `${STATE_LABELS[waState] ?? waState} · Pont ${bridgeReady ? 'pret' : 'en attente'}`}
        </Text>
      </View>
      {lastError && <Text style={styles.errorText}>Erreur : {lastError}</Text>}
      {!connected && wasConnected && (
        <Text style={styles.reconnectBanner}>
          Session WhatsApp interrompue — reconnecte-toi ci-dessous (QR ou numero).
        </Text>
      )}

      {/* Pendant l'appairage (ou une reconnexion) : WebView visible en plein
          ecran (le QR ou le flux "lier avec le numero" doit etre visible et
          interactif). Une fois connecte : reduite hors-ecran mais toujours
          montee, pour que le pont injecte continue de tourner et de
          recevoir les messages. */}
      <WebView
        ref={webViewRef}
        source={{uri: 'https://web.whatsapp.com'}}
        userAgent={DESKTOP_UA}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        injectedJavaScript={WHATSAPP_WEB_BRIDGE_SCRIPT}
        onMessage={onMessage}
        onError={e => setLastError(`load: ${e.nativeEvent.description}`)}
        style={connected ? styles.webviewHidden : styles.webview}
      />

      {connected && activeContact && (
        <KeyboardAvoidingView
          style={styles.chatArea}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <FlatList
            ref={threadListRef}
            data={thread}
            keyExtractor={(item, index) => item.id || `${item.t}-${index}`}
            style={styles.thread}
            contentContainerStyle={styles.threadContent}
            renderItem={({item}) => <MessageBubble item={item} />}
            onContentSizeChange={() => threadListRef.current?.scrollToEnd({animated: true})}
            ListEmptyComponent={
              <Text style={styles.threadEmpty}>
                Aucun message avec {activeContact} pour l'instant.
              </Text>
            }
          />
          <View style={styles.composeRow}>
            <TextInput
              style={styles.composeInput}
              placeholder="Message texte"
              placeholderTextColor={COLORS.textSecondary}
              value={text}
              onChangeText={setText}
              multiline
            />
            <Pressable
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              onPress={send}
              disabled={!canSend}>
              <Text style={styles.sendButtonText}>{sending ? '···' : 'Envoyer'}</Text>
            </Pressable>
          </View>
          {sendStatus && <Text style={styles.sendStatusText}>{sendStatus}</Text>}
        </KeyboardAvoidingView>
      )}

      {connected && !activeContact && (
        <View style={styles.chatArea}>
          <View style={styles.contactBar}>
            <TextInput
              style={styles.contactInput}
              placeholder="Nouveau numero (ex: 22664977093, sans le +)"
              placeholderTextColor={COLORS.textSecondary}
              value={contactInput}
              onChangeText={setContactInput}
              keyboardType="phone-pad"
            />
            <Pressable style={styles.contactButton} onPress={() => openContact()}>
              <Text style={styles.contactButtonText}>Ouvrir</Text>
            </Pressable>
          </View>

          <FlatList
            data={chatList}
            keyExtractor={item => item.peer}
            renderItem={({item}) => (
              <Pressable style={styles.chatRow} onPress={() => openContact(item.peer)}>
                <View style={styles.chatAvatar}>
                  <Text style={styles.chatAvatarText}>{item.peer.slice(-2)}</Text>
                </View>
                <View style={styles.chatRowBody}>
                  <Text style={styles.chatRowPeer}>{item.peer}</Text>
                  <Text style={styles.chatRowPreview} numberOfLines={1}>
                    {item.lastMessage.fromMe ? 'Moi : ' : ''}
                    {item.lastMessage.body}
                  </Text>
                </View>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={styles.noContactText}>
                Aucune conversation pour l'instant. Saisis un numero ci-dessus pour en demarrer
                une.
              </Text>
            }
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: COLORS.bg},
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    backgroundColor: COLORS.card,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  statusDotWrap: {width: 10, height: 10, alignItems: 'center', justifyContent: 'center'},
  statusDot: {width: 8, height: 8, borderRadius: 4},
  statusDotGlow: {position: 'absolute', width: 8, height: 8, borderRadius: 4},
  statusText: {color: COLORS.cyan, fontSize: 12, fontWeight: '600'},
  backArrow: {color: COLORS.cyan, fontSize: 18, fontWeight: '700', marginRight: 2},
  errorText: {color: COLORS.red, fontSize: 11, paddingHorizontal: 10, paddingTop: 4, backgroundColor: COLORS.card},
  reconnectBanner: {
    color: COLORS.bg,
    backgroundColor: COLORS.cyan,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  webview: {flex: 1},
  webviewHidden: {position: 'absolute', top: -2000, left: 0, width: 300, height: 300, opacity: 0},
  chatArea: {flex: 1},
  contactBar: {
    flexDirection: 'row',
    gap: 8,
    padding: 10,
    backgroundColor: COLORS.card,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  contactInput: {
    flex: 1,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: COLORS.textPrimary,
    fontSize: 13,
  },
  contactButton: {
    backgroundColor: COLORS.cyanDim,
    borderWidth: 1,
    borderColor: COLORS.cyan,
    borderRadius: 8,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  contactButtonText: {color: COLORS.cyan, fontWeight: '700', fontSize: 13},
  noContactText: {color: COLORS.textSecondary, fontSize: 13, textAlign: 'center', padding: 24},
  chatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.cardBorder,
  },
  chatAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.cyanDim,
    borderWidth: 1,
    borderColor: COLORS.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatAvatarText: {color: COLORS.cyan, fontWeight: '700', fontSize: 13},
  chatRowBody: {flex: 1},
  chatRowPeer: {color: COLORS.textPrimary, fontSize: 14, fontWeight: '600'},
  chatRowPreview: {color: COLORS.textSecondary, fontSize: 12, marginTop: 2},
  thread: {flex: 1},
  threadContent: {padding: 10, flexGrow: 1, justifyContent: 'flex-end'},
  threadEmpty: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 20,
  },
  bubbleRow: {flexDirection: 'row', marginVertical: 3},
  bubbleRowMine: {justifyContent: 'flex-end'},
  bubbleRowOther: {justifyContent: 'flex-start'},
  bubble: {maxWidth: '80%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8},
  bubbleMine: {backgroundColor: COLORS.bubbleMine, borderBottomRightRadius: 4},
  bubbleOther: {backgroundColor: COLORS.bubbleOther, borderBottomLeftRadius: 4},
  bubbleText: {color: COLORS.textPrimary, fontSize: 14},
  composeRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 10,
    backgroundColor: COLORS.card,
    borderTopWidth: 1,
    borderTopColor: COLORS.cardBorder,
  },
  composeInput: {
    flex: 1,
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: COLORS.textPrimary,
    fontSize: 14,
    maxHeight: 100,
  },
  sendButton: {backgroundColor: COLORS.cyan, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10},
  sendButtonDisabled: {opacity: 0.4},
  sendButtonText: {color: '#04141A', fontWeight: '700', fontSize: 13},
  sendStatusText: {color: COLORS.red, fontSize: 11, paddingHorizontal: 10, paddingBottom: 6, backgroundColor: COLORS.card},
});

export default WhatsAppWebEngine;
