/* CYRUS — interface v2 (comportement) : (1) remplace les longs textes explicatifs par des icônes « ? » avec infobulle ; (2) anime l'arrivée des onglets et des cartes avec la
   bibliothèque Motion (public/vendor/motion.js, https://motion.dev — version JavaScript sans React). Aucun identifiant ni gestionnaire existant n'est touché :
   les paragraphes ne sont que masqués (leur texte alimente l'infobulle), et sans Motion la page reste entièrement fonctionnelle (transitions CSS seulement). */
(function () {
  'use strict';
  if (typeof document === 'undefined' || !document.querySelector) return;
  var reduce = false; try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { reduce = false; }
  var M = (typeof window !== 'undefined' && window.Motion) || null;
  var canAnimate = !!(M && typeof M.animate === 'function') && !reduce;

  // ---------------------------------------------------------------- 1) aide : « ? » + infobulle
  var MIN_LEN = 60;
  var SKIP = '#goalchat-messages, table, .modal-box, .modal-overlay, [data-no-help], .cy-help, #login-screen, #reports-content, .gc-inputbar';
  var HEADINGS = 'h1, h2, h3, h4, .gc-auto-title, legend, strong';

  function makeHelp(text) {
    var wrap = document.createElement('span'); wrap.className = 'cy-help';
    var btn = document.createElement('button'); btn.type = 'button'; btn.setAttribute('aria-label', 'Aide'); btn.textContent = '?';
    var tip = document.createElement('span'); tip.className = 'cy-tip'; tip.setAttribute('role', 'tooltip'); tip.textContent = text;
    btn.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); var open = wrap.classList.contains('open'); closeAll(); if (!open) wrap.classList.add('open'); });
    wrap.appendChild(btn); wrap.appendChild(tip); return wrap;
  }
  function closeAll() { var o = document.querySelectorAll('.cy-help.open'); for (var i = 0; i < o.length; i += 1) o[i].classList.remove('open'); }
  document.addEventListener('click', closeAll);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });

  function enhanceHelp(root) {
    var scope = root || document;
    var list = scope.querySelectorAll('.panel p, .panel .gc-auto-desc, .gc-autopanel .gc-auto-desc, .panel .hint, .panel .help-text');
    for (var i = 0; i < list.length; i += 1) {
      var p = list[i];
      if (p.getAttribute('data-cy-help') || p.id || p.hidden || p.closest(SKIP)) continue;
      var text = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < MIN_LEN) continue;
      var help = makeHelp(text);
      // placé à côté du titre qui précède (même bloc), sinon à la place du paragraphe
      var prev = p.previousElementSibling; var target = null;
      while (prev && !target) { if (prev.matches && prev.matches(HEADINGS)) target = prev; else if (prev.querySelector && prev.querySelector(HEADINGS) && prev.children.length < 4) target = prev.querySelector(HEADINGS); prev = target ? null : prev.previousElementSibling; }
      if (target && !target.querySelector('.cy-help')) target.appendChild(help);
      else { help.classList.add('cy-help-block'); p.parentNode.insertBefore(help, p); }
      p.setAttribute('data-cy-help', '1'); p.style.display = 'none';
    }
  }

  // ---------------------------------------------------------------- 2) mouvement (Motion)
  function animateIn(panel) {
    if (!canAnimate || !panel || panel.getAttribute('data-cy-anim') === String(panel.className)) return;
    panel.setAttribute('data-cy-anim', String(panel.className));
    try {
      M.animate(panel, { opacity: [0, 1], transform: ['translateY(10px)', 'translateY(0px)'] }, { duration: 0.35, ease: 'easeOut' });
      var cards = panel.querySelectorAll(':scope > .conn-block, :scope > .subsection, :scope > .campaign-queue-section, :scope > .gc-autopanel, :scope > .table-wrap');
      if (cards.length && typeof M.stagger === 'function') M.animate(cards, { opacity: [0, 1], transform: ['translateY(16px)', 'translateY(0px)'] }, { duration: 0.5, delay: M.stagger(0.06, { startDelay: 0.05 }), ease: [0.22, 1, 0.36, 1] });
    } catch (e) { /* l'animation n'est jamais bloquante */ }
    // Filet de sécurité : quoi qu'il arrive (onglet en arrière-plan, animation interrompue), rien ne reste transparent ou décalé.
    setTimeout(function () { try { panel.style.opacity = ''; panel.style.transform = ''; var kids = panel.querySelectorAll(':scope > *'); for (var k = 0; k < kids.length; k += 1) { if (kids[k].style.opacity === '0') kids[k].style.opacity = ''; } } catch (e) { /* rien */ } }, 1600);
  }
  function watchPanels() {
    if (typeof MutationObserver === 'undefined') return;
    var panels = document.querySelectorAll('.panel');
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i += 1) {
        var t = muts[i].target;
        if (t.classList && t.classList.contains('panel') && t.classList.contains('active')) { enhanceHelp(t); animateIn(t); }
      }
    });
    for (var j = 0; j < panels.length; j += 1) obs.observe(panels[j], { attributes: true, attributeFilter: ['class'] });
  }

  // ---------------------------------------------------------------- 3) états de chargement / en cours (discrets, jamais du texte figé)
  function enhanceLoading(root) {
    var scope = root || document;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    var node; var targets = [];
    while ((node = walker.nextNode())) { if (/^\s*Chargement\b/.test(node.nodeValue || '') && node.parentElement && !node.parentElement.classList.contains('cy-loading')) targets.push(node.parentElement); }
    for (var i = 0; i < targets.length; i += 1) targets[i].classList.add('cy-loading');
    // Pastille pulsée devant un statut « en cours » réel (jamais posée sur un statut terminé) — repère visuel uniquement, aucune donnée modifiée.
    var live = scope.querySelectorAll ? scope.querySelectorAll('.rep-evt, #panel-communities [id$="-progress"] > div') : [];
    for (var j = 0; j < live.length; j += 1) {
      var el = live[j]; var t = (el.textContent || '');
      if (/\b(?:RUNNING|QUEUED|En cours|Vérification)\b/.test(t) && !el.querySelector('.cy-live-dot') && el.firstChild) {
        var dot = document.createElement('span'); dot.className = 'cy-live-dot'; el.insertBefore(dot, el.firstChild);
      }
    }
  }

  // ---------------------------------------------------------------- 4) réglages d'apparence : thème (clair/sombre/auto) + couleur d'accent au choix
  // Préférence STRICTEMENT PERSONNELLE ("chacun personnalisera selon son goût" — demande explicite de l'utilisateur) : stockée dans CE navigateur
  // (localStorage), jamais envoyée au serveur. Le thème est déjà appliqué avant ce script (voir le petit script inline juste avant </body> dans
  // dashboard.html, qui évite un flash de la mauvaise couleur) ; ce module construit seulement le bouton, le panneau, et les tient synchronisés.
  var THEME_KEY = 'cyrusTheme'; var ACCENT_KEY = 'cyrusAccent'; var ACCENT_CUSTOM_KEY = 'cyrusAccentCustom';
  var ACCENTS = [
    { id: 'violet', label: 'Violet', hex: '#7c5cff' }, { id: 'blue', label: 'Bleu', hex: '#3b82f6' }, { id: 'green', label: 'Vert', hex: '#10b981' },
    { id: 'amber', label: 'Ambre', hex: '#ea9a0c' }, { id: 'rose', label: 'Rose', hex: '#f43f5e' }, { id: 'teal', label: 'Sarcelle', hex: '#14b8a6' },
  ];
  function safeGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* stockage indisponible (navigation privée…) : le réglage reste actif pour cette visite */ } }
  function systemPrefersLight() { try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches); } catch (e) { return false; } }
  function applyTheme(mode) {
    var effective = mode === 'auto' ? (systemPrefersLight() ? 'light' : 'dark') : mode;
    document.documentElement.setAttribute('data-theme', effective);
    document.documentElement.setAttribute('data-theme-mode', mode);
  }
  function applyAccent(id, customHex) {
    if (id === 'custom' && customHex) {
      document.documentElement.setAttribute('data-accent', 'custom');
      document.documentElement.style.setProperty('--accent', customHex);
      var rgb = hexToRgb(customHex);
      if (rgb) {
        document.documentElement.style.setProperty('--accent-2', lighten(rgb, 22));
        document.documentElement.style.setProperty('--accent-soft', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.16)');
        document.documentElement.style.setProperty('--accent-border', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.45)');
        document.documentElement.style.setProperty('--accent-shadow', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.7)');
        document.documentElement.style.setProperty('--accent-focus', 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',.22)');
      }
    } else {
      document.documentElement.setAttribute('data-accent', id);
      ['--accent', '--accent-2', '--accent-soft', '--accent-border', '--accent-shadow', '--accent-focus'].forEach(function (p) { document.documentElement.style.removeProperty(p); });
    }
  }
  function hexToRgb(hex) { var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex); return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null; }
  function lighten(rgb, amt) { var f = function (c) { return Math.max(0, Math.min(255, Math.round(c + (255 - c) * (amt / 100)))); }; return 'rgb(' + f(rgb.r) + ',' + f(rgb.g) + ',' + f(rgb.b) + ')'; }

  function buildAppearancePanel() {
    if (document.getElementById('cy-appearance-btn')) return;
    var btn = document.createElement('button'); btn.id = 'cy-appearance-btn'; btn.type = 'button'; btn.setAttribute('aria-label', 'Apparence'); btn.title = 'Apparence : thème et couleur'; btn.textContent = '🎨 Apparence';
    var panel = document.createElement('div'); panel.id = 'cy-appearance-panel'; panel.hidden = true;
    var themeMode = safeGet(THEME_KEY) || 'dark';
    var accentId = safeGet(ACCENT_KEY) || 'violet'; var customHex = safeGet(ACCENT_CUSTOM_KEY) || '#7c5cff';

    var h1 = document.createElement('h4'); h1.textContent = 'Thème'; panel.appendChild(h1);
    var row1 = document.createElement('div'); row1.className = 'cy-app-row';
    [['dark', 'Sombre'], ['light', 'Clair'], ['auto', 'Auto']].forEach(function (t) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'cy-theme-opt' + (themeMode === t[0] ? ' active' : ''); b.textContent = t[1]; b.dataset.theme = t[0];
      b.addEventListener('click', function () {
        themeMode = t[0]; safeSet(THEME_KEY, themeMode); applyTheme(themeMode);
        row1.querySelectorAll('.cy-theme-opt').forEach(function (x) { x.classList.toggle('active', x === b); });
      });
      row1.appendChild(b);
    });
    panel.appendChild(row1);

    var h2 = document.createElement('h4'); h2.textContent = 'Couleur'; panel.appendChild(h2);
    var row2 = document.createElement('div'); row2.className = 'cy-app-row cy-swatches';
    var swatchEls = [];
    ACCENTS.forEach(function (a) {
      var sw = document.createElement('button'); sw.type = 'button'; sw.className = 'cy-swatch' + (accentId === a.id ? ' active' : ''); sw.style.background = a.hex; sw.title = a.label; sw.setAttribute('aria-label', a.label);
      sw.addEventListener('click', function () {
        accentId = a.id; safeSet(ACCENT_KEY, accentId); applyAccent(accentId);
        swatchEls.forEach(function (x) { x.el.classList.toggle('active', x.id === accentId); }); customWrap.classList.remove('active');
      });
      swatchEls.push({ id: a.id, el: sw }); row2.appendChild(sw);
    });
    var customWrap = document.createElement('label'); customWrap.className = 'cy-swatch-custom' + (accentId === 'custom' ? ' active' : ''); customWrap.title = 'Couleur personnalisée';
    var customSpan = document.createElement('span'); customSpan.textContent = '+';
    var customInput = document.createElement('input'); customInput.type = 'color'; customInput.value = customHex;
    customInput.addEventListener('input', function () {
      customHex = customInput.value; accentId = 'custom'; safeSet(ACCENT_KEY, 'custom'); safeSet(ACCENT_CUSTOM_KEY, customHex); applyAccent('custom', customHex);
      swatchEls.forEach(function (x) { x.el.classList.remove('active'); }); customWrap.classList.add('active'); customWrap.style.background = customHex; customSpan.style.display = 'none';
    });
    customWrap.appendChild(customSpan); customWrap.appendChild(customInput); row2.appendChild(customWrap);
    if (accentId === 'custom') { customWrap.style.background = customHex; customSpan.style.display = 'none'; }
    panel.appendChild(row2);

    var hint = document.createElement('div'); hint.className = 'cy-app-hint'; hint.textContent = 'Ce réglage est propre à cet appareil/navigateur.';
    panel.appendChild(hint);

    btn.addEventListener('click', function (ev) { ev.stopPropagation(); panel.hidden = !panel.hidden; });
    document.addEventListener('click', function (ev) { if (!panel.hidden && !panel.contains(ev.target) && ev.target !== btn) panel.hidden = true; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') panel.hidden = true; });
    document.body.appendChild(btn); document.body.appendChild(panel);

    // Thème "auto" : suit un changement de préférence système en direct, sans recharger la page.
    try { window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () { if ((safeGet(THEME_KEY) || 'dark') === 'auto') applyTheme('auto'); }); } catch (e) { /* navigateur ancien : réglage manuel toujours disponible */ }

    if (accentId === 'custom') applyAccent('custom', customHex);
  }

  // ---------------------------------------------------------------- 5) robot hologramme en fond (discret, sur toutes les pages)
  var ROBOT_SVG = '<svg viewBox="0 0 320 300" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    + '<g class="cy-r-particle" opacity=".5"><circle cx="40" cy="60" r="2" fill="var(--robot-line)"/></g>'
    + '<g class="cy-r-particle" opacity=".5"><circle cx="70" cy="230" r="1.6" fill="var(--robot-line)"/></g>'
    + '<g class="cy-r-particle" opacity=".5"><circle cx="20" cy="150" r="1.8" fill="var(--robot-line)"/></g>'
    // écran holographique 1 (gauche, en retrait)
    + '<g class="cy-r-s1" transform="translate(4,70) rotate(-6)">'
    + '<rect class="cy-r-screen-glass cy-r-dim" x="0" y="0" width="86" height="64" rx="4" stroke-width="1.2"/>'
    + '<path class="cy-r-line cy-r-flicker" d="M8 14 h40 M8 24 h56 M8 34 h30 M8 44 h48" stroke-width="1.1" opacity=".8"/>'
    + '<clipPath id="cyClip1"><rect x="0" y="0" width="86" height="64" rx="4"/></clipPath>'
    + '<rect class="cy-r-sweep" x="0" y="0" width="86" height="18" clip-path="url(#cyClip1)"/>'
    + '</g>'
    // écran holographique 2 (droite, en retrait)
    + '<g class="cy-r-s2" transform="translate(226,64) rotate(7)">'
    + '<rect class="cy-r-screen-glass cy-r-dim" x="0" y="0" width="90" height="70" rx="4" stroke-width="1.2"/>'
    + '<circle class="cy-r-dim" cx="45" cy="35" r="20" fill="none" stroke-width="1"/>'
    + '<path class="cy-r-line cy-r-flicker" d="M45 15 L45 35 L60 44" stroke-width="1.2" opacity=".85"/>'
    + '<clipPath id="cyClip2"><rect x="0" y="0" width="90" height="70" rx="4"/></clipPath>'
    + '<rect class="cy-r-sweep" x="0" y="0" width="90" height="20" clip-path="url(#cyClip2)"/>'
    + '</g>'
    // écran principal (centre, devant lequel « travaille » le robot)
    + '<g class="cy-r-s3" transform="translate(96,40)">'
    + '<rect class="cy-r-screen-glass cy-r-dim" x="0" y="0" width="128" height="86" rx="5" stroke-width="1.3"/>'
    + '<path class="cy-r-line cy-r-flicker" d="M10 16 h70 M10 28 h94 M10 40 h54 M10 52 h80 M10 64 h40" stroke-width="1.1" opacity=".75"/>'
    + '<clipPath id="cyClip3"><rect x="0" y="0" width="128" height="86" rx="5"/></clipPath>'
    + '<rect class="cy-r-sweep" x="0" y="0" width="128" height="24" clip-path="url(#cyClip3)"/>'
    + '</g>'
    // support / socle
    + '<path class="cy-r-line cy-r-dim" d="M120 268 h80" stroke-width="2"/>'
    // silhouette humanoïde stylisée (respiration + tête + bras animés)
    + '<g class="cy-r-bob">'
    + '<g class="cy-r-head"><circle class="cy-r-line" cx="160" cy="92" r="20"/><path class="cy-r-line" d="M152 90 q8 6 16 0" stroke-width="1.4" opacity=".7"/></g>'
    + '<path class="cy-r-line" d="M160 112 v18" />'
    + '<path class="cy-r-line" d="M132 216 L142 132 Q160 122 178 132 L188 216" />'
    + '<circle class="cy-r-fill" cx="160" cy="130" r="3.2"/>'
    + '<g class="cy-r-arm-l"><path class="cy-r-line" d="M142 138 Q112 148 106 176" /><circle class="cy-r-fill" cx="106" cy="176" r="3.4"/></g>'
    + '<g class="cy-r-arm-r"><path class="cy-r-line" d="M178 138 Q206 150 214 166" /><circle class="cy-r-fill" cx="214" cy="166" r="3.4"/></g>'
    + '<path class="cy-r-line" d="M138 216 L128 266 M182 216 L192 266" />'
    + '</g>'
    + '</svg>';
  function buildRobot() {
    if (document.getElementById('cy-robot-bg')) return;
    var wrap = document.createElement('div'); wrap.id = 'cy-robot-bg'; wrap.setAttribute('aria-hidden', 'true'); wrap.innerHTML = ROBOT_SVG;
    document.body.insertBefore(wrap, document.body.firstChild);
  }

  function init() {
    try { applyTheme(safeGet(THEME_KEY) || 'dark'); } catch (e) { /* déjà appliqué par le script de tête, au pire thème sombre par défaut */ }
    try { var acc = safeGet(ACCENT_KEY); if (acc === 'custom') applyAccent('custom', safeGet(ACCENT_CUSTOM_KEY) || '#7c5cff'); else if (acc) applyAccent(acc); } catch (e) { /* défaut violet */ }
    try { buildAppearancePanel(); } catch (e) { /* jamais bloquant */ }
    try { buildRobot(); } catch (e) { /* jamais bloquant */ }
    try { enhanceHelp(document); } catch (e) { /* jamais bloquant */ }
    try { enhanceLoading(document); } catch (e) { /* jamais bloquant */ }
    try { watchPanels(); } catch (e) { /* jamais bloquant */ }
    try { var a = document.querySelector('.panel.active'); if (a) animateIn(a); } catch (e) { /* jamais bloquant */ }
    // contenu affiché après connexion / rendu tardif, ou mis à jour dynamiquement (progression, rapport) : passes répétées, idempotentes.
    setInterval(function () { try { enhanceHelp(document); enhanceLoading(document); } catch (e) { /* rien */ } }, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
