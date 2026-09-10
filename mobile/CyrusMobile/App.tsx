/**
 * Cyrus Mobile — spike Baileys embarque (nodejs-mobile-react-native).
 * Pairing par code + envoi/reception de texte seul. Pas de medias, pas de
 * groupes, pas de campagnes a ce stade — voir mobile/README.md.
 *
 * @format
 */

import React, {useEffect, useRef, useState} from 'react';
import {
  Button,
  FlatList,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import nodejs from 'nodejs-mobile-react-native';

type ChatMessage = {from: string; text: string; mine: boolean};

function App(): React.JSX.Element {
  const [nodeReady, setNodeReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
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
    nodejs.channel.post('request-pairing-code', {phoneNumber});
  };

  const sendMessage = () => {
    if (!sendTo || !sendText) return;
    const to = sendTo.includes('@') ? sendTo : `${sendTo}@s.whatsapp.net`;
    nodejs.channel.post('send', {to, text: sendText});
    setMessages(prev => [...prev, {from: 'moi', text: sendText, mine: true}]);
    setSendText('');
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <Text style={styles.title}>Cyrus Mobile — WhatsApp (spike)</Text>
      <Text style={styles.status}>
        Node : {nodeReady ? 'pret' : 'demarrage...'} · WhatsApp :{' '}
        {connected ? 'connecte' : 'non connecte'}
      </Text>

      {!connected && (
        <View style={styles.section}>
          <Text style={styles.label}>
            Numero de telephone (format international, sans le +)
          </Text>
          <TextInput
            style={styles.input}
            keyboardType="phone-pad"
            placeholder="ex: 2250700000000"
            value={phoneNumber}
            onChangeText={setPhoneNumber}
          />
          <Button title="Obtenir le code d'association" onPress={requestCode} disabled={!nodeReady || !phoneNumber} />
          {pairingCode && (
            <Text style={styles.pairingCode}>
              Code : {pairingCode}
              {'\n'}Dans WhatsApp : Appareils lies → Lier un appareil → Lier avec le numero de telephone.
            </Text>
          )}
          {pairingError && <Text style={styles.error}>{pairingError}</Text>}
        </View>
      )}

      {connected && (
        <View style={styles.section}>
          <FlatList
            style={styles.messageList}
            data={messages}
            keyExtractor={(_, i) => String(i)}
            renderItem={({item}) => (
              <Text style={item.mine ? styles.messageMine : styles.messageOther}>
                {item.mine ? 'Moi' : item.from} : {item.text}
              </Text>
            )}
          />
          <Text style={styles.label}>Destinataire (numero, sans le +)</Text>
          <TextInput style={styles.input} keyboardType="phone-pad" value={sendTo} onChangeText={setSendTo} />
          <Text style={styles.label}>Message</Text>
          <TextInput style={styles.input} value={sendText} onChangeText={setSendText} />
          <Button title="Envoyer" onPress={sendMessage} disabled={!sendTo || !sendText} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, padding: 16},
  title: {fontSize: 18, fontWeight: '700', marginBottom: 4},
  status: {fontSize: 13, color: '#555', marginBottom: 16},
  section: {flex: 1},
  label: {fontSize: 13, color: '#333', marginTop: 12, marginBottom: 4},
  input: {borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8},
  pairingCode: {marginTop: 16, fontSize: 16, fontWeight: '600', lineHeight: 22},
  error: {marginTop: 12, color: '#b00020'},
  messageList: {flex: 1, marginBottom: 8},
  messageMine: {textAlign: 'right', marginVertical: 2, color: '#075E54'},
  messageOther: {textAlign: 'left', marginVertical: 2, color: '#222'},
});

export default App;
