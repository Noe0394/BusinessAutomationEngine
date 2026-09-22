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

  function init() {
    try { enhanceHelp(document); } catch (e) { /* jamais bloquant */ }
    try { enhanceLoading(document); } catch (e) { /* jamais bloquant */ }
    try { watchPanels(); } catch (e) { /* jamais bloquant */ }
    try { var a = document.querySelector('.panel.active'); if (a) animateIn(a); } catch (e) { /* jamais bloquant */ }
    // contenu affiché après connexion / rendu tardif, ou mis à jour dynamiquement (progression, rapport) : passes répétées, idempotentes.
    setInterval(function () { try { enhanceHelp(document); enhanceLoading(document); } catch (e) { /* rien */ } }, 1500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
