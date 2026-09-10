/**
 * Cyrus Mobile — spike Baileys embarque (nodejs-mobile-react-native).
 * Pairing par code + envoi/reception de texte seul. Pas de medias, pas de
 * groupes, pas de campagnes a ce stade — voir mobile/README.md.
 *
 * Identite visuelle alignee sur le logo CYRUS SUPER ASSISTANT (fourni par
 * l'utilisateur le 2026-09-10) : fond charbon profond, accents cyan/metal,
 * cartes arrondies a bordure lumineuse — demande explicite : interface
 * "tres belle et tres addictive", pas juste fonctionnelle.
 *
 * @format
 */

import React, {useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Pressable,
  SafeAreaView,
  StatusBar,
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

type ChatMessage = {from: string; text: string; mine: boolean};

// Pastille de statut avec pulsation en boucle quand "active" — signal
// vivant/organique plutot qu'un simple point statique (demande explicite :
// interface animee, "addictive").
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
          style={[
            styles.statusDotGlow,
            {backgroundColor: COLORS.green, transform: [{scale}], opacity},
          ]}
        />
      )}
      <View
        style={[
          styles.statusDot,
          {backgroundColor: active ? COLORS.green : COLORS.textSecondary},
        ]}
      />
    </View>
  );
}

// Bouton avec retour tactile "premium" (leger enfoncement au press, ressort
// au relachement) plutot que le simple fondu d'opacite de TouchableOpacity —
// remplace tous les boutons de l'ecran.
function PressableScale({
  onPress,
  disabled,
  style,
  children,
}: {
  onPress: () => void;
  disabled?: boolean;
  style: object | object[];
  children: React.ReactNode;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const pressIn = () =>
    Animated.spring(scale, {toValue: 0.96, useNativeDriver: true, speed: 40, bounciness: 0}).start();
  const pressOut = () =>
    Animated.spring(scale, {toValue: 1, useNativeDriver: true, speed: 20, bounciness: 8}).start();

  return (
    <Pressable onPress={onPress} onPressIn={pressIn} onPressOut={pressOut} disabled={disabled}>
      <Animated.View style={[style, disabled && styles.buttonDisabled, {transform: [{scale}]}]}>
        {children}
      </Animated.View>
    </Pressable>
  );
}

// Apparition en "recompense" du code de pairing (fondu + leger zoom depuis
// 0.85x) — rejoue a chaque nouveau code puisque ce composant est remonte a
// chaque fois (voir {pairingCode && <RevealBox>...} plus bas).
function RevealBox({children}: {children: React.ReactNode}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(anim, {toValue: 1, useNativeDriver: true, speed: 14, bounciness: 10}).start();
  }, [anim]);

  const scale = anim.interpolate({inputRange: [0, 1], outputRange: [0.85, 1]});

  return (
    <Animated.View style={[styles.pairingBox, {opacity: anim, transform: [{scale}]}]}>
      {children}
    </Animated.View>
  );
}

