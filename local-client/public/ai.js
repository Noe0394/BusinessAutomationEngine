// Studio IA (texte/image) + génération d'ebook — parité avec le Mode VPS
// (public/dashboard.html) : les routes serveur /api/ai/text, /api/ai/image
// et /api/ebook/generate existaient déjà (index.js), jamais exposées ici.
// Pas de clé de licence à saisir côté client (contrairement au Mode
// Local Vercel abandonné) : ce process est déjà bloqué au démarrage sur une
// licence valide (voir index.js#main -> verifyLicense()).

async function iaGenerateText() {
  const prompt = document.getElementById('iaPrompt').value.trim();
  const errorEl = document.getElementById('iaError');
  const resultEl = document.getElementById('iaResult');
  errorEl.textContent = '';
  if (!prompt) return;
  try {
    const res = await fetch('/api/ai/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    resultEl.innerHTML = '<div style="color:var(--green); font-size:11px; font-weight:700; margin-bottom:6px;">' + escapeHtml(data.provider) + '</div><div>' + escapeHtml(data.text) + '</div>';
  } catch (e) {
    errorEl.textContent = 'Erreur : ' + e.message;
  }
}

async function iaGenerateImage() {
  const prompt = document.getElementById('iaPrompt').value.trim();
  const errorEl = document.getElementById('iaError');
  const resultEl = document.getElementById('iaResult');
  errorEl.textContent = '';
  if (!prompt) return;
  try {
    const res = await fetch('/api/ai/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    resultEl.innerHTML = '<div style="color:var(--green); font-size:11px; font-weight:700; margin-bottom:6px;">' + escapeHtml(data.provider) + '</div><img style="width:100%; border-radius:8px; margin-top:6px;" src="' + data.url + '" alt="Image générée">';
  } catch (e) {
    errorEl.textContent = 'Erreur : ' + e.message;
  }
}

// Réponse PDF binaire (pas de JSON) : téléchargement navigateur direct via
// un <a download> jetable, même mécanique que CyrusStore.exportRows côté
// webapp-core (adapters/browser.js) — un vrai onglet peut déclencher un
// téléchargement, pas de restriction ici.
async function ebookGenerate() {
  const title = document.getElementById('ebookTitle').value.trim();
  const subtitle = document.getElementById('ebookSubtitle').value.trim();
  const author = document.getElementById('ebookAuthor').value.trim();
  const date = document.getElementById('ebookDate').value.trim();
  const watermarkText = document.getElementById('ebookWatermark').value.trim();
  const introduction = document.getElementById('ebookIntro').value.trim();
  const conclusion = document.getElementById('ebookConclusion').value.trim();
  const topics = document.getElementById('ebookTopics').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const errorEl = document.getElementById('ebookError');
  const resultEl = document.getElementById('ebookResult');
  errorEl.textContent = '';
  resultEl.textContent = '';
  if (topics.length === 0) {
    errorEl.textContent = 'Indique au moins un sujet de chapitre.';
    return;
  }
  const coverFile = document.getElementById('ebookCoverFile').files[0];
  const logoFile = document.getElementById('ebookLogoFile').files[0];
  const coverImageBase64 = coverFile ? await readFileAsBase64(coverFile) : undefined;
  const logoImageBase64 = logoFile ? await readFileAsBase64(logoFile) : undefined;

  resultEl.textContent = 'Rédaction en cours (' + topics.length + ' chapitre(s), séquentiel)...';
  try {
    const res = await fetch('/api/ebook/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, subtitle, author, date, watermarkText, introduction, conclusion,
        chapterTopics: topics, coverImageBase64, logoImageBase64,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ('HTTP ' + res.status));
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (title || 'livre').replace(/[^a-z0-9]+/gi, '_').slice(0, 80) + '.pdf';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
    resultEl.textContent = '✅ PDF téléchargé.';
  } catch (e) {
    resultEl.textContent = '';
    errorEl.textContent = 'Erreur : ' + e.message;
  }
}
