// Relance Manuelle Express (port desktop de public/dashboard.html, voir
// mobile/webapp/www/relance.js pour l'équivalent Android). Contrairement au
// mobile, cette page tourne dans un VRAI onglet de navigateur (ouvert par
// local-client via `open()`) : window.open() ici est un vrai popup soumis au
// blocage navigateur standard (contrairement à la WebView Capacitor), donc la
// détection "opened === null" fonctionne exactement comme dans le dashboard
// d'origine.
//
// Source de la file : la campagne la plus récente du canal choisi (voir
// GET /api/campaigns, lib/campaigns.js côté serveur) - pas de mode "import
// direct sans campagne" ici (simplification assumée pour ce premier jet
// desktop : créer une campagne dans l'onglet Campagnes puis ne pas la
// démarrer sert le même besoin, la file Relance Manuelle lira ses
// destinataires encore pending).
(function () {
  const state = { channel: 'whatsapp', campaignId: null, items: [], cursor: 0, sessionStartAt: null, sentCount: 0 };

  function getVariantTexts() {
    return ['relVariantA', 'relVariantB', 'relVariantC']
      .map((id) => document.getElementById(id).value.trim())
      .filter(Boolean);
  }

  function getIntention() {
    return document.getElementById('relIntention').value.trim();
  }

  function feedback(message, isError) {
    const el = document.getElementById('relFeedback');
    el.textContent = message;
    el.style.color = isError ? '#991b1b' : '#166534';
  }

  // Fallback minimal quand ni intention ni variante A/B/C ne sont renseignées :
  // affiche le texte brut de la campagne avec un remplacement simple de
  // {nom}/{prenom}/{first_name} - pas le moteur Spintax complet (qui vit
  // côté serveur, lib/personalization.js, hors de portée de cette page sans
  // duplication) : ce cas volontairement dégradé encourage à utiliser "Mon
  // Intention" ou les variantes pour un rendu propre.
  function fallbackPersonalize(template, nom) {
    return String(template || '').replace(/\{(nom|prenom|first_name|name)\}/g, nom || '');
  }

  function whatsappJidToPhone(jid) {
    return String(jid || '').split('@')[0].replace(/\D/g, '');
  }

  function makeItem(result, campaignText, channel) {
    if (channel === 'telegram') {
      const isUsername = String(result.to || '').startsWith('@');
      return {
        to: result.to, nom: result.nom || '', status: result.status,
        isPhone: !isUsername, username: isUsername ? result.to.slice(1) : null, phone: isUsername ? null : result.to,
        message: campaignText,
      };
    }
    return {
      to: result.to, nom: result.nom || '', status: result.status,
      isPhone: true, phone: whatsappJidToPhone(result.to),
      message: campaignText,
    };
  }

  function computeMessage(item) {
    const variants = getVariantTexts();
    const intention = getIntention();
    if (variants.length) return variants[state.items.indexOf(item) % variants.length];
    if (intention) return window.Cyrus.smartTextGenerator.generateVariant(intention, 'private', item.nom);
    return fallbackPersonalize(item.message, item.nom);
  }

  window.relancePrerenderAll = function relancePrerenderAll() {
    state.items.forEach((item) => { item.renderedMessage = computeMessage(item); });
    renderCard();
  };

  window.relanceRefreshMessage = function relanceRefreshMessage() {
    const item = state.items[state.cursor];
    if (!item) return;
    item.renderedMessage = computeMessage(item);
    document.getElementById('relMessageText').value = item.renderedMessage;
  };

  function updateRhythm() {
    // Compteur minimal (pas de widget dédié sur cette page, contrairement au
    // mobile) - affiché dans le feedback quand la file est vide.
  }

  function renderCard() {
    const card = document.getElementById('relCard');
    const empty = document.getElementById('relEmpty');
    const items = state.items;
    const cursor = state.cursor;

    if (!items.length || cursor >= items.length) {
      card.style.display = 'none';
      empty.style.display = 'block';
      empty.innerHTML = '<small>' + (items.length
        ? ('Tous les contacts de la file ont été traités (' + items.length + '/' + items.length + ').')
        : 'Aucun contact en attente ou en échec à relancer pour le moment.') + '</small>';
      return;
    }

    empty.style.display = 'none';
    card.style.display = 'block';

    const item = items[cursor];
    document.getElementById('relCounter').textContent = cursor + ' / ' + items.length + ' traités — Contact ' + (cursor + 1) + '/' + items.length;
    document.getElementById('relBadge').textContent = item.status;

    const identifier = item.isPhone ? item.phone : ('@' + item.username);
    document.getElementById('relContactLabel').textContent = item.nom ? (item.nom + ' — ' + identifier) : identifier;

    if (typeof item.renderedMessage !== 'string') item.renderedMessage = computeMessage(item);
    document.getElementById('relMessageText').value = item.renderedMessage;

    const notice = document.getElementById('relPrefillNotice');
    if (state.channel === 'telegram') {
      notice.innerHTML = '<small style="color:#991b1b;">⚠️ Telegram ne pré-remplit pas le texte : il est copié dans le presse-papiers — collez-le une fois la conversation ouverte.</small>';
    } else {
      notice.innerHTML = '<small style="color:#166534;">✅ Le texte s\'affiche automatiquement dans le champ de saisie WhatsApp à l\'ouverture.</small>';
    }
  }

  function buildDeepLink(item, text) {
    const encodedText = encodeURIComponent(text || '');
    if (state.channel === 'telegram') {
      if (item.isPhone) return 'https://t.me/+' + item.phone;
      return 'https://t.me/' + item.username;
    }
    return 'https://wa.me/' + item.phone + '?text=' + encodedText;
  }

  window.relanceLoadQueue = async function relanceLoadQueue() {
    state.channel = document.getElementById('relChannel').value;
    feedback('', false);
    try {
      const res = await fetch('/api/legacy-campaigns');
      const campaigns = await res.json();
      const candidates = campaigns.filter((c) => (c.config.channel || 'whatsapp') === state.channel);
      const latest = candidates.reduce((best, c) => (!best || c.updatedAt > best.updatedAt ? c : best), null);

      if (!latest) {
        state.campaignId = null;
        state.items = [];
        renderCard();
        return;
      }

      state.campaignId = latest.id;
      state.items = latest.results
        .filter((r) => r.status === 'pending' || r.status === 'error')
        .map((r) => makeItem(r, latest.config.text, state.channel));
      state.cursor = 0;
      state.sessionStartAt = Date.now();
      state.sentCount = 0;
      window.relancePrerenderAll();
    } catch (err) {
      feedback('Échec du chargement de la file : ' + err.message, true);
    }
  };

  window.relanceCopy = async function relanceCopy() {
    const text = document.getElementById('relMessageText').value;
    try {
      await navigator.clipboard.writeText(text);
      feedback('Texte copié dans le presse-papiers.', false);
    } catch (err) {
      feedback('Impossible de copier automatiquement — sélectionnez et copiez manuellement.', true);
    }
  };

  window.relanceRegenerate = function relanceRegenerate() {
    if (!getIntention()) { feedback('Renseignez d\'abord "Mon Intention de Campagne".', true); return; }
    window.relanceRefreshMessage();
  };

  window.relanceSkip = function relanceSkip() {
    state.cursor += 1;
    renderCard();
  };

  window.relanceLaunch = async function relanceLaunch() {
    const item = state.items[state.cursor];
    if (!item) return;
    const text = document.getElementById('relMessageText').value;

    try { await navigator.clipboard.writeText(text); } catch (err) { /* non bloquant */ }

    const opened = window.open(buildDeepLink(item, text), '_blank', 'noopener');
    if (!opened) {
      feedback('Le navigateur a bloqué l\'ouverture automatique (pop-up). Autorisez les popups pour ce site, puis réessayez.', true);
      return;
    }

    if (state.campaignId) {
      fetch(`/api/legacy-campaigns/${state.campaignId}/mark-sent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: item.to }),
      }).catch(() => { feedback('Le lien a été ouvert, mais le statut n\'a pas pu être enregistré.', true); });
    }

    state.sentCount += 1;
    updateRhythm();
    state.cursor += 1;
    renderCard();
  };

  // Raccourcis clavier (parité dashboard.html) : Espace = Envoyer & Suivant,
  // Flèche droite = Ignorer/Suivant — inactifs pendant la saisie dans un
  // champ texte, et seulement quand l'onglet Relance est affiché et qu'une
  // carte de relance est visible.
  document.addEventListener('keydown', (e) => {
    const tab = document.getElementById('tab-relance');
    if (!tab || !tab.classList.contains('active')) return;
    const activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
    const card = document.getElementById('relCard');
    if (!card || card.style.display === 'none') return;

    if (e.code === 'Space') {
      e.preventDefault();
      window.relanceLaunch();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      window.relanceSkip();
    }
  });
})();
