// Agent de sélection de l'adaptateur de plateforme (wire point unique du
// contrat window.CyrusEngine/window.CyrusStore — voir adapters/CONTRACT.md).
//
// Ce fichier est chargé AVANT app-core.js/campaigns-core.js/relance-core.js/
// connexions-core.js dans index.html, et DOIT garantir que
// window.CyrusEngine + window.CyrusStore sont définis avant eux. C'est le rôle
// de sync.js (documenté par webapp-core/README.md) d'injecter directement le
// bon adaptateur ; en son absence, ce fichier charge celui qui convient à
// l'environnement d'exécution réel, en mode SYNCHRONE (document.write pendant
// le parsing) pour préserver l'ordre du contrat.
//
//   - Navigateur standard (mode /local, ZERO-VPS)  -> adapters/browser.js
//   - Capacitor (futur mobile, injecté par sync.js) -> adapters/mobile.js
//   - HTTP local-client (futur desktop)            -> adapters/desktop.js
//
// La sélection est déterministe (lecture seule de l'environnement) : elle ne
// dépend d'aucun paramètre, d'aucun stockage et d'aucun état antérieur.
(function () {
  'use strict';
  const env = typeof window !== 'undefined' ? window : {};
  const isCapacitor = !!(env.Capacitor && env.Capacitor.Plugins);
  const isLocalClient = !!(env.location && env.location.hostname && /127\.0\.0\.1|localhost|^localhost/i.test(env.location.hostname) && env.location.port);

  let adapter = 'browser';
  if (isCapacitor) adapter = 'mobile';
  else if (isLocalClient) adapter = 'desktop';

  // executionMode DÉTERMINISTE : '/local' sert exclusivement adapters/browser.js
  // (et inversement, la page /vps ne charge jamais webapp-core). Naturellement,
  // le mode navigateur = 'local' ; un embedding Capacitor = 'local' aussi.
  env.__CYRUS_MODE__ = 'local';

  // Chargement SYNCHRONE de l'adaptateur (injecte un <script> inline au point
  // courant du parsing) — garantit que les globals existent avant app-core.js.
  // C'est le seul usage de document.write du projet, strictement confiné ici.
  env.__CYRUS_ADAPTER__ = adapter;
  if (!env.CyrusEngine || !env.CyrusStore) {
    try {
      document.write('<script src="adapters/' + adapter + '.js"><\/script>');
    } catch (e) {
      // Échec réseau/résolveur inattendu : on laisse app-core.js échouer avec un
      // message clair plutôt que de charger un adaptateur partiel.
      console.error('[cyrus] adaptateur ' + adapter + ' introuvable.', e);
    }
  }
})();