// Partage assisté Facebook, disponible hors ligne de tout backend CYRUS.
(function () {
  const KEY = 'cyrus.facebook.managedGroups.v1';
  const $ = id => document.getElementById(id);
  const feedback = (id, message, error) => { const el = $(id); el.textContent = message; el.className = error ? 'error' : ''; };
  const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function load() { try { const rows = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(rows) ? rows : []; } catch (_) { return []; } }
  function save(rows) { localStorage.setItem(KEY, JSON.stringify(rows)); render(); }
  function displayLink(group) { return group.link || group.id || ''; }
  function render() {
    const body = $('fb-share-groups-body'); body.replaceChildren();
    $('fb-share-select-all').checked = false;
    const groups = load();
    if (!groups.length) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 5; cell.textContent = 'Aucun groupe enregistré.'; return; }
    groups.forEach(group => {
      const row = body.insertRow(); const selectCell = row.insertCell(); const check = document.createElement('input'); check.type = 'checkbox'; check.dataset.groupId = group.id; check.className = 'fb-share-group-check'; selectCell.appendChild(check);
      row.insertCell().textContent = group.name;
      const linkCell = row.insertCell(); if (group.link && /^https:\/\//i.test(group.link)) { const a = document.createElement('a'); a.href = group.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = group.link; linkCell.appendChild(a); } else linkCell.textContent = displayLink(group);
      row.insertCell().textContent = group.lastAction || '—';
      const actionCell = row.insertCell(); const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Retirer'; remove.addEventListener('click', () => save(load().filter(g => g.id !== group.id))); actionCell.appendChild(remove);
    });
  }
  function addGroup(name, link) {
    name = String(name || '').trim(); link = String(link || '').trim();
    if (!name || !link) throw new Error('Indiquez le nom et le lien ou l’identifiant du groupe.');
    const rows = load(); const id = link;
    if (rows.some(g => g.id === id)) throw new Error('Ce groupe est déjà dans la liste.');
    rows.push({ id, name, link, addedAt: Date.now(), lastAction: '' }); save(rows);
  }
  async function importGroups(file) {
    const data = await file.arrayBuffer(); const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]]; const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    let added = 0; const issues = [];
    rows.forEach((row, index) => {
      const fields = Object.keys(row).reduce((acc, key) => { acc[norm(key)] = row[key]; return acc; }, {});
      const name = fields['nom du groupe'] || fields['nom groupe'] || fields['group name'] || fields.name || fields.groupe || '';
      const link = fields['lien du groupe'] || fields['lien groupe'] || fields['group link'] || fields.link || fields.url || fields.id || fields.identifiant || '';
      try { addGroup(String(name || link), String(link)); added += 1; } catch (err) { issues.push('ligne ' + (index + 2) + ': ' + err.message); }
    });
    feedback('fb-share-import-feedback', added + ' groupe(s) importé(s).' + (issues.length ? ' ' + issues.length + ' ligne(s) ignorée(s).' : ''), !!issues.length);
  }
  function selectedGroups() {
    const ids = Array.from(document.querySelectorAll('.fb-share-group-check:checked')).map(x => x.dataset.groupId);
    return load().filter(g => ids.includes(g.id));
  }
  function shareUrl() {
    const raw = $('fb-share-post-url').value.trim();
    if (!raw) throw new Error('Collez le lien de la publication à partager.');
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') throw new Error('Le lien de publication doit être en HTTPS.');
    return 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(parsed.toString());
  }
  async function copyMessage() {
    const message = $('fb-share-message').value;
    if (!message) { feedback('fb-share-feedback', 'Aucun message à copier.', true); return; }
    try { await navigator.clipboard.writeText(message); }
    catch (_) { const input = $('fb-share-message'); input.focus(); input.select(); document.execCommand('copy'); }
    feedback('fb-share-feedback', 'Message copié. Collez-le manuellement dans Facebook.');
  }
  async function openSelected() {
    try {
      const url = shareUrl(); const selected = selectedGroups();
      if (!selected.length) throw new Error('Sélectionnez au moins un groupe.');
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share && selected.length > 1) throw new Error('Sur le téléphone, ouvrez un partage à la fois : sélectionnez un seul groupe.');
      if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share) {
        await window.Capacitor.Plugins.Share.share({ title: 'Partager sur Facebook', text: $('fb-share-message').value || undefined, url: $('fb-share-post-url').value.trim(), dialogTitle: 'Partager la publication' });
        const at = new Date().toLocaleString(); const ids = new Set(selected.map(g => g.id));
        save(load().map(g => ids.has(g.id) ? Object.assign({}, g, { lastAction: 'Fenêtre de partage ouverte · ' + at + ' · non confirmé' }) : g));
        feedback('fb-share-feedback', 'Fenêtre native de partage fermée. Facebook ne confirme pas le choix ni la publication.'); return;
      }
      const at = new Date().toLocaleString(); let opened = 0;
      selected.forEach((group, index) => {
        const handle = window.open(url, 'cyrus_facebook_share_' + index, 'width=720,height=640');
        if (handle) { handle.opener = null; group.lastAction = 'Fenêtre de partage ouverte · ' + at + ' · non confirmé'; opened += 1; }
        else group.lastAction = 'Fenêtre bloquée par le navigateur · ' + at;
      });
      const selectedIds = new Set(selected.map(g => g.id)); save(load().map(g => selectedIds.has(g.id) ? (selected.find(x => x.id === g.id) || g) : g));
      feedback('fb-share-feedback', opened + '/' + selected.length + ' fenêtre(s) ouverte(s). Choisissez manuellement le groupe dans Facebook; le partage n’est pas confirmé.', opened === 0);
    } catch (err) { feedback('fb-share-feedback', err.message || 'Partage impossible.', true); }
  }
  document.addEventListener('DOMContentLoaded', function () {
    $('fb-share-add-group').addEventListener('click', function () {
      try { addGroup($('fb-share-group-name').value, $('fb-share-group-link').value); $('fb-share-group-name').value = ''; $('fb-share-group-link').value = ''; feedback('fb-share-import-feedback', 'Groupe ajouté.'); }
      catch (err) { feedback('fb-share-import-feedback', err.message, true); }
    });
    $('fb-share-import').addEventListener('change', async function (event) {
      const file = event.target.files[0]; if (!file) return;
      try { await importGroups(file); } catch (err) { feedback('fb-share-import-feedback', 'Import impossible : ' + err.message, true); }
      event.target.value = '';
    });
    $('fb-share-select-all').addEventListener('change', event => document.querySelectorAll('.fb-share-group-check').forEach(c => { c.checked = event.target.checked; }));
    $('fb-share-copy-message').addEventListener('click', copyMessage);
    $('fb-share-open-selected').addEventListener('click', openSelected);
    render();
  });
})();
