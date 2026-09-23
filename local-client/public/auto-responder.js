(function () {
  const get = (id) => document.getElementById(id);
  const panel = get('gc-autopanel'); const toggle = get('goalchat-auto-btn');
  if (!panel || !toggle) return;
  const status = get('autoreply-status'); const cpStatus = get('cp-status');
  async function request(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || ('HTTP ' + response.status));
    return data;
  }
  function showPolicy(data) {
    if (!data || !data.policy) return;
    get('cp-private').value = data.policy.private;
    get('cp-group').value = data.policy.group;
    get('cp-present').value = data.policy.presentServices;
    get('cp-ai').checked = data.policy.aiJudgment !== false;
    get('cp-resume').textContent = (data.resume || []).join(' ');
  }
  async function savePolicy() {
    try {
      const d = await request('/api/conversation-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ private: get('cp-private').value, group: get('cp-group').value, presentServices: get('cp-present').value, aiJudgment: get('cp-ai').checked }) });
      showPolicy(d); cpStatus.textContent = 'Enregistré ✓'; setTimeout(() => { cpStatus.textContent = ''; }, 2000);
    } catch (_) { cpStatus.textContent = 'Erreur'; }
  }
  async function saveChannels() {
    try {
      const d = await request('/api/auto-responder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ whatsapp: get('autoreply-wa').checked, telegram: get('autoreply-tg').checked }) });
      if (d.ok) status.textContent = 'Enregistré ✓'; setTimeout(() => { status.textContent = ''; }, 2000);
    } catch (_) { status.textContent = 'Erreur'; }
  }
  toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; toggle.classList.toggle('active', !panel.hidden); });
  get('autoreply-wa').addEventListener('change', saveChannels);
  get('autoreply-tg').addEventListener('change', saveChannels);
  ['cp-private', 'cp-group', 'cp-present', 'cp-ai'].forEach((id) => get(id).addEventListener('change', savePolicy));
  Promise.all([request('/api/auto-responder'), request('/api/conversation-policy')]).then(([a, p]) => {
    if (a.settings) { get('autoreply-wa').checked = !!a.settings.whatsapp; get('autoreply-tg').checked = !!a.settings.telegram; }
    showPolicy(p);
  }).catch(() => {});
})();