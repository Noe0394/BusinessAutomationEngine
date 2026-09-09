// Sélecteur de moteur WhatsApp (Pattern Strategy / Feature Flag). Baileys
// (adapters/whatsappEngineBaileys.js) reste le moteur par défaut, inchangé ;
// whatsapp-web.js (adapters/whatsappEngineWwebjs.js) devient actif
// uniquement si WHATSAPP_ENGINE=wwebjs. whatsappManager.js et le reste du
// serveur ne dépendent que de ce fichier, jamais directement d'un moteur
// précis — les deux implémentations exposent donc strictement le même
// contrat (createSession(tenantId) -> mêmes méthodes/événements, et
// AUTH_DIR_BASE).
const engine = process.env.WHATSAPP_ENGINE === 'wwebjs'
  ? require('./whatsappEngineWwebjs')
  : require('./whatsappEngineBaileys');

module.exports = engine;
