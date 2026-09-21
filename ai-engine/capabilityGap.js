// CE QUE JE PEUX / NE PEUX PAS FAIRE — ai-engine/capabilityGap.js
// ---------------------------------------------------------------------------
// Quand une demande d'ACTION n'a pas pu être exécutée, l'utilisateur doit savoir POURQUOI et quoi faire :
//   • une fonction existe et correspond → « je peux le faire avec … : précisez … » ;
//   • aucune fonction ne correspond → « cette action ne fait pas partie de mes fonctions actuelles » + ce qui s'en approche.
// Le rapprochement se fait sur le registre RÉEL des outils (noms + descriptions), jamais sur une liste écrite à la main.
const WRITE_VERB_RE = /\b(?:supprim\w*|effac\w*|retir\w*|enl[èe]v\w*|d[ée]truis\w*|cr[ée]e\w*|cr[ée]er|ajout\w*|enregistr\w*|import\w*|envoi\w*|envoy\w+|[ée]cri\w+|lance\w*|programm\w*|planifi\w*|modifi\w*|renomm\w*|chang\w*|mets?|met\b|mettre|corrig\w*|remplac\w*|activ\w*|d[ée]sactiv\w*|pause\w*|arr[êe]t\w*|stopp\w*|annul\w*|restaur\w*|publi\w*|g[ée]n[èe]r\w*|configur\w*|connect\w*|d[ée]connect\w*|valid\w*|refus\w*|relanc\w*|d[ée]sinscri\w*|bloqu\w*|d[ée]bloqu\w*|tag\w*|[ée]tiquet\w*|fusionn\w*|d[ée]dupliqu\w*|exporte\w*|t[ée]l[ée]charg\w*|synchronis\w*|sauvegard\w*|transf[ée]r\w*|d[ée]plac\w*|copi\w*|dupliqu\w*|inscri\w+|r[ée]serv\w+|command\w+|factur\w+|pay\w+|rembours\w+|livr\w+|connect\w+|branch\w+)\b/i;

const STOP = new Set('les des une mon mes son ses aux avec pour dans sur par est sont que qui quoi tout tous toute cette ces leur plus moins tres bien fait faire peux peut veux voudrais svp stp merci cyrus'.split(' '));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (s) => norm(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
const stem = (w) => w.replace(/(ations?|ateurs?|ements?|tions?|eurs?|ees?|es|s|er|ir|e)$/, '');

function isActionRequest(text) { return WRITE_VERB_RE.test(String(text || '')); }

// Outils les plus proches de la demande (score = mots communs entre la demande et « nom + description » de l'outil).
function closestTools(request, tools, opts) {
  const o = opts || {}; const reqStems = new Set(words(request).map(stem));
  const scored = [];
  for (const t of tools || []) {
    if (o.writeOnly && (t.risk || 'READ') === 'READ') continue;
    const toolStems = new Set(words(`${t.name} ${t.description}`.replace(/([a-z])([A-Z])/g, '$1 $2')).map(stem));
    let hit = 0; for (const w of reqStems) if (toolStems.has(w)) hit += 1;
    if (hit > 0) scored.push({ name: t.name, description: String(t.description || '').split('.')[0].slice(0, 140), risk: t.risk || 'READ', score: hit });
  }
  return scored.sort((a, z) => z.score - a.score).slice(0, o.limit || 3);
}

// Message clair pour une demande d'action NON exécutée. `tools` = registre visible pour cet utilisateur (toolRegistry.list / describe).
function explain(request, tools) {
  const close = closestTools(request, tools, { writeOnly: true, limit: 3 });
  const strong = close.filter((c) => c.score >= 2);
  const head = "Je n'ai rien exécuté : aucune action n'a été lancée et vérifiée, donc je ne peux pas la déclarer faite.";
  if (strong.length) {
    return `${head}\nCette demande correspond à ${strong.length > 1 ? 'mes fonctions' : 'ma fonction'} ${strong.map((c) => `« ${c.name} » (${c.description})`).join(' ou ')}. Reformulez-la en précisant ce qu'il faut (nom, valeur, destinataire…) et je l'exécute, puis je vous confirme avec la preuve.`;
  }
  if (close.length) {
    return `${head}\nJe n'ai pas de fonction qui fasse exactement cela. Ce qui s'en approche : ${close.map((c) => `« ${c.name} » (${c.description})`).join(' ; ')}. Dites-moi si l'une d'elles convient.`;
  }
  return `${head}\nCette action ne fait pas partie de mes fonctions actuelles : je préfère vous le dire plutôt que de prétendre l'avoir faite. Demandez-moi « que peux-tu faire ? » pour voir tout ce que je sais exécuter.`;
}

module.exports = { WRITE_VERB_RE, isActionRequest, closestTools, explain };
