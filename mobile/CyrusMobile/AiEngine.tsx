/**
 * Generation de contenu IA (texte + image) via les passerelles Firebase deja
 * deployees et testees (firebase-functions/index.js : generateTextFallback,
 * generateImageFallback) - memes endpoints que local-client/lib/aiGateway.js
 * cote PC, appeles ici directement en HTTP (fetch) depuis React Native, pas
 * besoin du runtime Node embarque pour ça. Protege par cle de licence +
 * deviceId (verifyLicenseOffline lie l'appareil a la cle au premier essai,
 * meme mecanisme que le reste du projet) - persistes cote Node embarque
 * (voir config.js) pour survivre aux redemarrages de l'app.
 *
 * Video (startVideoFallback/pollVideoFallback) et generation d'ebook
 * volontairement pas incluses dans cette premiere passe (job asynchrone
 * pour la video, dependance pdfkit plus lourde pour l'ebook) - a ajouter
 * ensuite si besoin.
 *
 * @format
 */

import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
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
  green: '#34D399',
  red: '#F87171',
  textPrimary: '#F1F5F9',
  textSecondary: '#7C8A9C',
};

const FIREBASE_BASE = 'https://us-central1-rien-afrique.cloudfunctions.net';

function AiEngine(): React.JSX.Element {
  const [deviceId, setDeviceId] = useState('');
  const [licenseKey, setLicenseKey] = useState('');
  const [licenseInput, setLicenseInput] = useState('');
  const [licenseStatus, setLicenseStatus] = useState<'checking' | 'valid' | 'invalid' | 'unset'>('unset');
  const [licenseError, setLicenseError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [textResult, setTextResult] = useState<string | null>(null);
  const [textProvider, setTextProvider] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [imageProvider, setImageProvider] = useState<string | null>(null);
  const [busy, setBusy] = useState<'text' | 'image' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onConfig = (payload: {deviceId: string; licenseKey: string}) => {
      setDeviceId(payload.deviceId);
      setLicenseKey(payload.licenseKey);
      if (!payload.licenseKey) setLicenseStatus('unset');
    };
    nodejs.channel.addListener('config', onConfig);
    nodejs.channel.post('get-config', {});
    return () => nodejs.channel.removeListener('config', onConfig);
  }, []);

  const verifyLicense = useCallback(async (key: string) => {
    if (!key || !deviceId) return;
    setLicenseStatus('checking');
    setLicenseError(null);
    try {
      const res = await fetch(`${FIREBASE_BASE}/verifyLicenseOffline`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({key, deviceId}),
      });
      const data = await res.json();
      if (data.valid) {
        setLicenseStatus('valid');
        nodejs.channel.post('set-license-key', {licenseKey: key});
      } else {
        setLicenseStatus('invalid');
        setLicenseError(data.reason || 'Cle invalide.');
      }
    } catch (e) {
      setLicenseStatus('invalid');
      setLicenseError(String(e));
    }
  }, [deviceId]);

  useEffect(() => {
    if (licenseKey && deviceId) verifyLicense(licenseKey);
  }, [licenseKey, deviceId, verifyLicense]);

  const saveLicense = useCallback(() => {
    if (!licenseInput.trim()) return;
    setLicenseKey(licenseInput.trim());
    setLicenseInput('');
  }, [licenseInput]);

  const headers = useCallback(
    () => ({'Content-Type': 'application/json', 'x-license-key': licenseKey, 'x-device-id': deviceId}),
    [licenseKey, deviceId],
  );

  const generateText = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy('text');
    setError(null);
    setTextResult(null);
    try {
      const res = await fetch(`${FIREBASE_BASE}/generateTextFallback`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({prompt: prompt.trim()}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setTextResult(data.text);
      setTextProvider(data.provider);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [prompt, busy, headers]);

  const generateImage = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy('image');
    setError(null);
    setImageUrl(null);
    try {
      const res = await fetch(`${FIREBASE_BASE}/generateImageFallback`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({prompt: prompt.trim()}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setImageUrl(data.url);
      setImageProvider(data.provider);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [prompt, busy, headers]);

  if (licenseStatus !== 'valid') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.statusBar}>
          <Text style={styles.statusText}>Generation IA</Text>
        </View>
        <View style={styles.setupCard}>
          <Text style={styles.label}>Cle de licence</Text>
          <TextInput
            style={styles.input}
            value={licenseInput}
            onChangeText={setLicenseInput}
            autoCapitalize="characters"
            placeholder="Ex: CYRUS-XXXX-XXXX"
            placeholderTextColor={COLORS.textSecondary}
          />
          <Pressable style={styles.primaryButton} onPress={saveLicense}>
            <Text style={styles.primaryButtonText}>
              {licenseStatus === 'checking' ? 'Verification...' : 'Valider'}
            </Text>
          </Pressable>
          {licenseStatus === 'invalid' && (
            <Text style={styles.errorText}>Erreur : {licenseError}</Text>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>Generation IA - licence active</Text>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text style={styles.label}>Prompt</Text>
        <TextInput
          style={[styles.input, styles.promptInput]}
          value={prompt}
          onChangeText={setPrompt}
          multiline
          placeholder="Decris ce que tu veux generer..."
          placeholderTextColor={COLORS.textSecondary}
        />
        <View style={styles.buttonRow}>
          <Pressable style={styles.primaryButton} onPress={generateText} disabled={!!busy}>
            {busy === 'text' ? <ActivityIndicator color="#04141A" /> : <Text style={styles.primaryButtonText}>Texte</Text>}
          </Pressable>
          <Pressable style={styles.primaryButton} onPress={generateImage} disabled={!!busy}>
            {busy === 'image' ? <ActivityIndicator color="#04141A" /> : <Text style={styles.primaryButtonText}>Image</Text>}
          </Pressable>
        </View>
        {error && <Text style={styles.errorText}>Erreur : {error}</Text>}
        {textResult && (
          <View style={styles.resultCard}>
            <Text style={styles.resultProvider}>{textProvider}</Text>
            <Text style={styles.resultText}>{textResult}</Text>
          </View>
        )}
        {imageUrl && (
          <View style={styles.resultCard}>
            <Text style={styles.resultProvider}>{imageProvider}</Text>
            <Image source={{uri: imageUrl}} style={styles.resultImage} resizeMode="contain" />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: COLORS.bg},
  statusBar: {padding: 10, backgroundColor: COLORS.card, borderBottomWidth: 1, borderBottomColor: COLORS.cardBorder},
  statusText: {color: COLORS.cyan, fontSize: 13, fontWeight: '600'},
  setupCard: {margin: 16, padding: 16, backgroundColor: COLORS.card, borderRadius: 14, borderWidth: 1, borderColor: COLORS.cardBorder},
  scroll: {flex: 1},
  scrollContent: {padding: 16},
  label: {color: COLORS.textSecondary, fontSize: 12, marginBottom: 6},
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
  promptInput: {minHeight: 80, textAlignVertical: 'top'},
  buttonRow: {flexDirection: 'row', gap: 10, marginTop: 12},
  primaryButton: {flex: 1, backgroundColor: COLORS.cyan, borderRadius: 10, paddingVertical: 12, alignItems: 'center'},
  primaryButtonText: {color: '#04141A', fontWeight: '700', fontSize: 14},
  errorText: {color: COLORS.red, fontSize: 12, marginTop: 10},
  resultCard: {marginTop: 16, padding: 12, backgroundColor: COLORS.card, borderRadius: 12, borderWidth: 1, borderColor: COLORS.cardBorder},
  resultProvider: {color: COLORS.green, fontSize: 11, fontWeight: '700', marginBottom: 6},
  resultText: {color: COLORS.textPrimary, fontSize: 14, lineHeight: 20},
  resultImage: {width: '100%', height: 300, borderRadius: 8, marginTop: 4},
});

export default AiEngine;
