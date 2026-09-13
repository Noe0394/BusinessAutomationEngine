/**
 * TEST MINIMAL — hypothèse "WebView Android + injection JS directe" comme
 * alternative à Baileys (bloqué, voir CLAUDE.md). Objectif de CE fichier
 * uniquement : vérifier que web.whatsapp.com se charge correctement dans la
 * WebView native Android (User-Agent desktop) et affiche un vrai QR
 * scannable — rien d'autre. Si ça marche, l'étape suivante (extraction des
 * scripts injectés de whatsapp-web.js pour lire/envoyer des messages) vaut
 * la peine d'être tentée ; sinon, on arrête là sans avoir construit des
 * heures sur une hypothèse fausse.
 *
 * @format
 */

import React, {useState} from 'react';
import {SafeAreaView, StyleSheet, Text, View} from 'react-native';
import {WebView, WebViewMessageEvent} from 'react-native-webview';

// User-Agent desktop Chrome récent — WhatsApp Web sert une expérience
// différente (souvent un message "utilisez un navigateur pris en charge")
// aux User-Agents mobiles détectés, d'où ce spoof indispensable ici.
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Injecte un petit script qui signale juste si un canvas (le QR est rendu
// en <canvas> par WhatsApp Web) est present dans la page — confirmation
// minimale que la page a bien charge son JS et tente d'afficher le QR,
// sans encore rien extraire du contenu reel de WhatsApp.
const PROBE_SCRIPT = `
(function() {
  function checkForCanvas() {
    const canvas = document.querySelector('canvas');
    window.ReactNativeWebView.postMessage(JSON.stringify({
      hasCanvas: Boolean(canvas),
      title: document.title,
      bodyLength: document.body ? document.body.innerHTML.length : 0,
    }));
  }
  setTimeout(checkForCanvas, 3000);
  setTimeout(checkForCanvas, 8000);
})();
true;
`;

function WebViewTest(): React.JSX.Element {
  const [probeResult, setProbeResult] = useState<string>('En attente...');
  const [loadError, setLoadError] = useState<string | null>(null);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      setProbeResult(
        `canvas=${data.hasCanvas} · titre="${data.title}" · html=${data.bodyLength} caractères`,
      );
    } catch (err) {
      setProbeResult(`Erreur de parsing: ${event.nativeEvent.data}`);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.statusBar}>
        <Text style={styles.statusText}>TEST WEBVIEW — {probeResult}</Text>
        {loadError && <Text style={styles.errorText}>Erreur : {loadError}</Text>}
      </View>
      <WebView
        source={{uri: 'https://web.whatsapp.com'}}
        userAgent={DESKTOP_UA}
        javaScriptEnabled
        domStorageEnabled
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        injectedJavaScript={PROBE_SCRIPT}
        onMessage={onMessage}
        onError={(e) => setLoadError(e.nativeEvent.description)}
        onHttpError={(e) => setLoadError(`HTTP ${e.nativeEvent.statusCode}`)}
        style={styles.webview}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0A0E14'},
  statusBar: {padding: 10, backgroundColor: '#131A24'},
  statusText: {color: '#22D3EE', fontSize: 11, fontWeight: '600'},
  errorText: {color: '#F87171', fontSize: 11, marginTop: 4},
  webview: {flex: 1},
});

export default WebViewTest;
