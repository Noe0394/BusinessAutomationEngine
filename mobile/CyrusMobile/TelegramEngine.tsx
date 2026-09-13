/**
 * Telegram reel via GramJS dans le runtime Node embarque (voir
 * nodejs-assets/nodejs-project/telegram.js) - "connexion normale" (compte
 * utilisateur MTProto reel, meme bibliotheque que adapters/telegram.js sur
 * le VPS), pas de WebView : contrairement a WhatsApp, Telegram n'a jamais
 * bloque Baileys/GramJS sur Node 18, donc pas besoin du contournement
 * WebView utilise pour WhatsApp (voir WhatsAppWebEngine.tsx). Zero serveur :
 * tourne entierement sur le telephone.
 *
 * Necessite un API ID + API Hash Telegram (my.telegram.org, lies au compte
 * developpeur de l'utilisateur) - saisis une fois, persistes cote Node
 * embarque (telegram_credentials.json dans le dossier de donnees de l'app).
 *
 * @format
 */

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
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
import nodejs from 'nodejs-mobile-react-native';

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

type LoginStep = 'setup' | 'pending' | 'code_required' | 'password_required' | 'connected' | 'error';

type ChatMessage = {id: string; peer: string; text: string; fromMe: boolean; t: number};

function TelegramEngine(): React.JSX.Element {
  const [step, setStep] = useState<LoginStep>('setup');
  const [loginError, setLoginError] = useState<string | null>(null);
  // Valeurs par defaut = identifiants application Telegram du projet
  // (my.telegram.org, memes que adapters/telegram.js cote VPS/.env) -
  // modifiables si l'utilisateur veut utiliser sa propre application.
  const [apiId, setApiId] = useState('28425082');
  const [apiHash, setApiHash] = useState('23d46fc58bce504b00eb05c05d1ad58a');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [allMessages, setAllMessages] = useState<ChatMessage[]>([]);
  const [activePeer, setActivePeer] = useState('');
  const [peerInput, setPeerInput] = useState('');
  const [text, setText] = useState('');
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const threadListRef = useRef<FlatList<ChatMessage>>(null);

  useEffect(() => {
    const onStep = (payload: {step: LoginStep; error?: string | null}) => {
      setSubmitting(false);
      setStep(payload.step);
      setLoginError(payload.error || null);
    };
    const onMessage = (payload: {from: string; text: string}) => {
      setAllMessages(prev => [
        {id: `${Date.now()}-${Math.random()}`, peer: payload.from, text: payload.text, fromMe: false, t: Date.now()},
        ...prev,
      ].slice(0, 200));
    };
    const onSendResult = (payload: {ok: boolean; to: string; error?: string}) => {
      setSendStatus(payload.ok ? null : `Echec d'envoi : ${payload.error}`);
    };
    nodejs.channel.addListener('telegram-login-step', onStep);
    nodejs.channel.addListener('telegram-message', onMessage);
    nodejs.channel.addListener('telegram-send-result', onSendResult);
    return () => {
      nodejs.channel.removeListener('telegram-login-step', onStep);
      nodejs.channel.removeListener('telegram-message', onMessage);
      nodejs.channel.removeListener('telegram-send-result', onSendResult);
    };
  }, []);

  const startLogin = useCallback(() => {
    if (!apiId.trim() || !apiHash.trim() || !phoneNumber.trim() || submitting) return;
    setSubmitting(true);
    setLoginError(null);
    nodejs.channel.post('telegram-login-start', {
      apiId: apiId.trim(),
      apiHash: apiHash.trim(),
      phoneNumber: phoneNumber.trim(),
    });
  }, [apiId, apiHash, phoneNumber, submitting]);

  const submitCode = useCallback(() => {
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    nodejs.channel.post('telegram-submit-code', {code: code.trim()});
    setCode('');
  }, [code, submitting]);

  const submitPassword = useCallback(() => {
    if (!password.trim() || submitting) return;
    setSubmitting(true);
    nodejs.channel.post('telegram-submit-password', {password: password.trim()});
    setPassword('');
  }, [password, submitting]);

  const openPeer = useCallback((peer?: string) => {
    const value = (peer ?? peerInput).trim();
    if (!value) return;
    setActivePeer(value);
    setPeerInput('');
    setSendStatus(null);
  }, [peerInput]);

  const closePeer = useCallback(() => {
    setActivePeer('');
    setSendStatus(null);
  }, []);

  const send = useCallback(() => {
    if (!activePeer || !text.trim()) return;
    nodejs.channel.post('telegram-send', {to: activePeer, text: text.trim()});
    setAllMessages(prev => [
      {id: `${Date.now()}-${Math.random()}`, peer: activePeer, text: text.trim(), fromMe: true, t: Date.now()},
      ...prev,
    ].slice(0, 200));
    setText('');
  }, [activePeer, text]);

  const thread = useMemo(
    () => allMessages.filter(m => m.peer === activePeer).slice().reverse(),
    [allMessages, activePeer],
  );

  const chatList = useMemo(() => {
    const byPeer = new Map<string, ChatMessage>();
    for (const m of allMessages) {
      const existing = byPeer.get(m.peer);
      if (!existing || m.t > existing.t) byPeer.set(m.peer, m);
    }
    return Array.from(byPeer.entries())
      .map(([peer, lastMessage]) => ({peer, lastMessage}))
      .sort((a, b) => b.lastMessage.t - a.lastMessage.t);
  }, [allMessages]);

  if (step === 'connected' && activePeer) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.statusBar}>
          <Pressable onPress={closePeer} hitSlop={8}>
            <Text style={styles.backArrow}>{'<'}</Text>
          </Pressable>
          <Text style={styles.statusText}>{activePeer}</Text>
        </View>
        <KeyboardAvoidingView style={styles.chatArea} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <FlatList
            ref={threadListRef}
            data={thread}
            keyExtractor={item => item.id}
            style={styles.thread}
            contentContainerStyle={styles.threadContent}
            onContentSizeChange={() => threadListRef.current?.scrollToEnd({animated: true})}
            renderItem={({item}) => (
              <View style={[styles.bubbleRow, item.fromMe ? styles.bubbleRowMine : styles.bubbleRowOther]}>
                <View style={[styles.bubble, item.fromMe ? styles.bubbleMine : styles.bubbleOther]}>
                  <Text style={styles.bubbleText}>{item.text}</Text>
                </View>
              </View>
            )}
            ListEmptyComponent={<Text style={styles.emptyText}>Aucun message avec {activePeer} pour l'instant.</Text>}
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
            <Pressable style={styles.sendButton} onPress={send} disabled={!text.trim()}>
              <Text style={styles.sendButtonText}>Envoyer</Text>
            </Pressable>
          </View>
          {sendStatus && <Text style={styles.errorText}>{sendStatus}</Text>}
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (step === 'connected') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>Telegram connecte</Text>
        </View>
        <View style={styles.contactBar}>
          <TextInput
            style={styles.contactInput}
            placeholder="@username ou numero (avec indicatif)"
            placeholderTextColor={COLORS.textSecondary}
            value={peerInput}
            onChangeText={setPeerInput}
            autoCapitalize="none"
          />
          <Pressable style={styles.contactButton} onPress={() => openPeer()}>
            <Text style={styles.contactButtonText}>Ouvrir</Text>
          </Pressable>
        </View>
        <FlatList
          data={chatList}
          keyExtractor={item => item.peer}
          renderItem={({item}) => (
            <Pressable style={styles.chatRow} onPress={() => openPeer(item.peer)}>
              <View style={styles.chatAvatar}>
                <Text style={styles.chatAvatarText}>{item.peer.slice(0, 2).toUpperCase()}</Text>
              </View>
              <View style={styles.chatRowBody}>
                <Text style={styles.chatRowPeer}>{item.peer}</Text>
                <Text style={styles.chatRowPreview} numberOfLines={1}>
                  {item.lastMessage.fromMe ? 'Moi : ' : ''}
                  {item.lastMessage.text}
                </Text>
              </View>
            </Pressable>
          )}
          ListEmptyComponent={<Text style={styles.emptyText}>Aucune conversation pour l'instant.</Text>}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>Associer Telegram</Text>
      </View>
      <View style={styles.setupCard}>
        {step === 'setup' || step === 'pending' || step === 'error' ? (
          <>
            <Text style={styles.label}>API ID (my.telegram.org)</Text>
            <TextInput style={styles.input} value={apiId} onChangeText={setApiId} keyboardType="number-pad" placeholder="ex: 1234567" placeholderTextColor={COLORS.textSecondary} />
            <Text style={styles.label}>API Hash</Text>
            <TextInput style={styles.input} value={apiHash} onChangeText={setApiHash} autoCapitalize="none" placeholder="ex: a1b2c3d4..." placeholderTextColor={COLORS.textSecondary} />
            <Text style={styles.label}>Numero de telephone (avec indicatif, ex: +22664977093)</Text>
            <TextInput style={styles.input} value={phoneNumber} onChangeText={setPhoneNumber} keyboardType="phone-pad" placeholder="+225..." placeholderTextColor={COLORS.textSecondary} />
            <Pressable style={styles.primaryButton} onPress={startLogin} disabled={submitting}>
              <Text style={styles.primaryButtonText}>{submitting ? '...' : 'Connecter'}</Text>
            </Pressable>
          </>
        ) : step === 'code_required' ? (
          <>
            <Text style={styles.label}>Code recu par SMS/Telegram</Text>
            <TextInput style={styles.input} value={code} onChangeText={setCode} keyboardType="number-pad" placeholder="12345" placeholderTextColor={COLORS.textSecondary} />
            <Pressable style={styles.primaryButton} onPress={submitCode} disabled={submitting}>
              <Text style={styles.primaryButtonText}>{submitting ? '...' : 'Valider le code'}</Text>
            </Pressable>
          </>
        ) : step === 'password_required' ? (
          <>
            <Text style={styles.label}>Mot de passe (verification en 2 etapes)</Text>
            <TextInput style={styles.input} value={password} onChangeText={setPassword} secureTextEntry placeholder="Mot de passe" placeholderTextColor={COLORS.textSecondary} />
            <Pressable style={styles.primaryButton} onPress={submitPassword} disabled={submitting}>
              <Text style={styles.primaryButtonText}>{submitting ? '...' : 'Valider'}</Text>
            </Pressable>
          </>
        ) : null}
        {loginError && <Text style={styles.errorText}>Erreur : {loginError}</Text>}
      </View>
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
  backArrow: {color: COLORS.cyan, fontSize: 18, fontWeight: '700', marginRight: 2},
  statusText: {color: COLORS.cyan, fontSize: 13, fontWeight: '600'},
  setupCard: {margin: 16, padding: 16, backgroundColor: COLORS.card, borderRadius: 14, borderWidth: 1, borderColor: COLORS.cardBorder},
  label: {color: COLORS.textSecondary, fontSize: 12, marginBottom: 6, marginTop: 10},
  input: {
    backgroundColor: COLORS.bg,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: COLORS.textPrimary,
    fontSize: 13,
  },
  primaryButton: {backgroundColor: COLORS.cyan, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 16},
  primaryButtonText: {color: '#04141A', fontWeight: '700', fontSize: 14},
  errorText: {color: COLORS.red, fontSize: 12, marginTop: 10},
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
  contactButton: {backgroundColor: COLORS.cyanDim, borderWidth: 1, borderColor: COLORS.cyan, borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center'},
  contactButtonText: {color: COLORS.cyan, fontWeight: '700', fontSize: 13},
  chatRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.cardBorder},
  chatAvatar: {width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.cyanDim, borderWidth: 1, borderColor: COLORS.cyan, alignItems: 'center', justifyContent: 'center'},
  chatAvatarText: {color: COLORS.cyan, fontWeight: '700', fontSize: 13},
  chatRowBody: {flex: 1},
  chatRowPeer: {color: COLORS.textPrimary, fontSize: 14, fontWeight: '600'},
  chatRowPreview: {color: COLORS.textSecondary, fontSize: 12, marginTop: 2},
  emptyText: {color: COLORS.textSecondary, fontSize: 12, fontStyle: 'italic', textAlign: 'center', marginTop: 20, padding: 20},
  chatArea: {flex: 1},
  thread: {flex: 1},
  threadContent: {padding: 10, flexGrow: 1, justifyContent: 'flex-end'},
  bubbleRow: {flexDirection: 'row', marginVertical: 3},
  bubbleRowMine: {justifyContent: 'flex-end'},
  bubbleRowOther: {justifyContent: 'flex-start'},
  bubble: {maxWidth: '80%', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8},
  bubbleMine: {backgroundColor: COLORS.bubbleMine, borderBottomRightRadius: 4},
  bubbleOther: {backgroundColor: COLORS.bubbleOther, borderBottomLeftRadius: 4},
  bubbleText: {color: COLORS.textPrimary, fontSize: 14},
  composeRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, backgroundColor: COLORS.card, borderTopWidth: 1, borderTopColor: COLORS.cardBorder},
  composeInput: {flex: 1, backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.cardBorder, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, color: COLORS.textPrimary, fontSize: 14, maxHeight: 100},
  sendButton: {backgroundColor: COLORS.cyan, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10},
  sendButtonText: {color: '#04141A', fontWeight: '700', fontSize: 13},
});

export default TelegramEngine;
