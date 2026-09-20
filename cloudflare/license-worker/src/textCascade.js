// Cascade IA texte du Worker (mêmes fournisseurs que firebase-functions) : le
// premier fournisseur dont la clé est définie ET qui répond l'emporte ; Pollinations
// (sans clé) garantit une réponse. Les clés vivent en secrets Cloudflare, jamais côté client.

const SYSTEM = 'Tu es CYRUS, un assistant commercial et administratif. Réponds toujours avec un ton humain, chaleureux et direct — jamais robotique. Sois concis et concret.';
const TIMEOUT_MS = 25000;

async function post(fetchFn, url, body, headers) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

const chat = (url, model, keyName) => async (prompt, env, fetchFn) => {
  if (!env[keyName]) return null;
  const data = await post(fetchFn, url, { model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] }, { authorization: `Bearer ${env[keyName]}` });
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('réponse vide');
  return String(text).trim();
};

const PROVIDERS = [
  ['groq', chat('https://api.groq.com/openai/v1/chat/completions', 'openai/gpt-oss-120b', 'GROQ_API_KEY')],
  ['gemini', async (prompt, env, fetchFn) => {
    if (!env.GEMINI_API_KEY) return null;
    const data = await post(fetchFn, `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${env.GEMINI_API_KEY}`, { contents: [{ role: 'user', parts: [{ text: prompt }] }], systemInstruction: { parts: [{ text: SYSTEM }] } }, {});
    const text = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0].text;
    if (!text) throw new Error('réponse vide');
    return String(text).trim();
  }],
  ['deepseek', chat('https://api.deepseek.com/chat/completions', 'deepseek-chat', 'DEEPSEEK_API_KEY')],
  ['openrouter', (p, env, f) => chat('https://openrouter.ai/api/v1/chat/completions', env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free', 'OPENROUTER_API_KEY')(p, env, f)],
  ['huggingface', chat('https://router.huggingface.co/v1/chat/completions', 'Qwen/Qwen2.5-72B-Instruct', 'HUGGINGFACE_API_KEY')],
  ['workers-ai', async (prompt, env) => {
    if (!env.AI || typeof env.AI.run !== 'function') return null;
    const out = await env.AI.run(env.WORKERS_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] });
    const text = out && (out.response || out.result || '');
    if (!text) throw new Error('réponse vide');
    return String(text).trim();
  }],
  ['pollinations', async (prompt, env, fetchFn) => {
    const res = await fetchFn(`https://text.pollinations.ai/${encodeURIComponent(`${SYSTEM}\n\nUtilisateur: ${prompt}\nAssistant:`)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = (await res.text()).trim();
    if (!text) throw new Error('réponse vide');
    return text;
  }],
];

const ERR_RE = /(doesn't have enough credits|does not have enough credits|top up|complete a quest|insufficient (?:credit|quota|balance)|rate.?limit|too many requests|quota (?:exceeded|exhausted)|invalid api key|unauthorized)/i;

export async function runTextCascade(prompt, env, fetchFn) {
  const f = fetchFn || fetch;
  const errors = [];
  for (const [name, call] of PROVIDERS) {
    try {
      const text = await call(prompt, env, f);
      if (text === null) continue; // clé absente : niveau sauté
      if (text.length < 600 && ERR_RE.test(text)) throw new Error('réponse assimilable à une erreur');
      return { text, provider: `${name} (Cloudflare)` };
    } catch (err) { errors.push(`${name}: ${err.message}`); }
  }
  const e = new Error(`Tous les fournisseurs ont échoué : ${errors.join(' | ')}`);
  e.errors = errors;
  throw e;
}
