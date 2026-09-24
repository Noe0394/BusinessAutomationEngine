// Facebook/Messenger mobile via la passerelle Cloudflare; aucun jeton Meta n'est conserve sur l'appareil.
(function () {
  const $ = id => document.getElementById(id);
  let conversations = [];
  let activeQueue = null;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function api(path, body) {
    if (!window.Cyrus || typeof window.Cyrus.cloudflareRequest !== 'function') throw new Error('Passerelle Cloudflare indisponible.');
    return window.Cyrus.cloudflareRequest('/facebook' + path, body || {});
  }
  function feedback(text, error) {
    const el = $('mobile-facebook-feedback'); el.textContent = text || ''; el.className = error ? 'error' : 'ok';
  }
  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ base64: String(reader.result).split(',')[1], type: file.type, name: file.name });
      reader.onerror = () => reject(new Error('Lecture du média impossible.'));
      reader.readAsDataURL(file);
    });
  }
  function normalizeColumn(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  async function refreshStatus() {
    const state = await api('/status');
    $('mobile-facebook-status').textContent = state.connected ? `Connecté · Page ${state.pageName || state.pageId}`
      : state.needsPageSelection ? 'Autorisation reçue · choisis la Page à connecter.'
        : state.error ? `Page indisponible · ${state.error}` : state.connectAvailable ? 'Aucune Page connectée.' : 'Passerelle Meta non configurée.';
    $('mobile-facebook-disconnect').disabled = !state.connected && !state.needsPageSelection;
    if (state.needsPageSelection) await loadPages();
    return state;
  }
  async function loadPages() {
    const result = await api('/pages');
    const select = $('mobile-facebook-pages'); select.replaceChildren(new Option('Choisir une Page autorisée', ''));
    (result.pages || []).forEach(page => select.add(new Option(`${page.name} · ${page.id}`, page.id)));
    if (!result.pages?.length) feedback('Aucune Page autorisée n’a été renvoyée par Meta.', true);
  }
  async function loadPosts() {
    const result = await api('/posts', { action: 'list' });
    const host = $('mobile-facebook-posts'); host.replaceChildren();
    for (const post of result.posts || []) {
      const card = document.createElement('div'); card.className = 'card';
      const text = document.createElement('p'); text.textContent = `${post.created_time || ''} · ${(post.message || '(publication sans texte)').slice(0, 240)}`; card.append(text);
      if (post.permalink_url) { const link = document.createElement('a'); link.href = post.permalink_url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Ouvrir sur Facebook'; card.append(link); }
      const comments = document.createElement('button'); comments.type = 'button'; comments.textContent = 'Commentaires'; comments.addEventListener('click', () => loadComments(post.id)); card.append(comments);
      host.append(card);
    }
    if (!result.posts?.length) host.textContent = 'Aucune publication récente.';
  }
  async function loadComments(postId) {
    const host = $('mobile-facebook-comments'); host.textContent = 'Chargement des commentaires…';
    try {
      const result = await api('/comments', { action: 'list', postId }); host.replaceChildren();
      for (const comment of result.comments || []) {
        const card = document.createElement('div'); card.className = 'card';
        const text = document.createElement('p'); text.textContent = `${comment.from?.name || 'Utilisateur'} · ${comment.is_hidden ? 'masqué' : 'visible'}\n${comment.message || ''}`; card.append(text);
        const reply = document.createElement('button'); reply.textContent = 'Répondre'; reply.addEventListener('click', async () => {
          const message = window.prompt('Réponse publique au commentaire :'); if (!message?.trim()) return;
          try { await api('/comments', { action: 'reply', commentId: comment.id, message: message.trim() }); text.textContent += '\nRéponse envoyée.'; }
          catch (error) { feedback(error.message, true); }
        }); card.append(reply);
        const hide = document.createElement('button'); hide.textContent = comment.is_hidden ? 'Afficher' : 'Masquer'; hide.addEventListener('click', async () => {
          try { await api('/comments', { action: 'moderate', commentId: comment.id, hide: !comment.is_hidden }); await loadComments(postId); }
          catch (error) { feedback(error.message, true); }
        }); card.append(hide);
        host.append(card);
      }
      if (!result.comments?.length) host.textContent = 'Aucun commentaire accessible.';
    } catch (error) { host.textContent = error.message; }
  }
  async function loadConversations() {
    const result = await api('/conversations', { action: 'list' });
    conversations = result.conversations || [];
    const select = $('mobile-facebook-conversation'); select.replaceChildren(new Option('Choisir une conversation', ''));
    conversations.filter(c => c.recipientId).forEach(c => select.add(new Option(`${c.name} · ${c.snippet || ''}`.slice(0, 160), c.recipientId)));
    if (!conversations.length) $('mobile-facebook-queue-status').textContent = 'Aucune conversation accessible.';
  }
  function formatQueue(job) {
    const delivered = (job.results || []).filter(row => row.status === 'delivered').length;
    const failed = (job.results || []).filter(row => row.status === 'failed').length;
    const unknown = (job.results || []).filter(row => row.status === 'unknown' || row.status === 'sending').length;
    const pending = (job.results || []).filter(row => row.status === 'not_sent' || row.status === 'pending').length;
    return `${job.status} · ${delivered} confirmé(s), ${failed} échec(s), ${unknown} incertain(s), ${pending} non envoyé(s) / ${job.total}`;
  }
  async function renderQueueHistory() {
    const host = $('mobile-facebook-queue-history'); if (!host) return;
    const jobs = await Cyrus.db.getFacebookQueueJobs(); host.replaceChildren();
    jobs.slice(0, 10).forEach(job => {
      const details = document.createElement('details'); const summary = document.createElement('summary');
      summary.textContent = `${new Date(job.createdAt).toLocaleString()} · ${formatQueue(job)}`; details.append(summary);
      (job.results || []).forEach(row => { const p = document.createElement('p'); p.textContent = `${row.to} · ${row.status}${row.error ? ' · ' + row.error : ''}`; details.append(p); });
      host.append(details);
    });
    if (!jobs.length) host.textContent = 'Aucune file Messenger enregistrée.';
  }
  async function saveQueue(job) {
    await Cyrus.db.saveFacebookQueueJob(job);
    $('mobile-facebook-queue-status').textContent = formatQueue(job);
    await renderQueueHistory();
  }
  async function restoreQueue() {
    const jobs = await Cyrus.db.getFacebookQueueJobs();
    for (const job of jobs.filter(item => item.status === 'running')) {
      job.results = (job.results || []).map(row => row.status === 'sending'
        ? { ...row, status: 'unknown', error: 'Application interrompue pendant l’envoi; vérifie la conversation avant toute nouvelle tentative.' }
        : row.status === 'pending' ? { ...row, status: 'not_sent' } : row);
      job.results.forEach(row => { if (row.status === 'pending') row.status = 'not_sent'; });
      job.status = 'interrupted'; job.error = 'La file ne reprend pas automatiquement après une fermeture.';
      await Cyrus.db.saveFacebookQueueJob(job);
    }
    await renderQueueHistory();
  }
  async function startQueue() {
    if (activeQueue) return;
    const psids = [...new Set($('mobile-facebook-psids').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))];
    const message = $('mobile-facebook-queue-message').value.trim();
    const file = $('mobile-facebook-queue-media').files[0] || null;
    if (!psids.length || psids.length > 200 || (!message && !file)) { $('mobile-facebook-queue-status').textContent = 'Saisis un texte ou joins un média et indique 1 à 200 PSID, un par ligne.'; return; }
    if (file && file.size > 10 * 1024 * 1024) { $('mobile-facebook-queue-status').textContent = 'Le média dépasse 10 Mo.'; return; }
    if (!window.confirm(`Vérifier les conversations puis envoyer ce message à ${psids.length} PSID ? Meta applique toujours sa fenêtre de messagerie.`)) return;
    const start = $('mobile-facebook-queue-start'); start.disabled = true;
    try {
      const resolved = await api('/contacts/resolve', { contacts: psids.map(psid => ({ psid })) });
      const eligible = resolved.contacts.filter(row => row.matched && row.recipientId).map(row => row.recipientId);
      const rejected = resolved.contacts.length - eligible.length;
      if (!eligible.length) throw new Error('Aucun PSID ne correspond à une conversation Messenger existante.');
      if (rejected && !window.confirm(`${rejected} PSID sans conversation existante seront ignorés. Continuer pour ${eligible.length} destinataire(s) ?`)) return;
      const job = { id: 'fbq_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), status: 'running', total: eligible.length, sent: 0, recipients: eligible, results: eligible.map(to => ({ to, status: 'pending' })), createdAt: Date.now() };
      const media = file ? await readFile(file) : null;
      activeQueue = { job, stop: false }; $('mobile-facebook-queue-stop').disabled = false; await saveQueue(job);
      for (let index = 0; index < eligible.length; index += 1) {
        if (activeQueue.stop) {
          job.results.slice(index).forEach(row => { if (row.status === 'pending') row.status = 'not_sent'; });
          job.status = 'cancelled'; break;
        }
        const row = job.results[index]; row.status = 'sending'; job.sent = index; await saveQueue(job);
        try {
          await api('/conversations', { action: 'send', recipientId: row.to, message, media });
          row.status = 'delivered'; row.sentAt = Date.now();
        } catch (error) {
          row.status = !error.status || error.status >= 500 ? 'unknown' : 'failed'; row.error = String(error.message || error).slice(0, 240);
          if (row.status === 'unknown') {
            job.results.slice(index + 1).forEach(next => { if (next.status === 'pending') next.status = 'not_sent'; });
            job.status = 'interrupted'; job.error = 'Résultat réseau incertain; la file s’arrête pour éviter les doublons.'; break;
          }
          if (error.status === 429) {
            job.results.slice(index + 1).forEach(next => { if (next.status === 'pending') next.status = 'not_sent'; });
            job.status = 'interrupted'; job.error = 'Meta a limité le débit; vérifie la page avant de lancer une nouvelle file.'; break;
          }
        }
        job.sent = index + 1; await saveQueue(job);
        if (index < eligible.length - 1) {
          const deadline = Date.now() + (10000 + Math.floor(Math.random() * 5001));
          while (Date.now() < deadline && !activeQueue.stop) await wait(Math.min(250, deadline - Date.now()));
        }
      }
      if (job.status === 'running') job.status = activeQueue.stop ? 'cancelled' : 'completed';
      if (activeQueue.stop) job.results.filter(row => row.status === 'pending').forEach(row => { row.status = 'not_sent'; });
      await saveQueue(job);
      if (job.status === 'completed' || job.status === 'cancelled') $('mobile-facebook-queue-media').value = '';
    } catch (error) { $('mobile-facebook-queue-status').textContent = error.message; }
    finally { activeQueue = null; $('mobile-facebook-queue-stop').disabled = true; start.disabled = false; }
  }
  async function init() {
    $('mobile-facebook-connect').addEventListener('click', async () => {
      try {
        const result = await api('/oauth/start');
        if (window.Capacitor?.Plugins?.CyrusOpenUrl) await window.Capacitor.Plugins.CyrusOpenUrl.open({ url: result.authUrl });
        else window.open(result.authUrl, '_blank', 'noopener');
        feedback('Termine la connexion Meta dans le navigateur, puis reviens et actualise le statut.');
      } catch (error) { feedback(error.message, true); }
    });
    $('mobile-facebook-refresh').addEventListener('click', async () => { try { await refreshStatus(); feedback('Statut actualisé.'); } catch (error) { feedback(error.message, true); } });
    $('mobile-facebook-select-page').addEventListener('click', async () => {
      try { const pageId = $('mobile-facebook-pages').value; if (!pageId) throw new Error('Choisis une Page.'); const result = await api('/connect', { pageId }); feedback(`Page connectée : ${result.pageName}.`); await refreshStatus(); }
      catch (error) { feedback(error.message, true); }
    });
    $('mobile-facebook-disconnect').addEventListener('click', async () => {
      if (!window.confirm('Déconnecter la Page et supprimer les jetons conservés par la passerelle ?')) return;
      try { await api('/disconnect'); feedback('Page déconnectée.'); await refreshStatus(); }
      catch (error) { feedback(error.message, true); }
    });
    $('mobile-facebook-publish').addEventListener('click', async () => {
      try {
        const file = $('mobile-facebook-post-media').files[0] || null;
        if (file && file.size > 10 * 1024 * 1024) throw new Error('Le média dépasse 10 Mo.');
        const scheduledPublishTime = $('mobile-facebook-post-time').value ? new Date($('mobile-facebook-post-time').value).toISOString() : null;
        const result = await api('/posts', { action: 'publish', message: $('mobile-facebook-post-message').value.trim(), link: $('mobile-facebook-post-link').value.trim(), media: file ? await readFile(file) : null, scheduledPublishTime });
        feedback(`Demande transmise à Meta · ${result.id || ''}`); $('mobile-facebook-post-message').value = ''; $('mobile-facebook-post-media').value = ''; await loadPosts();
      } catch (error) { feedback(error.message, true); }
    });
    $('mobile-facebook-posts-refresh').addEventListener('click', () => loadPosts().catch(error => feedback(error.message, true)));
    $('mobile-facebook-conversations-refresh').addEventListener('click', () => loadConversations().catch(error => feedback(error.message, true)));
    $('mobile-facebook-reply-send').addEventListener('click', async () => {
      try {
        const recipientId = $('mobile-facebook-conversation').value; const message = $('mobile-facebook-reply').value.trim(); const file = $('mobile-facebook-reply-media').files[0] || null;
        if (!recipientId || (!message && !file)) throw new Error('Choisis une conversation puis saisis une réponse ou joins un média.');
        if (file && file.size > 10 * 1024 * 1024) throw new Error('Le média dépasse 10 Mo.');
        await api('/conversations', { action: 'send', recipientId, message, media: file ? await readFile(file) : null });
        $('mobile-facebook-reply').value = ''; $('mobile-facebook-reply-media').value = ''; $('mobile-facebook-queue-status').textContent = 'Réponse transmise à Meta.';
      }
      catch (error) { $('mobile-facebook-queue-status').textContent = error.message; }
    });
    $('mobile-facebook-queue-start').addEventListener('click', startQueue);
    $('mobile-facebook-contacts-file').addEventListener('change', async event => {
      const file = event.target.files[0]; if (!file) return;
      try {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: '' });
        const psids = rows.map(row => {
          const fields = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeColumn(key), String(value || '').trim()]));
          return fields.psid || fields.recipientid || fields['recipient id'] || fields['page scoped id'] || fields['facebook id'] || '';
        }).filter(Boolean);
        if (!psids.length) throw new Error('Aucune colonne PSID, Recipient ID ou Facebook ID reconnue.');
        $('mobile-facebook-psids').value = [...new Set(psids)].join('\n');
        $('mobile-facebook-contacts-feedback').textContent = `${new Set(psids).size} PSID importé(s); la passerelle vérifiera les conversations avant tout envoi.`;
      } catch (error) { $('mobile-facebook-contacts-feedback').textContent = error.message; }
      finally { event.target.value = ''; }
    });
    $('mobile-facebook-queue-stop').addEventListener('click', () => { if (activeQueue) { activeQueue.stop = true; $('mobile-facebook-queue-stop').disabled = true; $('mobile-facebook-queue-status').textContent = 'Arrêt demandé; l’envoi en cours peut se terminer.'; } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus().catch(() => {}); });
    await restoreQueue();
    try { const state = await refreshStatus(); if (state.connected) { loadPosts().catch(() => {}); loadConversations().catch(() => {}); } }
    catch (error) { $('mobile-facebook-status').textContent = 'Passerelle Facebook inaccessible : ' + error.message; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(error => feedback(error.message, true)), { once: true });
  else init().catch(error => feedback(error.message, true));
})();
