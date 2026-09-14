// CYRUS Predictive Media Engine — port fidèle de public/dashboard.html
// (#studio-media-view + le bloc JS "CYRUS Predictive Media Engine") vers le
// Mode Local (PC). Presque tout le pipeline est déjà 100% client (fond
// généré, composition Canvas 2D, export vidéo Ken Burns) — seul le fond IA
// passe par un appel réseau, adapté ici pour réutiliser /api/ai/image (déjà
// branché sur lib/aiGateway.js, même cascade fal.ai->Pollinations que le VPS)
// plutôt que POST /api/media/generate-image (route VPS absente ici) ou un
// appel direct à un fournisseur depuis ce fichier (la clé fal.ai doit rester
// côté serveur, jamais exposée au client).
//
// ÉCART ASSUMÉ ET DOCUMENTÉ (pas un oubli) : la génération vidéo IA serveur
// (LTX-Video/fal.ai/Replicate, voir mediaGenerateAiVideo côté VPS) et le
// storyboard multi-scènes (mediaGenerateStoryboard) NE SONT PAS portés ici.
// Les deux dépendent d'un hébergement de lien public (/v/:id, nécessaire
// pour l'aperçu Open Graph WhatsApp/Telegram) que ce serveur Express local
// (accessible uniquement sur cette machine, jamais exposé publiquement) ne
// peut structurellement pas fournir — même contrainte que Facebook/YouTube/
// TikTok déjà exclus du Mode Local. L'export vidéo Ken Burns 100% client
// (mediaGenerateVideo, MediaRecorder) reste lui pleinement porté ci-dessous,
// aucune dépendance serveur.
(function () {
  'use strict';

  const MEDIA_FORMATS = {
    '9:16': { width: 1080, height: 1920 },
    '1:1': { width: 1080, height: 1080 },
    '16:9': { width: 1920, height: 1080 },
    '4:5': { width: 1080, height: 1350 },
  };

  const MEDIA_FORMAT_KEYWORDS = [
    { ratio: '9:16', keywords: ['story', 'stories', 'tiktok', 'reel', 'reels', 'statut whatsapp', 'whatsapp status', 'format vertical'] },
    { ratio: '1:1', keywords: ['post instagram', 'post facebook', 'carousel', 'carrousel', 'publication facebook', 'publication instagram', 'format carré', 'format carre'] },
    { ratio: '16:9', keywords: ['bannière', 'banniere', 'youtube', 'écran paysage', 'ecran paysage', 'format paysage', 'miniature'] },
    { ratio: '4:5', keywords: ['portrait feed', 'feed instagram', 'feed facebook', 'format portrait'] },
  ];
  const MEDIA_DELIVERABLE_KEYWORDS = [
    { deliverable: 'VIDEO_SHORT', keywords: ['vidéo', 'video', 'short', 'reel', 'clip', 'voix off', 'narration', 'sous-titre'] },
    { deliverable: 'FLYER_AFFICHE', keywords: ['affiche', 'flyer', 'promo', 'promotion', 'prix', 'badge', "call to action", "appel à l'action", 'publicité'] },
    { deliverable: 'IMAGE_PHOTO', keywords: ['photo pure', 'image pure', 'visuel réaliste', 'illustration'] },
  ];

  function mediaIntentParse(text) {
    const t = String(text || '').toLowerCase();
    const formatMatch = MEDIA_FORMAT_KEYWORDS.find((entry) => entry.keywords.some((kw) => t.includes(kw)));
    const deliverableMatch = MEDIA_DELIVERABLE_KEYWORDS.find((entry) => entry.keywords.some((kw) => t.includes(kw)));
    return {
      ratio: formatMatch ? formatMatch.ratio : null,
      deliverable: deliverableMatch ? deliverableMatch.deliverable : 'FLYER_AFFICHE',
    };
  }

  const mediaState = { ratio: null, deliverable: null };
  let mediaCurrentCreation = null;
  let mediaVariantSeq = 0;
  let mediaCreativeDirection = null;

  function mediaFeedback(message, isError) {
    const el = document.getElementById('media-feedback');
    el.textContent = message;
    el.style.display = 'block';
    el.style.color = isError ? '#c0392b' : '#1a7a3c';
  }

  function mediaCreativeDirectorFeedback(message, isError) {
    const el = document.getElementById('media-creative-director-feedback');
    el.textContent = message;
    el.style.display = 'block';
    el.style.color = isError ? '#c0392b' : '#1a7a3c';
  }

  // Route locale nouvelle (voir index.js#POST /api/media/creative-direction)
  // — même prompt structuré JSON que le VPS (POST /api/media/creative-direction,
  // index.js racine), réutilise aiGateway.generateText en interne au lieu de
  // dupliquer une cascade LLM ici.
  async function mediaFetchCreativeDirection() {
    const concept = document.getElementById('media-concept').value.trim();
    if (!concept) { mediaCreativeDirectorFeedback('Décrivez le visuel avant de demander une direction créative IA.', true); return; }

    const btn = document.getElementById('media-creative-director-btn');
    btn.disabled = true;
    mediaCreativeDirectorFeedback("🧠 Analyse de la demande par l'IA en cours...", false);

    try {
      const res = await fetch('/api/media/creative-direction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ concept }),
      });
      const data = await res.json();
      if (!res.ok) {
        mediaCreativeDirectorFeedback(data.error || 'Direction créative IA indisponible pour le moment — renseignez les champs manuellement ci-dessous.', true);
        return;
      }
      const { directive, provider } = data;
      mediaCreativeDirection = Object.assign({}, directive, { forConcept: concept });

      if (directive.detectedSector) document.getElementById('media-sector').value = directive.detectedSector;
      if (directive.marketingHook) document.getElementById('media-title').value = directive.marketingHook;
      if (directive.videoScript) document.getElementById('media-script').value = directive.videoScript;

      const suggestedRatio = (directive.suggestedFormats || [])[0];
      if (suggestedRatio && !mediaState.ratio) {
        const b = document.querySelector('#media-ratio-toggle .toggle-btn[data-ratio="' + suggestedRatio + '"]');
        if (b) b.click();
      }

      mediaCreativeDirectorFeedback('✅ Direction créative générée (' + provider + ') — champs pré-remplis, modifiez-les librement avant de générer.', false);
    } catch (err) {
      mediaCreativeDirectorFeedback('Direction créative IA indisponible pour le moment — renseignez les champs manuellement ci-dessous.', true);
    } finally {
      btn.disabled = false;
    }
  }

  document.getElementById('media-creative-director-btn').addEventListener('click', mediaFetchCreativeDirection);

  document.getElementById('media-ratio-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn[data-ratio]');
    if (!btn) return;
    document.querySelectorAll('#media-ratio-toggle .toggle-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    mediaState.ratio = btn.dataset.ratio;
  });

  document.getElementById('media-deliverable-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn[data-deliverable]');
    if (!btn) return;
    document.querySelectorAll('#media-deliverable-toggle .toggle-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    mediaState.deliverable = btn.dataset.deliverable;
    document.getElementById('media-flyer-fields').style.display = btn.dataset.deliverable === 'FLYER_AFFICHE' ? 'block' : 'none';
    document.getElementById('media-video-fields').style.display = btn.dataset.deliverable === 'VIDEO_SHORT' ? 'block' : 'none';
    document.getElementById('media-export-video-btn').style.display = btn.dataset.deliverable === 'VIDEO_SHORT' ? 'inline-block' : 'none';
  });

  document.getElementById('media-concept').addEventListener('change', () => {
    const { ratio, deliverable } = mediaIntentParse(document.getElementById('media-concept').value);
    if (ratio && !mediaState.ratio) {
      const b = document.querySelector('#media-ratio-toggle .toggle-btn[data-ratio="' + ratio + '"]');
      if (b) b.click();
    }
    if (deliverable && !mediaState.deliverable) {
      const b = document.querySelector('#media-deliverable-toggle .toggle-btn[data-deliverable="' + deliverable + '"]');
      if (b) b.click();
    }
  });

  // Glossaire FR->EN "best effort" (identique au VPS, non exhaustif par
  // conception — voir le commentaire équivalent dans dashboard.html).
  const MEDIA_FR_EN_GLOSSARY = {
    'poulet grillé': 'grilled chicken', 'poulet braisé': 'braised chicken', 'poulet frit': 'fried chicken',
    'poisson grillé': 'grilled fish', 'viande grillée': 'grilled meat', 'brochettes de bœuf': 'beef skewers',
    'riz au gras': 'jollof rice', 'attiéké poisson': 'attiéké with fish', 'plat traditionnel': 'traditional dish',
    'jus de fruits frais': 'fresh fruit juice', 'pâtisserie maison': 'homemade pastry', 'gâteau anniversaire': 'birthday cake',
    'plateau de fruits': 'fruit platter', 'salade fraîche': 'fresh salad', 'burger maison': 'homemade burger',
    'pizza artisanale': 'artisanal pizza', 'café glacé': 'iced coffee', 'smoothie fruits': 'fruit smoothie',
    'poulet': 'chicken', 'poisson': 'fish', 'viande': 'meat', 'grillé': 'grilled', 'braisé': 'braised',
    'frit': 'fried', 'brochette': 'skewer', 'riz': 'rice', 'sauce': 'sauce', 'épicé': 'spicy',
    'gâteau': 'cake', 'pâtisserie': 'pastry', 'boisson': 'drink', 'jus': 'juice', 'fruits': 'fruits',
    'salade': 'salad', 'burger': 'burger', 'pizza': 'pizza', 'café': 'coffee', 'plat': 'dish',
    'restaurant': 'restaurant', 'cuisine': 'cuisine',
    'appartement': 'apartment', 'maison': 'house', 'villa': 'villa', 'terrain': 'land plot',
    'immeuble': 'building', 'bureau': 'office', 'chambre': 'bedroom', 'salon': 'living room',
    'chaussures': 'shoes', 'vêtements': 'clothes', 'robe': 'dress', 'sac à main': 'handbag', 'sac': 'bag',
    'montre': 'watch', 'bijoux': 'jewelry', 'parfum': 'perfume', 'cosmétiques': 'cosmetics',
    'téléphone': 'smartphone', 'ordinateur': 'laptop', 'écouteurs': 'earbuds', 'voiture': 'car', 'moto': 'motorcycle',
    'promotion': 'promotion', 'nouveau': 'new', 'nouvelle collection': 'new collection', 'soldes': 'sale',
    'livraison gratuite': 'free delivery', 'qualité premium': 'premium quality', 'fait main': 'handmade',
  };
  const MEDIA_FR_EN_GLOSSARY_ENTRIES = Object.entries(MEDIA_FR_EN_GLOSSARY).sort((a, b) => b[0].length - a[0].length);

  function mediaTranslateConceptToEnglish(text) {
    let result = String(text || '');
    MEDIA_FR_EN_GLOSSARY_ENTRIES.forEach(([fr, en]) => {
      const escaped = fr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])', 'giu');
      result = result.replace(re, en);
    });
    return result;
  }

  const MEDIA_QUALITY_SUFFIX = 'professional commercial product photography, 8k resolution, studio lighting, hyper-detailed, advertising poster style, crisp focus, clean composition, high-end graphic design, professional color grading, no blur, no distortion, no low quality, no abstract, no minimal detail, no deformed proportions, no noise, no draft look, no watermark, no text errors';

  const MEDIA_SECTOR_STYLES = {
    restauration: 'professional studio food photography, appetizing crispy details, mouth-watering close-up, warm ambient restaurant lighting, rich textures, food magazine quality',
    immobilier: 'architectural real estate photography, wide angle lens, natural daylight, clean modern interior or exterior',
    ecommerce: 'clean studio product photography, softbox lighting, neutral background, sharp product focus',
    hightech: 'sleek modern tech product photography, cool blue accent lighting, minimalist futuristic background',
    formation: 'professional educational setting, confident presenter, clean modern classroom or office environment',
  };

  const MEDIA_VARIANT_STYLES = [
    { label: 'Studio épuré', prompt: 'clean commercial studio lighting, minimal composition, centered subject' },
    { label: 'Lifestyle chaleureux', prompt: 'warm lifestyle candid photography, natural light, authentic atmosphere' },
    { label: 'Cinématique dramatique', prompt: 'bold dramatic cinematic lighting, high contrast, dynamic angle' },
  ];

  function mediaBuildEnrichedPrompt(conceptRaw, deliverable, sector, extraNote) {
    const hasFreshDirection = mediaCreativeDirection
      && mediaCreativeDirection.forConcept === conceptRaw.trim()
      && mediaCreativeDirection.imagePromptEnglish;
    const base = hasFreshDirection
      ? mediaCreativeDirection.imagePromptEnglish
      : (mediaTranslateConceptToEnglish(conceptRaw.trim()) || 'professional studio photography of a modern product, photorealistic');
    const stylesByDeliverable = {
      IMAGE_PHOTO: 'professional studio photography, photorealistic, natural lighting, high detail',
      FLYER_AFFICHE: 'photorealistic marketing background, cinematic lighting, shallow depth of field, high detail, professional advertising photography, clean negative space for text overlay',
      VIDEO_SHORT: 'photorealistic, dynamic cinematic lighting, high detail, professional advertising photography, clean negative space for text overlay',
    };
    const parts = [base, stylesByDeliverable[deliverable] || stylesByDeliverable.FLYER_AFFICHE];
    if (sector && MEDIA_SECTOR_STYLES[sector]) parts.push(MEDIA_SECTOR_STYLES[sector]);
    if (extraNote) parts.push(mediaTranslateConceptToEnglish(extraNote));
    parts.push(MEDIA_QUALITY_SUFFIX);
    return parts.join(', ');
  }

  function mediaSleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  const MEDIA_RATE_LIMIT_MS = 15500;
  const MEDIA_FETCH_TIMEOUT_MS = 25000;

  function mediaLoadImageUrl(url, onSettle) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      img.onload = null; img.onerror = null; img.src = '';
      const err = new Error('Le service de génération met trop de temps à répondre — réessayez dans quelques secondes.');
      err.kind = 'timeout';
      onSettle(err, null);
    }, MEDIA_FETCH_TIMEOUT_MS);
    img.onload = () => { if (settled) return; settled = true; clearTimeout(timer); onSettle(null, img); };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = new Error('Échec de génération du fond IA (service indisponible ou requête trop rapide — réessayez dans quelques secondes).');
      err.kind = 'error';
      onSettle(err, null);
    };
    img.src = url;
  }

  // Repli gratuit direct (aucune clé) — identique au VPS, appel client-side
  // classique vers l'API publique Pollinations, inchangé.
  function mediaFetchViaPollinations(cleanPrompt, w, h) {
    return new Promise((resolve, reject) => {
      const seed = Math.floor(Math.random() * 1000000);
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(cleanPrompt) + '?width=' + w + '&height=' + h + '&nologo=true&seed=' + seed + '&enhance=true&safe=true';
      mediaLoadImageUrl(url, (err, img) => { if (err) reject(err); else resolve(img); });
    });
  }

  // Source principale : /api/ai/image (lib/aiGateway.js — cascade Firebase/
  // VPS fal.ai->Pollinations déjà gérée serveur), au lieu de
  // POST /api/media/generate-image (route VPS absente ici). Repli
  // Pollinations direct conservé en cas d'échec réseau du serveur local
  // lui-même (process arrêté entre-temps, etc.) — cas limite, jamais
  // rencontré en usage normal puisque la page vient de ce même serveur.
  function mediaFetchBackgroundImageOnce(promptEnriched, w, h) {
    return new Promise((resolve, reject) => {
      const cleanPrompt = (promptEnriched && promptEnriched.trim()) || 'professional product banner HD, photorealistic, studio lighting';
      fetch('/api/ai/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: cleanPrompt, width: w, height: h }),
      })
        .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
        .then(({ ok, data }) => {
          if (!ok || !data.url) {
            mediaFetchViaPollinations(cleanPrompt, w, h).then(resolve, reject);
            return;
          }
          mediaLoadImageUrl(data.url, (err, img) => {
            if (!err) return resolve(img);
            mediaFetchViaPollinations(cleanPrompt, w, h).then(resolve, reject);
          });
        })
        .catch(() => { mediaFetchViaPollinations(cleanPrompt, w, h).then(resolve, reject); });
    });
  }

  async function mediaFetchBackgroundImage(promptEnriched, w, h) {
    const backoffsMs = [1500, 3000];
    let lastErr;
    for (let attempt = 0; attempt <= backoffsMs.length; attempt += 1) {
      try {
        return await mediaFetchBackgroundImageOnce(promptEnriched, w, h);
      } catch (err) {
        lastErr = err;
        if (err.kind !== 'error' || attempt === backoffsMs.length) break;
        await mediaSleep(backoffsMs[attempt]);
      }
    }
    throw lastErr;
  }

  const MEDIA_FALLBACK_PALETTES = [
    ['#6c4fd6', '#ff6b9d'], ['#075E54', '#25D366'], ['#0f2027', '#2c5364'],
    ['#ff9966', '#ff5e62'], ['#1e3c72', '#2a5298'], ['#e65c00', '#f9d423'],
  ];

  function mediaGenerateLocalPlaceholder(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const [c1, c2] = MEDIA_FALLBACK_PALETTES[Math.floor(Math.random() * MEDIA_FALLBACK_PALETTES.length)];
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, c1); grad.addColorStop(1, c2);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i += 1) {
      const bx = Math.random() * w, by = Math.random() * h, radius = w * (0.25 + Math.random() * 0.25);
      const blobGrad = ctx.createRadialGradient(bx, by, 0, bx, by, radius);
      blobGrad.addColorStop(0, 'rgba(255,255,255,0.16)'); blobGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = blobGrad; ctx.beginPath(); ctx.arc(bx, by, radius, 0, Math.PI * 2); ctx.fill();
    }
    return canvas;
  }

  async function mediaFetchBackgroundWithFallback(promptEnriched, w, h) {
    try {
      const img = await mediaFetchBackgroundImage(promptEnriched, w, h);
      return { img, usedFallback: false };
    } catch (err) {
      return { img: mediaGenerateLocalPlaceholder(w, h), usedFallback: true };
    }
  }

  function mediaDrawCoverImage(ctx, img, w, h) {
    const imgRatio = img.width / img.height, canvasRatio = w / h;
    let sx, sy, sw, sh;
    if (imgRatio > canvasRatio) { sh = img.height; sw = sh * canvasRatio; sx = (img.width - sw) / 2; sy = 0; }
    else { sw = img.width; sh = sw / canvasRatio; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  }

  function mediaDrawGradientOverlay(ctx, w, h) {
    const grad = ctx.createLinearGradient(0, h * 0.35, 0, h);
    grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = grad; ctx.fillRect(0, h * 0.35, w, h * 0.65);
  }

  function mediaWrapText(ctx, text, x, maxWidth, lineHeight, startY, align) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = []; let line = '';
    words.forEach((word) => {
      const test = line ? line + ' ' + word : word;
      if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = word; } else { line = test; }
    });
    if (line) lines.push(line);
    let y = startY;
    ctx.textAlign = align || 'center';
    lines.forEach((l) => { ctx.fillText(l, x, y); y += lineHeight; });
    return y;
  }

  function mediaDrawBadge(ctx, text, w, h) {
    if (!text) return;
    ctx.save();
    ctx.font = 'bold ' + Math.round(w * 0.032) + 'px Arial, sans-serif';
    const paddingX = w * 0.025, label = text.toUpperCase();
    const boxW = ctx.measureText(label).width + paddingX * 2, boxH = w * 0.06;
    const x = w - boxW - w * 0.04, y = h * 0.04;
    ctx.fillStyle = '#e63946';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, boxW, boxH, boxH / 2); else ctx.rect(x, y, boxW, boxH);
    ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x + boxW / 2, y + boxH / 2 + 1);
    ctx.restore();
  }

  function mediaGetFlyerFields() {
    return {
      title: document.getElementById('media-title').value.trim(),
      subtitle: document.getElementById('media-subtitle').value.trim(),
      price: document.getElementById('media-price').value.trim(),
      badge: document.getElementById('media-badge').value.trim(),
      cta: document.getElementById('media-cta').value.trim(),
    };
  }

  function mediaCountWrappedLines(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    let lines = 1, line = '';
    words.forEach((word) => {
      const test = line ? line + ' ' + word : word;
      if (line && ctx.measureText(test).width > maxWidth) { lines += 1; line = word; } else { line = test; }
    });
    return lines;
  }

  function mediaFitFontSize(ctx, text, maxWidth, maxLines, weight, baseSizePx, minSizePx) {
    let size = baseSizePx;
    while (size > minSizePx) {
      ctx.font = weight + ' ' + Math.round(size) + 'px Arial, sans-serif';
      if (mediaCountWrappedLines(ctx, text, maxWidth) <= maxLines) break;
      size -= 2;
    }
    return size;
  }

  function mediaDrawFlyerLayers(ctx, w, h, fields) {
    mediaDrawGradientOverlay(ctx, w, h);
    mediaDrawBadge(ctx, fields.badge, w, h);
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = w * 0.01;
    ctx.textBaseline = 'alphabetic';
    const ctaSafeTop = h * 0.86;
    let cursorY = h * 0.72;
    if (fields.title) {
      const maxTitleWidth = w * 0.88;
      const fittedSize = mediaFitFontSize(ctx, fields.title, maxTitleWidth, 3, 900, w * 0.075, w * 0.03);
      ctx.font = '900 ' + Math.round(fittedSize) + 'px Arial, sans-serif';
      const lineHeight = fittedSize * 1.15;
      cursorY = mediaWrapText(ctx, fields.title, w / 2, maxTitleWidth, lineHeight, cursorY, 'center');
      cursorY = Math.min(cursorY, ctaSafeTop);
    }
    if (fields.subtitle && cursorY < ctaSafeTop - h * 0.03) {
      ctx.font = '600 ' + Math.round(w * 0.036) + 'px Arial, sans-serif';
      cursorY = Math.min(mediaWrapText(ctx, fields.subtitle, w / 2, w * 0.86, w * 0.05, cursorY + h * 0.015, 'center'), ctaSafeTop);
    }
    if (fields.price && cursorY < ctaSafeTop - h * 0.02) {
      ctx.font = '900 ' + Math.round(w * 0.05) + 'px Arial, sans-serif';
      ctx.fillStyle = '#ffd166';
      mediaWrapText(ctx, fields.price, w / 2, w * 0.86, w * 0.06, cursorY + h * 0.02, 'center');
      ctx.fillStyle = '#fff';
    }
    if (fields.cta) {
      ctx.font = 'bold ' + Math.round(w * 0.03) + 'px Arial, sans-serif';
      mediaWrapText(ctx, fields.cta, w / 2, w * 0.82, w * 0.042, h * 0.955, 'center');
    }
    ctx.restore();
  }

  function mediaCreateVariantCanvas(img, width, height, deliverable) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    mediaDrawCoverImage(ctx, img, width, height);
    if (deliverable === 'FLYER_AFFICHE') mediaDrawFlyerLayers(ctx, width, height, mediaGetFlyerFields());
    return canvas;
  }

  function mediaDownloadCanvasPng(canvas, filename) {
    canvas.toBlob((blob) => {
      if (!blob) { mediaFeedback("Échec de l'export PNG.", true); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }

  function mediaBuildVariantCard(result, index) {
    const card = document.createElement('div');
    card.className = 'media-card';

    const label = document.createElement('div');
    label.className = 'media-card-label';
    label.textContent = 'Proposition ' + (index + 1) + ' — ' + result.label + (result.usedFallback ? ' (fond local de secours)' : '');
    card.appendChild(label);

    if (result.usedFallback) {
      const badge = document.createElement('div');
      badge.className = 'fallback-badge';
      badge.textContent = '⚠️ Génération IA indisponible pour cette proposition — visuel de secours local affiché. Réessayez dans quelques secondes.';
      card.appendChild(badge);
    }

    const frame = document.createElement('div');
    card.appendChild(frame);

    const actions = document.createElement('div');
    actions.className = 'media-card-actions';
    card.appendChild(actions);

    if (!result.ok) {
      frame.innerHTML = '<p style="padding:1rem;color:#c0392b;">Échec de cette proposition.</p>';
      return card;
    }

    const canvas = mediaCreateVariantCanvas(result.img, result.width, result.height, result.deliverable);
    frame.appendChild(canvas);

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.textContent = '🟢 Sélectionner';
    selectBtn.addEventListener('click', () => mediaSelectVariant(result));
    actions.appendChild(selectBtn);

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.textContent = '📥 Télécharger HD';
    downloadBtn.addEventListener('click', () => mediaDownloadCanvasPng(canvas, 'cyrus-visuel-' + Date.now() + '-v' + (index + 1) + '.png'));
    actions.appendChild(downloadBtn);

    return card;
  }

  async function mediaGenerateVariants() {
    const concept = document.getElementById('media-concept').value.trim();
    if (!concept) { mediaFeedback('Décrivez le visuel souhaité avant de générer.', true); return; }
    if (!mediaState.ratio) { mediaFeedback('Choisissez un format (📱 🔲 🖥️ 📸) avant de générer.', true); return; }

    const deliverable = mediaState.deliverable || 'FLYER_AFFICHE';
    const sector = document.getElementById('media-sector').value;
    const { width, height } = MEDIA_FORMATS[mediaState.ratio];

    const btn = document.getElementById('media-generate-btn');
    btn.disabled = true;
    document.getElementById('media-preview-wrap').style.display = 'none';
    const grid = document.getElementById('media-variants-grid');
    grid.style.display = 'none';
    grid.innerHTML = '';
    mediaFeedback('🎨 Génération de ' + MEDIA_VARIANT_STYLES.length + ' propositions en cours (peut prendre 1 à 2 minutes)...', false);

    const generation = ++mediaVariantSeq;
    const results = [];
    for (let i = 0; i < MEDIA_VARIANT_STYLES.length; i += 1) {
      if (generation !== mediaVariantSeq) return;
      if (i > 0) {
        mediaFeedback('🎨 ' + i + '/' + MEDIA_VARIANT_STYLES.length + ' — pause anti-limite (' + Math.round(MEDIA_RATE_LIMIT_MS / 1000) + 's) avant la proposition suivante...', false);
        await mediaSleep(MEDIA_RATE_LIMIT_MS);
        if (generation !== mediaVariantSeq) return;
      }
      const variantStyle = MEDIA_VARIANT_STYLES[i];
      try {
        const promptEnriched = mediaBuildEnrichedPrompt(concept, deliverable, sector, variantStyle.prompt);
        const { img, usedFallback } = await mediaFetchBackgroundWithFallback(promptEnriched, width, height);
        results.push({ ok: true, img, usedFallback, promptEnriched, label: variantStyle.label, width, height, deliverable, ratio: mediaState.ratio });
      } catch (err) {
        results.push({ ok: false, label: variantStyle.label });
      }
      if (generation !== mediaVariantSeq) return;
      mediaFeedback('🎨 ' + (i + 1) + '/' + MEDIA_VARIANT_STYLES.length + ' proposition(s) générée(s)...', false);
    }

    if (generation !== mediaVariantSeq) return;

    grid.style.display = 'grid';
    results.forEach((result, idx) => grid.appendChild(mediaBuildVariantCard(result, idx)));

    const successCount = results.filter((r) => r.ok).length;
    btn.disabled = false;
    mediaFeedback(successCount === 0
      ? 'Échec de génération des propositions (service indisponible — réessayez).'
      : '✅ ' + successCount + '/' + results.length + " proposition(s) prête(s) — sélectionnez-en une.", successCount === 0);
  }

  function mediaUpdateFallbackWarning() {
    document.getElementById('media-current-fallback-warning').style.display = (mediaCurrentCreation && mediaCurrentCreation.usedFallback) ? 'block' : 'none';
  }

  function mediaSelectVariant(result) {
    mediaCurrentCreation = {
      img: result.img, promptEnriched: result.promptEnriched,
      width: result.width, height: result.height, ratio: result.ratio, deliverable: result.deliverable,
      usedFallback: Boolean(result.usedFallback),
    };
    const canvas = document.getElementById('media-canvas');
    canvas.width = result.width; canvas.height = result.height;
    const ctx = canvas.getContext('2d');
    mediaDrawCoverImage(ctx, result.img, result.width, result.height);
    if (result.deliverable === 'FLYER_AFFICHE') mediaDrawFlyerLayers(ctx, result.width, result.height, mediaGetFlyerFields());
    document.getElementById('media-variants-grid').style.display = 'none';
    document.getElementById('media-preview-wrap').style.display = 'block';
    document.getElementById('media-style-note').value = '';
    mediaUpdateFallbackWarning();
    mediaFeedback('✅ Création sélectionnée — modifiez-la ci-dessous si besoin.', false);
  }

  function mediaApplyTextEdits() {
    if (!mediaCurrentCreation) { mediaFeedback('Sélectionnez ou générez une création avant de la modifier.', true); return; }
    const canvas = document.getElementById('media-canvas');
    const ctx = canvas.getContext('2d');
    mediaDrawCoverImage(ctx, mediaCurrentCreation.img, mediaCurrentCreation.width, mediaCurrentCreation.height);
    if (mediaCurrentCreation.deliverable === 'FLYER_AFFICHE') mediaDrawFlyerLayers(ctx, mediaCurrentCreation.width, mediaCurrentCreation.height, mediaGetFlyerFields());
    mediaFeedback('✅ Texte mis à jour.', false);
  }

  async function mediaRegenerateBackgroundWithNote() {
    if (!mediaCurrentCreation) { mediaFeedback('Sélectionnez ou générez une création avant de la modifier.', true); return; }
    const note = document.getElementById('media-style-note').value.trim();
    if (!note) { mediaFeedback('Décrivez le changement de style/ambiance souhaité.', true); return; }

    const concept = document.getElementById('media-concept').value.trim();
    const sector = document.getElementById('media-sector').value;
    const btn = document.getElementById('media-regen-bg-btn');
    btn.disabled = true;
    mediaFeedback('🎨 Régénération du fond en cours...', false);

    try {
      const promptEnriched = mediaBuildEnrichedPrompt(concept, mediaCurrentCreation.deliverable, sector, note);
      const { img, usedFallback } = await mediaFetchBackgroundWithFallback(promptEnriched, mediaCurrentCreation.width, mediaCurrentCreation.height);
      mediaCurrentCreation.img = img;
      mediaCurrentCreation.promptEnriched = promptEnriched;
      mediaCurrentCreation.usedFallback = usedFallback;
      const canvas = document.getElementById('media-canvas');
      const ctx = canvas.getContext('2d');
      mediaDrawCoverImage(ctx, img, mediaCurrentCreation.width, mediaCurrentCreation.height);
      if (mediaCurrentCreation.deliverable === 'FLYER_AFFICHE') mediaDrawFlyerLayers(ctx, mediaCurrentCreation.width, mediaCurrentCreation.height, mediaGetFlyerFields());
      mediaUpdateFallbackWarning();
      mediaFeedback(usedFallback
        ? "⚠️ Service IA indisponible — fond de secours local appliqué (le changement de style demandé n'a pas pu être pris en compte, réessayez dans quelques instants)."
        : '✅ Fond régénéré avec le changement demandé.', usedFallback);
    } catch (err) {
      mediaFeedback(err.message || 'Erreur lors de la régénération.', true);
    } finally {
      btn.disabled = false;
    }
  }

  async function mediaDeclineAllFormats() {
    if (!mediaCurrentCreation) { mediaFeedback('Sélectionnez ou générez une création avant de la décliner.', true); return; }
    const concept = document.getElementById('media-concept').value.trim();
    const sector = document.getElementById('media-sector').value;
    const btn = document.getElementById('media-decline-formats-btn');
    const grid = document.getElementById('media-declinations-grid');
    const otherRatios = Object.keys(MEDIA_FORMATS).filter((r) => r !== mediaCurrentCreation.ratio);

    btn.disabled = true;
    grid.style.display = 'none';
    grid.innerHTML = '';
    mediaFeedback('🎞️ Déclinaison en cours (' + otherRatios.length + ' format(s) restant(s), peut prendre 1 à 2 minutes)...', false);

    const results = [];
    for (let i = 0; i < otherRatios.length; i += 1) {
      if (i > 0) {
        mediaFeedback('🎞️ ' + i + '/' + otherRatios.length + ' — pause anti-limite avant le format suivant...', false);
        await mediaSleep(MEDIA_RATE_LIMIT_MS);
      }
      const ratio = otherRatios[i];
      const { width, height } = MEDIA_FORMATS[ratio];
      try {
        const promptEnriched = mediaCurrentCreation.promptEnriched || mediaBuildEnrichedPrompt(concept, mediaCurrentCreation.deliverable, sector, null);
        const { img, usedFallback } = await mediaFetchBackgroundWithFallback(promptEnriched, width, height);
        results.push({ ok: true, ratio, usedFallback, canvas: mediaCreateVariantCanvas(img, width, height, mediaCurrentCreation.deliverable) });
      } catch (err) {
        results.push({ ok: false, ratio });
      }
      mediaFeedback('🎞️ ' + (i + 1) + '/' + otherRatios.length + ' format(s) décliné(s)...', false);
    }

    grid.style.display = 'grid';
    results.forEach(({ ok, ratio, canvas, usedFallback }) => {
      const card = document.createElement('div');
      card.className = 'media-card';
      const label = document.createElement('div');
      label.className = 'media-card-label';
      label.textContent = ratio + (usedFallback ? ' (fond local de secours)' : '');
      card.appendChild(label);
      const frame = document.createElement('div');
      card.appendChild(frame);
      if (!ok) {
        frame.innerHTML = '<p style="padding:1rem;color:#c0392b;">Échec pour ce format.</p>';
        grid.appendChild(card);
        return;
      }
      frame.appendChild(canvas);
      const actions = document.createElement('div');
      actions.className = 'media-card-actions';
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button';
      dlBtn.textContent = '📥 Télécharger HD';
      dlBtn.addEventListener('click', () => mediaDownloadCanvasPng(canvas, 'cyrus-visuel-' + ratio.replace(':', 'x') + '-' + Date.now() + '.png'));
      actions.appendChild(dlBtn);
      card.appendChild(actions);
      grid.appendChild(card);
    });

    const successCount = results.filter((r) => r.ok).length;
    btn.disabled = false;
    mediaFeedback(successCount > 0
      ? '✅ ' + successCount + '/' + otherRatios.length + ' format(s) décliné(s) — le format actuel (' + mediaCurrentCreation.ratio + ') reste dans l\'aperçu ci-dessus.'
      : 'Échec de la déclinaison (service indisponible — réessayez).', successCount === 0);
  }

  document.getElementById('media-generate-btn').addEventListener('click', mediaGenerateVariants);
  document.getElementById('media-back-to-variants-btn').addEventListener('click', mediaGenerateVariants);
  document.getElementById('media-apply-text-btn').addEventListener('click', mediaApplyTextEdits);
  document.getElementById('media-regen-bg-btn').addEventListener('click', mediaRegenerateBackgroundWithNote);
  document.getElementById('media-decline-formats-btn').addEventListener('click', mediaDeclineAllFormats);
  document.getElementById('media-download-png-btn').addEventListener('click', () => {
    mediaDownloadCanvasPng(document.getElementById('media-canvas'), 'cyrus-visuel-' + Date.now() + '.png');
  });

  // ---------- Studio Vidéo : Ken Burns + sous-titres mot-à-mot + export
  // (100% client, MediaRecorder — identique au VPS, aucune adaptation
  // nécessaire : ce serveur local sert la page à un vrai onglet de
  // navigateur système, pas une WebView restreinte). ----------
  function mediaSplitScript(text) { return String(text || '').trim().split(/\s+/).filter(Boolean); }

  function mediaDrawKenBurnsFrame(ctx, img, w, h, progress) {
    const zoom = 1 + 0.18 * progress;
    const imgRatio = img.width / img.height, canvasRatio = w / h;
    let baseSw, baseSh;
    if (imgRatio > canvasRatio) { baseSh = img.height; baseSw = baseSh * canvasRatio; } else { baseSw = img.width; baseSh = baseSw / canvasRatio; }
    const sw = baseSw / zoom, sh = baseSh / zoom;
    const centerX = img.width / 2 + Math.sin(progress * Math.PI) * img.width * 0.03;
    const centerY = img.height / 2;
    const sx = Math.min(Math.max(centerX - sw / 2, 0), img.width - sw);
    const sy = Math.min(Math.max(centerY - sh / 2, 0), img.height - sh);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  }

  function mediaDrawSubtitleWord(ctx, word, w, h, scale) {
    if (!word) return;
    ctx.save();
    ctx.translate(w / 2, h * 0.82);
    ctx.scale(scale || 1, scale || 1);
    ctx.font = '900 ' + Math.round(w * 0.09) + 'px Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = w * 0.012; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.fillStyle = '#ffd166';
    ctx.strokeText(word.toUpperCase(), 0, 0);
    ctx.fillText(word.toUpperCase(), 0, 0);
    ctx.restore();
  }

  function mediaPickRecorderFormat() {
    const candidates = [
      { mime: 'video/webm;codecs=vp9', ext: 'webm' },
      { mime: 'video/webm;codecs=vp8', ext: 'webm' },
      { mime: 'video/webm', ext: 'webm' },
      { mime: 'video/mp4', ext: 'mp4' },
    ];
    return candidates.find((c) => window.MediaRecorder && MediaRecorder.isTypeSupported(c.mime)) || null;
  }

  let mediaLastVideoUrl = null;
  let mediaLastVideoFilename = '';

  async function mediaGenerateVideo() {
    if (!mediaCurrentCreation) { mediaFeedback("Sélectionnez d'abord une création (voir les propositions) avant d'exporter la vidéo.", true); return; }
    if (mediaCurrentCreation.usedFallback) {
      mediaFeedback("⚠️ Cette création utilise le fond de secours local (pas une image générée) — régénérez le fond ci-dessus avant d'exporter la vidéo.", true);
      return;
    }
    if (!window.MediaRecorder) { mediaFeedback("Votre navigateur ne supporte pas l'enregistrement vidéo (MediaRecorder).", true); return; }
    const picked = mediaPickRecorderFormat();
    if (!picked) { mediaFeedback('Aucun format vidéo supporté par ce navigateur.', true); return; }

    const scriptText = document.getElementById('media-script').value.trim() || document.getElementById('media-concept').value.trim();
    const words = mediaSplitScript(scriptText);
    if (!words.length) { mediaFeedback('Renseignez un script (ou une description) à sous-titrer.', true); return; }

    const durationSec = parseInt(document.getElementById('media-video-duration').value, 10) || 15;
    const voiceRate = parseFloat(document.getElementById('media-voice-rate').value) || 1;
    const { width, height, img: backgroundImg } = mediaCurrentCreation;
    const canvas = document.getElementById('media-canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');

    const exportBtn = document.getElementById('media-export-video-btn');
    exportBtn.disabled = true;
    mediaFeedback('🎬 Enregistrement en cours — la narration est audible en direct (aperçu), le fichier exporté sera silencieux.', false);

    let currentWordIndex = -1;
    let boundarySupported = false;
    if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
      try {
        const utterance = new SpeechSynthesisUtterance(scriptText);
        utterance.lang = 'fr-FR';
        utterance.rate = voiceRate;
        utterance.onboundary = (ev) => {
          boundarySupported = true;
          const spoken = scriptText.slice(0, ev.charIndex).trim();
          currentWordIndex = spoken ? spoken.split(/\s+/).length : 0;
        };
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } catch (err) { /* synthèse vocale indisponible : l'export continue sans narration live */ }
    }

    mediaDrawKenBurnsFrame(ctx, backgroundImg, width, height, 0);
    mediaDrawGradientOverlay(ctx, width, height);
    mediaDrawSubtitleWord(ctx, words[0], width, height, 1);

    const stream = canvas.captureStream(60);
    const recorder = new MediaRecorder(stream, { mimeType: picked.mime });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const recordedPromise = new Promise((resolve) => { recorder.onstop = () => resolve(new Blob(chunks, { type: picked.mime })); });
    recorder.start();

    const durationMs = durationSec * 1000;
    const msPerWordFallback = durationMs / words.length;
    const startTime = performance.now();
    let lastWordIndex = -1;
    let wordChangedAt = startTime;
    const POP_MS = 160;

    await new Promise((resolve) => {
      function frame(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / durationMs, 1);
        mediaDrawKenBurnsFrame(ctx, backgroundImg, width, height, progress);
        mediaDrawGradientOverlay(ctx, width, height);
        const idx = boundarySupported ? currentWordIndex : Math.floor(elapsed / msPerWordFallback);
        const clampedIdx = Math.min(Math.max(idx, 0), words.length - 1);
        if (clampedIdx !== lastWordIndex) { lastWordIndex = clampedIdx; wordChangedAt = now; }
        const popProgress = Math.min((now - wordChangedAt) / POP_MS, 1);
        const scale = 1.3 - 0.3 * popProgress;
        mediaDrawSubtitleWord(ctx, words[clampedIdx], width, height, scale);
        if (elapsed < durationMs) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });

    recorder.stop();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const blob = await recordedPromise;

    if (mediaLastVideoUrl) URL.revokeObjectURL(mediaLastVideoUrl);
    const url = URL.createObjectURL(blob);
    mediaLastVideoUrl = url;
    mediaLastVideoFilename = 'cyrus-video-' + Date.now() + '.' + picked.ext;

    const videoEl = document.getElementById('media-video-preview');
    videoEl.src = url;
    document.getElementById('media-video-preview-wrap').style.display = 'block';

    exportBtn.disabled = false;
    mediaFeedback('✅ Vidéo exportée (.' + picked.ext + ', silencieuse — sous-titres incrustés). Vérifiez l\'aperçu ci-dessous avant de télécharger.', false);
  }

  document.getElementById('media-video-download-btn').addEventListener('click', () => {
    if (!mediaLastVideoUrl) return;
    const a = document.createElement('a');
    a.href = mediaLastVideoUrl;
    a.download = mediaLastVideoFilename || ('cyrus-video-' + Date.now() + '.webm');
    document.body.appendChild(a); a.click(); a.remove();
  });

  document.getElementById('media-export-video-btn').addEventListener('click', mediaGenerateVideo);
})();
