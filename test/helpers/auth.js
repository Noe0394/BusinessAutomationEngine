// Aide de test : exécute le flux courant sous une identité AUTHENTIFIÉE (principal ADMIN de test), comme le ferait un canal réel.
// Deny-by-default : sans principal, aucun outil du Tool Registry ne s'exécute (voir ai-engine/authz.js).
const authz = require('../../ai-engine/authz');

function actAsAdmin(tenant) {
  authz.enterAs(authz.issuePrincipal({ tenant: tenant || '__test__', role: 'ADMIN', channel: 'WEB', via: 'test' }));
}
function ownerOf(tenant, channel) {
  return authz.issuePrincipal({ tenant, role: 'OWNER', userId: tenant, channel: channel || 'WEB', via: 'test' });
}

module.exports = { actAsAdmin, ownerOf, authz };
