(function () {
  const $ = id => document.getElementById(id);
  const fileInput = $('mobile-voice-file');
  const button = $('mobile-voice-transcribe');
  if (!fileInput || !button) return;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    $('mobile-voice-transcript').value = '';
    $('mobile-voice-use').disabled = true;
    $('mobile-voice-feedback').textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} Mo` : 'Choisis un fichier audio local.';
  });
  button.addEventListener('click', async () => {
    const file = fileInput.files[0];
    const transcript = $('mobile-voice-transcript');
    const status = $('mobile-voice-feedback');
    if (!file) { status.textContent = 'Choisis une note vocale ou un fichier audio.'; return; }
    if (file.size > 10 * 1024 * 1024) { status.textContent = 'Le fichier dépasse la limite de 10 Mo.'; return; }
    if (file.type && !file.type.toLowerCase().startsWith('audio/')) { status.textContent = 'Choisis un fichier audio pris en charge.'; return; }
    if (!window.Cyrus?.ai?.transcribeAudio) { status.textContent = 'Transcription Cloudflare indisponible.'; return; }
    transcript.value = '';
    button.disabled = true; $('mobile-voice-use').disabled = true; status.textContent = 'Transcription en cours…';
    try {
      const result = await window.Cyrus.ai.transcribeAudio(file);
      let text = String(result.text || '').trim();
      const language = String(result.language || '').toLowerCase();
      if (text && language && !language.startsWith('fr') && language !== 'french') {
        status.textContent = 'Transcription reçue · traduction vers le français…';
        try {
          const translated = await window.Cyrus.ai.generateText('Traduis fidèlement en français le texte transcrit ci-dessous. Préserve les noms, nombres, consignes et le ton. Réponds uniquement avec la traduction, sans commentaire.\n\n' + text.slice(0, 8000));
          text = String(translated.text || text).trim();
        } catch (_) { status.textContent = 'Traduction indisponible; la transcription originale sera conservée.'; }
      }
      transcript.value = text;
      $('mobile-voice-use').disabled = !text;
      status.textContent = `Transcrit${result.language ? ' · langue ' + result.language : ''} · ${result.provider || 'Cloudflare'}. Vérifie le texte avant de l’utiliser.`;
    } catch (error) { status.textContent = 'Transcription impossible : ' + String(error.message || error).slice(0, 240); }
    finally { button.disabled = false; }
  });
  $('mobile-voice-use').addEventListener('click', () => {
    const text = $('mobile-voice-transcript').value.trim();
    if (!text) return;
    $('goalchat-input').value = text;
    document.querySelector('[data-screen="intelligence"]')?.click();
    $('mobile-voice-feedback').textContent = 'Texte placé dans Chat Intelligent. Vérifie-le puis envoie-le manuellement.';
  });
})();
