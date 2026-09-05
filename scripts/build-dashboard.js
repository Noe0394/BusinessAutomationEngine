// Obscurcissement Frontend (protection de la propriété intellectuelle) :
// prend public/dashboard.html — la source éditée par les développeurs et
// suivie par Git — et produit public/dist/dashboard.html, une copie
// identique sauf pour le contenu de ses balises <script> inline (JavaScript
// côté client), minifié et obscurci via javascript-obfuscator avant d'être
// exposé aux visiteurs.
//
// index.js sert automatiquement ce fichier généré quand il existe (voir
// DASHBOARD_PATH) et retombe sur la source non obscurcie sinon (ex: en
// développement local sans avoir lancé "npm run build") — jamais l'inverse,
// pour ne jamais servir un dashboard "cassé" faute de build.
//
// public/dist/ est un artefact généré (exclu de Git, voir .gitignore) :
// reconstruit à chaque déploiement (voir Dockerfile, "RUN npm run build").
const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SOURCE_PATH = path.join(__dirname, '..', 'public', 'dashboard.html');
const OUT_DIR = path.join(__dirname, '..', 'public', 'dist');
const OUT_PATH = path.join(OUT_DIR, 'dashboard.html');

// Ne capture que les balises <script> SANS attribut src (le JS inline écrit
// pour ce dashboard) — une éventuelle balise <script src="..."> chargeant
// une bibliothèque tierce doit rester intacte.
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;

const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: false, // coût de performance trop élevé pour un dashboard interactif
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  identifierNamesGenerator: 'hexadecimal',
  // Le dashboard n'utilise aucun attribut HTML inline (onclick="...", etc.)
  // qui référencerait une fonction globale par son nom : vérifié via
  // `grep -c 'onclick=\|onchange=\|oninput=\|onsubmit='` sur
  // public/dashboard.html (0 résultat) avant d'activer ce réglage — à
  // revérifier si un futur attribut inline de ce type est ajouté au HTML.
  renameGlobals: true,
  selfDefending: false, // évite les faux positifs avec les outils de dev du navigateur pendant le support client
};

function build() {
  const html = fs.readFileSync(SOURCE_PATH, 'utf8');
  let scriptCount = 0;

  const obfuscatedHtml = html.replace(INLINE_SCRIPT_RE, (match, attrs, code) => {
    if (!code.trim()) {
      return match;
    }
    scriptCount += 1;
    const result = JavaScriptObfuscator.obfuscate(code, OBFUSCATOR_OPTIONS).getObfuscatedCode();
    return `<script${attrs}>${result}</script>`;
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, obfuscatedHtml, 'utf8');

  console.log(`Build Dashboard : ${scriptCount} bloc(s) <script> obscurci(s) → ${path.relative(process.cwd(), OUT_PATH)}`);
}

build();