function App(): React.JSX.Element {
  const [nodeReady, setNodeReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [sendTo, setSendTo] = useState('');
  const [sendText, setSendText] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // nodejs.start() ne doit etre appele qu'une fois
    started.current = true;

    nodejs.start('main.js');

    nodejs.channel.addListener('node-ready', () => setNodeReady(true));

    nodejs.channel.addListener('pairing-code', (payload: {code?: string; error?: string}) => {
      setRequesting(false);
      if (payload.code) {
        setPairingCode(payload.code);
        setPairingError(null);
      } else {
        setPairingError(payload.error ?? 'Erreur inconnue.');
      }
    });

    nodejs.channel.addListener('status', (payload: {connected: boolean; loggedOut?: boolean}) => {
      setConnected(payload.connected);
      if (payload.connected) {
        setPairingCode(null);
        setPairingError(null);
      }
    });
  }, []);

  useEffect(() => {
    const onIncomingMessage = (payload: {from: string; text: string}) => {
      setMessages(prev => [...prev, {from: payload.from, text: payload.text, mine: false}]);
    };
    const onSendResult = (payload: {ok: boolean; to: string; error?: string}) => {
      if (!payload.ok) {
        setMessages(prev => [
          ...prev,
          {from: 'systeme', text: `Echec envoi a ${payload.to} : ${payload.error}`, mine: false},
        ]);
      }
    };
    nodejs.channel.addListener('message', onIncomingMessage);
    nodejs.channel.addListener('send-result', onSendResult);
    return () => {
      nodejs.channel.removeListener('message', onIncomingMessage);
      nodejs.channel.removeListener('send-result', onSendResult);
    };
  }, []);

  const requestCode = () => {
    setPairingError(null);
    setPairingCode(null);
    setRequesting(true);
    nodejs.channel.post('request-pairing-code', {phoneNumber});
  };

  const sendMessage = () => {
    if (!sendTo || !sendText) return;
    const to = sendTo.includes('@') ? sendTo : `${sendTo}@s.whatsapp.net`;
    nodejs.channel.post('send', {to, text: sendText});
    setMessages(prev => [...prev, {from: 'moi', text: sendText, mine: true}]);
    setSendText('');
  };

  const canRequestCode = nodeReady && phoneNumber.length > 0 && !requesting;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.bg} />

      <View style={styles.header}>
        <Text style={styles.brand}>
          CYRUS <Text style={styles.brandAccent}>SUPER ASSISTANT</Text>
        </Text>
        <View style={styles.statusRow}>
          <View style={styles.statusPill}>
            <PulseDot active={nodeReady} />
            <Text style={styles.statusPillText}>Moteur {nodeReady ? 'prêt' : 'démarrage…'}</Text>
          </View>
          <View style={styles.statusPill}>
            <PulseDot active={connected} />
            <Text style={styles.statusPillText}>
              WhatsApp {connected ? 'connecté' : 'non connecté'}
            </Text>
          </View>
        </View>
      </View>

      {!connected && (
        <View style={styles.section}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Associer WhatsApp</Text>
            <Text style={styles.label}>Numéro de téléphone (format international, sans le +)</Text>
            <TextInput
              style={styles.input}
              keyboardType="phone-pad"
              placeholder="ex: 2250700000000"
              placeholderTextColor={COLORS.textSecondary}
              value={phoneNumber}
              onChangeText={setPhoneNumber}
            />
            <PressableScale style={styles.primaryButton} onPress={requestCode} disabled={!canRequestCode}>
              {requesting ? (
                <ActivityIndicator color={COLORS.bg} />
              ) : (
                <Text style={styles.primaryButtonText}>Obtenir le code d'association</Text>
              )}
            </PressableScale>

            {pairingCode && (
              <RevealBox>
                <Text style={styles.pairingLabel}>VOTRE CODE</Text>
                <Text style={styles.pairingCode}>{pairingCode}</Text>
                <Text style={styles.pairingHint}>
                  Dans WhatsApp : Appareils liés → Lier un appareil → Lier avec le numéro de
                  téléphone.
                </Text>
              </RevealBox>
            )}
            {pairingError && (
              <View style={styles.errorBox}>
                <Text style={styles.error}>{pairingError}</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {connected && (
        <View style={styles.section}>
          <FlatList
            style={styles.messageList}
            contentContainerStyle={styles.messageListContent}
            data={messages}
            keyExtractor={(_, i) => String(i)}
            renderItem={({item}) => (
              <View
                style={[
                  styles.bubble,
                  item.mine ? styles.bubbleMine : styles.bubbleOther,
                ]}>
                {!item.mine && <Text style={styles.bubbleFrom}>{item.from}</Text>}
                <Text style={styles.bubbleText}>{item.text}</Text>
              </View>
            )}
          />
          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              keyboardType="phone-pad"
              placeholder="Destinataire (numéro)"
              placeholderTextColor={COLORS.textSecondary}
              value={sendTo}
              onChangeText={setSendTo}
            />
            <View style={styles.composerRow}>
              <TextInput
                style={[styles.composerInput, styles.composerMessageInput]}
                placeholder="Écrire un message…"
                placeholderTextColor={COLORS.textSecondary}
                value={sendText}
                onChangeText={setSendText}
              />
              <PressableScale
                style={styles.sendButton}
                onPress={sendMessage}
                disabled={!sendTo || !sendText}>
                <Text style={styles.sendButtonText}>➤</Text>
              </PressableScale>
            </View>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: COLORS.bg},
  header: {paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16},
  brand: {fontSize: 22, fontWeight: '800', color: COLORS.textPrimary, letterSpacing: 0.5},
  brandAccent: {color: COLORS.cyan, fontWeight: '800'},
  statusRow: {flexDirection: 'row', marginTop: 10, gap: 8},
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  statusDotWrap: {width: 7, height: 7, marginRight: 6, alignItems: 'center', justifyContent: 'center'},
  statusDotGlow: {position: 'absolute', width: 7, height: 7, borderRadius: 4},
  statusDot: {width: 7, height: 7, borderRadius: 4},
  statusPillText: {fontSize: 11, color: COLORS.textSecondary, fontWeight: '600'},

  section: {flex: 1, paddingHorizontal: 20},

  card: {
    backgroundColor: COLORS.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    padding: 18,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textPrimary,
    marginBottom: 16,
  },
  label: {fontSize: 12, color: COLORS.textSecondary, marginBottom: 6, fontWeight: '600'},
  input: {
    backgroundColor: '#0D141D',
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 10,
    padding: 12,
    color: COLORS.textPrimary,
    fontSize: 15,
    marginBottom: 16,
  },
  primaryButton: {
    backgroundColor: COLORS.cyan,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: {opacity: 0.4},
  primaryButtonText: {color: '#04222A', fontWeight: '800', fontSize: 14, letterSpacing: 0.3},

  pairingBox: {
    marginTop: 20,
    backgroundColor: COLORS.cyanDim,
    borderWidth: 1,
    borderColor: COLORS.cyan,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  pairingLabel: {fontSize: 11, color: COLORS.cyan, fontWeight: '700', letterSpacing: 1.5},
  pairingCode: {
    fontSize: 32,
    fontWeight: '800',
    color: COLORS.textPrimary,
    letterSpacing: 4,
    marginVertical: 8,
  },
  pairingHint: {fontSize: 12, color: COLORS.textSecondary, textAlign: 'center', lineHeight: 18},

  errorBox: {
    marginTop: 16,
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
    borderWidth: 1,
    borderColor: COLORS.red,
    borderRadius: 10,
    padding: 12,
  },
  error: {color: COLORS.red, fontSize: 13},

  messageList: {flex: 1},
  messageListContent: {paddingVertical: 12, gap: 6},
  bubble: {maxWidth: '80%', borderRadius: 14, paddingVertical: 8, paddingHorizontal: 12},
  bubbleMine: {
    alignSelf: 'flex-end',
    backgroundColor: COLORS.bubbleMine,
    borderWidth: 1,
    borderColor: 'rgba(34, 211, 238, 0.35)',
  },
  bubbleOther: {alignSelf: 'flex-start', backgroundColor: COLORS.bubbleOther},
  bubbleFrom: {fontSize: 10, color: COLORS.textSecondary, marginBottom: 2, fontWeight: '700'},
  bubbleText: {color: COLORS.textPrimary, fontSize: 14, lineHeight: 19},

  composer: {paddingBottom: 12, paddingTop: 8},
  composerRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  composerInput: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.cardBorder,
    borderRadius: 10,
    padding: 10,
    color: COLORS.textPrimary,
    fontSize: 14,
    marginBottom: 8,
  },
  composerMessageInput: {flex: 1, marginBottom: 0},
  sendButton: {
    backgroundColor: COLORS.cyan,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonText: {color: '#04222A', fontSize: 16, fontWeight: '800'},
});

export default App;
