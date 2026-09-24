// Connexion Meta OAuth et operations principales de Page/Messenger du client local.
(function () {
  const $ = id => document.getElementById(id);
  let initialized = false;
  let conversations = [];
  let resolvedContacts = [];
  let activeQueueTimer = null;
  let activeQueueId = null;
  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erreur HTTP ${response.status}`);
    return data;
  }
  function feedback(message, error) {
    const el = $('fb-feedback'); el.textContent = message || ''; el.className = error ? 'error' : 'ok';
  }
  async function refreshStatus() {
    const state = await api('/api/facebook/status');
    $('fb-status').textContent = state.connected ? `Connecté · Page ${state.pageName || ''}`
      : state.configured ? 'Jeton configuré, connexion Meta à vérifier' : 'Page Facebook non connectée';
    $('fb-connect').disabled = !state.connectAvailable;
    $('fb-disconnect').disabled = !state.configured;
    return state;
  }
  async function loadPosts() {
    const { posts } = await api('/api/facebook/posts');
    const host = $('fb-page-posts'); host.replaceChildren();
    for (const post of posts) {
      const row = document.createElement('p');
      const link = document.createElement('a'); link.href = post.permalink_url || '#'; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = (post.message || '(publication sans texte)').slice(0, 180);
      const comments = document.createElement('button'); comments.type = 'button'; comments.textContent = 'Commentaires';
      comments.addEventListener('click', () => loadComments(post.id));
      row.append(link, document.createTextNode(' · ' + (post.created_time || '') + ' '), comments); host.append(row);
    }
    if (!posts.length) host.textContent = 'Aucune publication récente.';
  }
  async function loadComments(postId) {
    const host = $('fb-page-comments'); host.textContent = 'Chargement des commentaires…';
    try {
      const result = await api('/api/facebook/posts/' + encodeURIComponent(postId) + '/comments');
      host.replaceChildren();
      const heading = document.createElement('h4'); heading.textContent = 'Commentaires de la publication'; host.append(heading);
      for (const comment of result.comments || []) {
        const row = document.createElement('div'); row.className = 'card';
        const body = document.createElement('p'); body.textContent = `${comment.from?.name || 'Utilisateur'} · ${comment.is_hidden ? 'masqué' : 'visible'}\n${comment.message || '(sans texte)'}`;
        const reply = document.createElement('button'); reply.type = 'button'; reply.textContent = 'Répondre';
        reply.addEventListener('click', async () => { const message = window.prompt('Réponse publique au commentaire :'); if (!message?.trim()) return; try { await api('/api/facebook/comments/' + encodeURIComponent(comment.id) + '/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) }); feedback('Réponse publiée.'); } catch (e) { feedback(e.message, true); } });
        const hide = document.createElement('button'); hide.type = 'button'; hide.textContent = comment.is_hidden ? 'Rendre visible' : 'Masquer';
        hide.addEventListener('click', async () => { try { await api('/api/facebook/comments/' + encodeURIComponent(comment.id) + '/moderate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hide: !comment.is_hidden }) }); await loadComments(postId); } catch (e) { feedback(e.message, true); } });
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Supprimer';
        remove.addEventListener('click', async () => { if (!window.confirm('Supprimer définitivement ce commentaire Facebook ?')) return; try { await api('/api/facebook/comments/' + encodeURIComponent(comment.id), { method: 'DELETE' }); await loadComments(postId); } catch (e) { feedback(e.message, true); } });
        row.append(body, reply, hide, remove); host.append(row);
      }
      if (!(result.comments || []).length) host.append(document.createTextNode('Aucun commentaire disponible.'));
    } catch (error) { host.textContent = 'Impossible de charger les commentaires : ' + error.message; }
  }
  async function loadConversations() {
    const result = await api('/api/facebook/conversations'); conversations = result.conversations || [];
    const select = $('fb-messenger-conversation'); select.replaceChildren(new Option('Choisir une conversation', ''));
    for (const c of conversations.filter(x => x.recipientId)) select.add(new Option(`${c.name} · ${c.snippet || ''}`.slice(0, 160), c.recipientId));
    $('fb-messenger-feedback').textContent = `${conversations.length} conversation(s) chargée(s).`;
  }
  async function loadManagedGroups() {
    const result = await api('/api/facebook/groups'); const host = $('fb-managed-groups'); host.replaceChildren();
    for (const group of result.groups || []) {
      const row = document.createElement('p'); row.append(document.createTextNode(`${group.name} · ${group.id} `));
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Retirer';
      remove.addEventListener('click', async () => { await api('/api/facebook/groups/' + encodeURIComponent(group.id), { method: 'DELETE' }); await loadManagedGroups(); });
      row.append(remove); host.append(row);
    }
    if (!(result.groups || []).length) host.textContent = 'Aucun groupe enregistré.';
    if (window.CyrusFacebookShare) await window.CyrusFacebookShare.sync(false);
  }
  function normalizeColumn(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  async function importMessengerContacts(file) {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
    const contacts = rows.map((row) => {
      const fields = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeColumn(key), String(value || '').trim()]));
      return {
        name: fields.name || fields.nom || fields['full name'] || fields['nom complet'] || '',
        psid: fields.psid || fields['page scoped id'] || fields['facebook id'] || fields.recipientid || fields['recipient id'] || '',
      };
    }).filter(contact => contact.name || contact.psid);
    if (!contacts.length) throw new Error('Aucune colonne Nom, PSID, Facebook ID ou Recipient ID reconnue.');
    const result = await api('/api/facebook/contacts/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contacts }) });
    resolvedContacts = result.contacts || [];
    const host = $('fb-contacts-matches'); host.replaceChildren();
    for (const [index, contact] of resolvedContacts.entries()) {
      const row = document.createElement('label'); row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid #e0e0e0';
      const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.contactIndex = String(index); check.disabled = !contact.matched; check.checked = false; check.style.width = 'auto';
      const text = document.createElement('span'); text.textContent = `${contact.name || contact.psid || 'Contact'} · ${contact.matched ? 'conversation existante' : 'aucune conversation correspondante'}`;
      row.append(check, text); host.append(row);
    }
    const matched = resolvedContacts.filter(c => c.matched).length;
    $('fb-contacts-feedback').textContent = `${matched}/${resolvedContacts.length} contacts correspondent à une conversation de la Page. Cochez les destinataires voulus.`;
  }
  async function pollFacebookQueue(jobId) {
    try {
      const job = await api('/api/facebook/queue/' + encodeURIComponent(jobId));
      const delivered = (job.results || []).filter(r => r.status === 'delivered').length;
      const failed = (job.results || []).filter(r => r.status === 'failed').length;
      const notSent = (job.results || []).filter(r => r.status === 'not_sent').length;
      const unknown = (job.results || []).filter(r => r.status === 'unknown' || r.status === 'sending').length;
      $('fb-queue-progress').textContent = job.status === 'running'
        ? `File Messenger : ${job.sent}/${job.total} · intervalle aléatoire 10–15 s.`
        : job.status === 'completed'
          ? `Terminé : ${delivered} confirmé(s), ${failed} échec(s), ${unknown} résultat(s) incertain(s) sur ${job.total}.`
          : job.status === 'cancelled'
            ? `Arrêtée : ${delivered} confirmé(s), ${failed} échec(s), ${notSent} non envoyé(s).`
            : job.status === 'interrupted'
              ? `Interrompue par l’arrêt du client : ${delivered} confirmé(s), ${failed} échec(s), ${unknown} résultat(s) incertain(s), ${notSent} non envoyé(s). Vérifiez les conversations avant de relancer.`
              : `File en échec : ${job.error || 'erreur inconnue'}`;
      if (job.status !== 'running' && activeQueueTimer) { clearInterval(activeQueueTimer); activeQueueTimer = null; }
      if (job.status !== 'running') { $('fb-queue-send').disabled = false; $('fb-queue-stop').disabled = true; }
      await renderFacebookQueueHistory();
      return job.status;
    } catch (error) { $('fb-queue-progress').textContent = error.message; if (activeQueueTimer) clearInterval(activeQueueTimer); activeQueueTimer = null; $('fb-queue-send').disabled = false; $('fb-queue-stop').disabled = true; return 'failed'; }
  }
  async function renderFacebookQueueHistory() {
    const host = $('fb-queue-history'); if (!host) return;
    const { jobs = [] } = await api('/api/facebook/queue');
    host.replaceChildren();
    for (const job of jobs) {
      const card = document.createElement('div'); card.className = 'card';
      const delivered = (job.results || []).filter(r => r.status === 'delivered').length;
      const failed = (job.results || []).filter(r => r.status === 'failed').length;
      const notSent = (job.results || []).filter(r => r.status === 'not_sent').length;
      const unknown = (job.results || []).filter(r => r.status === 'unknown' || r.status === 'sending').length;
      const summary = document.createElement('p');
      summary.textContent = `${new Date(job.createdAt).toLocaleString()} · ${job.status} · ${delivered} confirmé(s), ${failed} échec(s), ${unknown} incertain(s), ${notSent} non envoyé(s) / ${job.total}`;
      card.append(summary);
      if ((job.results || []).length) {
        const details = document.createElement('details');
        const heading = document.createElement('summary'); heading.textContent = 'Détail des destinataires'; details.append(heading);
        for (const result of job.results) {
          const row = document.createElement('p');
          row.textContent = `${result.to} · ${result.status}${result.error ? ' · ' + result.error : ''}`;
          details.append(row);
        }
        card.append(details);
      }
      if (job.error) { const error = document.createElement('small'); error.textContent = job.error; card.append(error); }
      host.append(card);
    }
    if (!jobs.length) host.textContent = 'Aucune file Messenger enregistrée.';
  }
  async function init() {
    if (!initialized) {
      initialized = true;
      $('fb-save-config').addEventListener('click', async () => {
        try {
          const result = await api('/api/facebook/oauth-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: $('fb-app-id').value, appSecret: $('fb-app-secret').value }) });
          $('fb-app-secret').value = ''; feedback('Configuration Meta enregistrée localement. URI de redirection à autoriser dans Meta : ' + result.redirectUri);
          await refreshStatus();
        } catch (err) { feedback(err.message, true); }
      });
      $('fb-connect').addEventListener('click', () => { window.location.href = '/api/facebook/connect'; });
      $('fb-disconnect').addEventListener('click', async () => { try { await api('/api/facebook/logout', { method: 'POST' }); feedback('Page déconnectée.'); await refreshStatus(); } catch (e) { feedback(e.message, true); } });
      $('fb-page-publish').addEventListener('click', async () => {
        try {
          const message = $('fb-page-message').value.trim(); const link = $('fb-page-link').value.trim();
          const scheduledPublishTime = $('fb-page-time').value ? new Date($('fb-page-time').value).toISOString() : null;
          const file = $('fb-page-media').files[0];
          if (file && file.size > 10 * 1024 * 1024) throw new Error('La pièce jointe dépasse 10 Mo.');
          const media = file ? await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ base64: String(reader.result).split(',')[1], type: file.type, name: file.name }); reader.onerror = () => reject(new Error('Lecture du média impossible.')); reader.readAsDataURL(file); }) : null;
          const result = await api('/api/facebook/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, link, media, scheduledPublishTime }) });
          feedback(result.id ? `Publication acceptée par Meta · ${result.id}` : 'Demande transmise à Meta.');
          $('fb-page-message').value = ''; $('fb-page-time').value = ''; $('fb-page-media').value = ''; loadPosts().catch(() => {});
        } catch (err) { feedback(err.message, true); }
      });
      $('fb-page-refresh').addEventListener('click', () => loadPosts().catch(e => feedback(e.message, true)));
      $('fb-messenger-refresh').addEventListener('click', () => loadConversations().catch(e => { $('fb-messenger-feedback').textContent = e.message; }));
      $('fb-messenger-send').addEventListener('click', async () => {
        const to = $('fb-messenger-conversation').value; const message = $('fb-messenger-message').value.trim();
        if (!to || !message) { $('fb-messenger-feedback').textContent = 'Choisissez une conversation et saisissez une réponse.'; return; }
        try { await api('/api/facebook/conversations/' + encodeURIComponent(to) + '/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) }); $('fb-messenger-message').value = ''; $('fb-messenger-feedback').textContent = 'Réponse envoyée par la Page.'; }
        catch (e) { $('fb-messenger-feedback').textContent = e.message; }
      });
      $('fb-managed-group-add').addEventListener('click', async () => {
        try { await api('/api/facebook/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('fb-managed-group-name').value.trim(), id: $('fb-managed-group-id').value.trim() }) }); $('fb-managed-group-name').value = ''; $('fb-managed-group-id').value = ''; await loadManagedGroups(); }
        catch (e) { feedback(e.message, true); }
      });
      $('fb-contacts-file').addEventListener('change', async event => {
        const file = event.target.files[0]; if (!file) return;
        $('fb-contacts-feedback').textContent = 'Lecture et correspondance avec les conversations Messenger…';
        try { await importMessengerContacts(file); } catch (error) { $('fb-contacts-feedback').textContent = 'Import impossible : ' + error.message; }
        event.target.value = '';
      });
      $('fb-queue-send').addEventListener('click', async () => {
        const selected = Array.from(document.querySelectorAll('#fb-contacts-matches input[type=checkbox]:checked'))
          .map(input => resolvedContacts[Number(input.dataset.contactIndex)]?.recipientId).filter(Boolean);
        const message = $('fb-queue-message').value.trim();
        const file = $('fb-queue-media').files[0];
        if (!selected.length || (!message && !file)) { $('fb-queue-progress').textContent = 'Cochez au moins une conversation et saisissez le message ou joignez un média.'; return; }
        if (file && file.size > 10 * 1024 * 1024) { $('fb-queue-progress').textContent = 'La pièce jointe dépasse 10 Mo.'; return; }
        try {
          const media = file ? await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ base64: String(reader.result).split(',')[1], type: file.type, name: file.name }); reader.onerror = () => reject(new Error('Lecture du média impossible.')); reader.readAsDataURL(file); }) : null;
          const started = await api('/api/facebook/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipients: selected, message, media }) });
          activeQueueId = started.id;
          $('fb-queue-send').disabled = true; $('fb-queue-progress').textContent = `File lancée : ${started.total} destinataire(s).`;
          $('fb-queue-stop').disabled = false;
          if (activeQueueTimer) clearInterval(activeQueueTimer);
          const state = await pollFacebookQueue(started.id);
          if (state === 'running') activeQueueTimer = setInterval(() => pollFacebookQueue(started.id), 2000);
        } catch (error) { $('fb-queue-progress').textContent = error.message; $('fb-queue-send').disabled = false; }
      });
      $('fb-queue-stop').addEventListener('click', async () => {
        if (!activeQueueId || $('fb-queue-stop').disabled) return;
        $('fb-queue-stop').disabled = true;
        $('fb-queue-progress').textContent = 'Arrêt demandé. L’envoi actuellement transmis à Meta peut se terminer.';
        try { await api('/api/facebook/queue/' + encodeURIComponent(activeQueueId) + '/cancel', { method: 'POST' }); }
        catch (error) { $('fb-queue-progress').textContent = error.message; $('fb-queue-stop').disabled = false; }
      });
    }
    const params = new URLSearchParams(location.search); const result = params.get('fbConnect');
    if (result) { feedback(result === 'success' ? 'Page Facebook connectée.' : 'Connexion Meta échouée ou annulée.', result !== 'success'); history.replaceState(null, '', location.pathname); }
    try { await refreshStatus(); } catch (e) { feedback(e.message, true); }
    try { await renderFacebookQueueHistory(); } catch (e) { $('fb-queue-history').textContent = e.message; }
    try {
      const { jobs = [] } = await api('/api/facebook/queue');
      const running = jobs.find(job => job.status === 'running');
      if (running) {
        activeQueueId = running.id; $('fb-queue-send').disabled = true; $('fb-queue-stop').disabled = false;
        if (await pollFacebookQueue(running.id) === 'running') activeQueueTimer = setInterval(() => pollFacebookQueue(running.id), 2000);
      }
    } catch (e) { $('fb-queue-history').textContent = e.message; }
    loadManagedGroups().catch(e => feedback(e.message, true));
  }
  window.facebookLocalInit = () => init();
})();
