const fs = require('fs');
const path = require('path');
const satori = require('satori').default;
const { Resvg } = require('@resvg/resvg-js');

// MOTEUR DE TEMPLATES D'AFFICHES — remplace l'ancien habillage ffmpeg
// drawtext (voir imageCompositorEngine.js, conservé pour compat mais plus
// utilisé par le flux Chat-First par défaut) : drawtext ne sait poser QUE du
// texte plat à une position fixe — aucune icône, aucune liste à puces,
// aucun bandeau de prix, aucun en-tête logo+marque structuré, contrairement
// aux exemples professionnels fournis par l'utilisateur (RUA Africa, Chance
// Market Bio...). satori (rendu façon CSS flexbox -> SVG) + resvg
// (rasterisation SVG -> PNG) permettent de construire de VRAIS templates de
// graphiste, sans dépendance à un navigateur/Chromium (voir Dockerfile —
// disque du VPS trop petit pour Puppeteer, déjà rencontré ce jour) : les
// deux paquets sont légers (quelques Mo, binaires précompilés).
//
// Chaque template est une fonction pure (data) -> arbre d'éléments
// "satori" (même forme qu'un élément React : {type, props: {style,
// children}}) — voir le helper h() ci-dessous, utilisé à la place de
// JSX/React pour ne pas ajouter cette dépendance seulement pour ce fichier.

const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const FONT_REGULAR = fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans.ttf'));
const FONT_BOLD = fs.readFileSync(path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'));

const CANVAS_WIDTH = 1080;
const MIN_CANVAS_HEIGHT = 760;
const MAX_CANVAS_HEIGHT = 1500;

// Hauteur du canevas CALCULÉE à partir du contenu réel plutôt que fixe : un
// format toujours ultra-haut (1350px) laissait un grand vide blanc en bas
// dès qu'il y avait peu de points/pas de photo (constaté en test réel) —
// une affiche avec 3 puces et sans photo n'a pas besoin de la même hauteur
// qu'une avec 7 puces et une photo pleine largeur. Approximatif (pas de
// vraie passe de mise en page avant le rendu satori), volontairement
// arrondi par excès et borné [MIN,MAX] plutôt que précis au pixel près.
const BULLET_ROW_HEIGHT = 70;
function computeCanvasHeight(template, data) {
  const bulletCount = Array.isArray(data.bulletPoints) ? data.bulletPoints.length : 0;
  const HEADER = 170;
  const FOOTER = 110;
  const bulletsHeight = bulletCount * BULLET_ROW_HEIGHT + 20;

  let contentHeight;
  if (template === 'promo_price') {
    contentHeight = 120 + 300 + bulletsHeight; // tagline + bandeau prix géant
  } else if (template === 'event') {
    contentHeight = 150 + (data.photoDataUri ? 460 : 0) + 110 + bulletsHeight;
  } else if (template === 'product_photo') {
    contentHeight = (data.photoDataUri ? 600 : 0) + 180 + Math.min(bulletCount, 5) * BULLET_ROW_HEIGHT + 20;
  } else {
    contentHeight = 220 + bulletsHeight; // icons_list : bandeau titre/prix
  }

  const total = HEADER + contentHeight + FOOTER;
  return Math.max(MIN_CANVAS_HEIGHT, Math.min(MAX_CANVAS_HEIGHT, Math.round(total)));
}

// Palettes de couleurs par thème — les valeurs "accent"/"accentDark" pilotent
// l'en-tête, le bandeau de prix et le pied de page ; "bg"/"text" le fond et
// le texte des sections neutres. Un thème non reconnu retombe sur "green".
const THEMES = {
  green: { accent: '#1a7a3c', accentDark: '#0f4f26', accentSoft: '#e8f7ee', gold: '#f4b400' },
  blue: { accent: '#1a4fa0', accentDark: '#0f2f66', accentSoft: '#e8f0fb', gold: '#f4b400' },
  red: { accent: '#b3261e', accentDark: '#7a1a15', accentSoft: '#fbeceb', gold: '#f4b400' },
  purple: { accent: '#6c4fd6', accentDark: '#432f8f', accentSoft: '#efeafc', gold: '#f4b400' },
  brown: { accent: '#6b4226', accentDark: '#432a18', accentSoft: '#f4ece4', gold: '#f4b400' },
};

function theme(name) {
  return THEMES[name] || THEMES.green;
}

// Helper façon "hyperscript" — évite d'ajouter React/JSX pour ce seul
// fichier. `props.style` doit toujours inclure `display` (flex par défaut
// ci-dessous) : satori, contrairement à un navigateur, n'applique JAMAIS de
// display:block implicite sur un <div> — l'omettre fait disparaître
// silencieusement tout le sous-arbre.
function h(type, props, ...children) {
  const { style, ...rest } = props || {};
  return {
    type,
    props: {
      ...rest,
      style: { display: 'flex', ...style },
      children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    },
  };
}

function truncate(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Initiales du logo de secours (1-2 lettres, JAMAIS tronquées avec "…" —
// contrairement à truncate() ci-dessus, pensé pour du texte long) : "Chez
// Cyrus" -> "CC", "RUA" -> "R".
function initials(businessName) {
  const words = String(businessName || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Icône = simple cercle coloré + glyphe texte (✓ par défaut) — DejaVu Sans
// couvre les symboles courants (✓ ★ ➤ •) mais PAS les émojis couleur :
// n'importe quel émoji fourni par l'IA dans bulletPoints[].icon est donc
// systématiquement remplacé par ce glyphe neutre plutôt que de risquer un
// caractère manquant (rendu en tofu/carré vide par satori).
function iconBadge(bgColor, size) {
  return h('div', {
    style: {
      width: size, height: size, borderRadius: size / 2, background: bgColor,
      alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    },
  }, h('span', { style: { color: '#fff', fontSize: size * 0.55, fontWeight: 700, fontFamily: 'DejaVu Sans Bold' } }, '✓'));
}

function header(data, th) {
  return h('div', {
    style: {
      alignItems: 'center', justifyContent: 'space-between', padding: '36px 48px 24px',
    },
  },
  h('div', { style: { alignItems: 'center' } },
    data.logoDataUri
      ? h('img', { src: data.logoDataUri, style: { width: 84, height: 84, borderRadius: 16, objectFit: 'contain' } })
      : h('div', {
        style: {
          width: 84, height: 84, borderRadius: 16, background: th.accent, alignItems: 'center', justifyContent: 'center',
        },
      }, h('span', { style: { color: '#fff', fontSize: 34, fontWeight: 700, fontFamily: 'DejaVu Sans Bold' } }, initials(data.businessName))),
    h('div', { style: { flexDirection: 'column', marginLeft: 20 } },
      h('span', { style: { fontSize: 30, fontWeight: 700, color: th.accentDark, fontFamily: 'DejaVu Sans Bold' } }, truncate(data.businessName, 26)))),
  data.badgeText
    ? h('div', {
      style: {
        background: th.gold, borderRadius: 999, padding: '14px 26px', alignItems: 'center',
      },
    }, h('span', { style: { color: '#1a1a1a', fontSize: 24, fontWeight: 700, fontFamily: 'DejaVu Sans Bold' } }, truncate(data.badgeText, 22)))
    : null);
}

function footer(data, th) {
  return h('div', {
    style: {
      background: th.accentDark, padding: '28px 48px', alignItems: 'center', justifyContent: 'center',
    },
  }, h('span', { style: { color: '#fff', fontSize: 26, fontWeight: 700, fontFamily: 'DejaVu Sans Bold' } }, truncate(data.contactText || '', 60)));
}

function bulletList(bulletPoints, th, options) {
  const opts = options || {};
  const items = (Array.isArray(bulletPoints) ? bulletPoints : []).slice(0, opts.max || 6);
  return h('div', { style: { flexDirection: 'column', width: '100%' } },
    items.map((bp) => h('div', {
      style: {
        alignItems: 'center', marginBottom: 22, width: '100%',
      },
    },
    iconBadge(th.accent, 48),
    h('span', {
      style: {
        marginLeft: 18, fontSize: 27, color: '#222', fontFamily: 'DejaVu Sans', flex: 1,
      },
    }, truncate(bp && bp.text, 58)))));
}

// ---------- Template "icons_list" (en-tête + titre + liste à puces + prix)
// ---------- inspiré des exemples RUA Africa / Business Automation Engine :
// pas de photo hero, tout l'espace sert la structure (offre + bénéfices).
function buildIconsListTemplate(data, canvasHeight) {
  const th = theme(data.colorTheme);
  return h('div', {
    style: {
      width: CANVAS_WIDTH, height: canvasHeight, flexDirection: 'column', background: '#ffffff', fontFamily: 'DejaVu Sans',
    },
  },
  header(data, th),
  h('div', {
    style: {
      background: th.accent, margin: '0 48px 32px', borderRadius: 20, padding: '32px 40px', flexDirection: 'column',
    },
  },
  h('span', { style: { color: '#fff', fontSize: 40, fontWeight: 700, fontFamily: 'DejaVu Sans Bold', lineHeight: 1.15 } }, truncate(data.tagline || data.summary, 70)),
  data.priceText ? h('span', { style: { color: th.gold, fontSize: 46, fontWeight: 700, marginTop: 14, fontFamily: 'DejaVu Sans Bold' } }, truncate(data.priceText, 24)) : null),
  h('div', { style: { flexDirection: 'column', padding: '0 48px', flex: 1 } }, bulletList(data.bulletPoints, th, { max: 7 })),
  footer(data, th));
}

// ---------- Template "product_photo" (photo produit + bénéfices) ----------
// inspiré des exemples Chance Market Bio / Mamie's Délices : la photo
// générée par FLUX/Pollinations occupe la moitié supérieure, la liste de
// bénéfices et le contact en dessous.
function buildProductPhotoTemplate(data, canvasHeight) {
  const th = theme(data.colorTheme);
  return h('div', {
    style: {
      width: CANVAS_WIDTH, height: canvasHeight, flexDirection: 'column', background: '#ffffff', fontFamily: 'DejaVu Sans',
    },
  },
  header(data, th),
  data.photoDataUri
    ? h('div', {
      style: {
        margin: '0 48px 28px', borderRadius: 24, overflow: 'hidden', height: 560, width: CANVAS_WIDTH - 96,
      },
    }, h('img', {
      src: data.photoDataUri, style: { width: '100%', height: '100%', objectFit: 'cover' },
    }))
    : null,
  h('div', {
    style: {
      background: th.accentSoft, margin: '0 48px 24px', borderRadius: 20, padding: '26px 34px', flexDirection: 'column',
    },
  },
  h('span', { style: { color: th.accentDark, fontSize: 36, fontWeight: 700, fontFamily: 'DejaVu Sans Bold', lineHeight: 1.15 } }, truncate(data.tagline || data.summary, 60)),
  data.priceText ? h('span', { style: { color: th.accent, fontSize: 38, fontWeight: 700, marginTop: 10, fontFamily: 'DejaVu Sans Bold' } }, truncate(data.priceText, 24)) : null),
  h('div', { style: { flexDirection: 'column', padding: '0 48px', flex: 1 } }, bulletList(data.bulletPoints, th, { max: 5 })),
  footer(data, th));
}

// ---------- Template "promo_price" (prix géant en vedette) ----------
// inspiré de l'exemple RUA Africa ("2500 FCFA SEULEMENT") : le prix/l'offre
// domine visuellement la composition — pour une promotion agressive où le
// chiffre EST l'accroche, pas seulement une ligne d'info parmi d'autres.
function buildPromoPriceTemplate(data, canvasHeight) {
  const th = theme(data.colorTheme);
  return h('div', {
    style: {
      width: CANVAS_WIDTH, height: canvasHeight, flexDirection: 'column', background: '#ffffff', fontFamily: 'DejaVu Sans',
    },
  },
  header(data, th),
  h('div', { style: { flexDirection: 'column', padding: '0 48px 20px' } },
    h('span', { style: { fontSize: 34, fontWeight: 700, color: '#222', fontFamily: 'DejaVu Sans Bold', lineHeight: 1.2 } }, truncate(data.tagline || data.summary, 60))),
  h('div', {
    style: {
      background: th.accent, margin: '0 48px 28px', borderRadius: 28, padding: '48px 24px', alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
    },
  },
  data.badgeText ? h('span', { style: { color: th.gold, fontSize: 30, fontWeight: 700, fontFamily: 'DejaVu Sans Bold', marginBottom: 8 } }, truncate(data.badgeText, 20)) : null,
  h('span', { style: { color: '#fff', fontSize: 96, fontWeight: 700, fontFamily: 'DejaVu Sans Bold' } }, truncate(data.priceText || '', 18)),
  h('span', { style: { color: th.accentSoft, fontSize: 26, marginTop: 6, fontFamily: 'DejaVu Sans' } }, 'Offre à saisir maintenant')),
  h('div', { style: { flexDirection: 'column', padding: '0 48px', flex: 1 } }, bulletList(data.bulletPoints, th, { max: 4 })),
  footer(data, th));
}

// ---------- Template "event" (webinaire/atelier) ----------
// inspiré de l'exemple "Comment ouvrir une boutique virtuelle" (Zoom) :
// date/heure mises en avant comme des badges, photo en pleine hauteur
// optionnelle, liste de points-clés en bas plutôt qu'en icônes verticales.
function buildEventTemplate(data, canvasHeight) {
  const th = theme(data.colorTheme);
  return h('div', {
    style: {
      width: CANVAS_WIDTH, height: canvasHeight, flexDirection: 'column', background: th.accentDark, fontFamily: 'DejaVu Sans',
    },
  },
  header(data, th),
  h('div', { style: { flexDirection: 'column', padding: '0 48px 24px' } },
    h('span', { style: { color: '#fff', fontSize: 46, fontWeight: 700, fontFamily: 'DejaVu Sans Bold', lineHeight: 1.15 } }, truncate(data.tagline || data.summary, 55))),
  data.photoDataUri
    ? h('div', {
      style: {
        margin: '0 48px 24px', borderRadius: 24, overflow: 'hidden', height: 420, width: CANVAS_WIDTH - 96,
      },
    }, h('img', { src: data.photoDataUri, style: { width: '100%', height: '100%', objectFit: 'cover' } }))
    : null,
  h('div', { style: { padding: '0 48px 24px', justifyContent: 'center' } },
    data.badgeText ? h('div', {
      style: {
        background: th.gold, borderRadius: 16, padding: '18px 32px', marginRight: 16, alignItems: 'center',
      },
    }, h('span', { style: { color: '#1a1a1a', fontSize: 28, fontWeight: 700, fontFamily: 'DejaVu Sans Bold' } }, truncate(data.badgeText, 24))) : null,
    data.priceText ? h('div', {
      style: {
        background: '#ffffff', borderRadius: 16, padding: '18px 32px', alignItems: 'center',
      },
    }, h('span', { style: { color: th.accentDark, fontSize: 28, fontWeight: 700, fontFamily: 'DejaVu Sans Bold' } }, truncate(data.priceText, 24))) : null),
  h('div', { style: { flexDirection: 'column', padding: '0 48px', flex: 1 } }, bulletList(data.bulletPoints, { ...th, accent: th.gold }, { max: 4 })),
  footer(data, th));
}

const TEMPLATES = {
  icons_list: buildIconsListTemplate,
  promo_price: buildPromoPriceTemplate,
  event: buildEventTemplate,
  product_photo: buildProductPhotoTemplate,
};

// data : { template, businessName, tagline|summary, bulletPoints:[{text}],
// priceText, badgeText, contactText, colorTheme, logoDataUri, photoDataUri }
// Retourne un buffer PNG prêt à être servi/envoyé (voir index.js).
async function renderPoster(data) {
  const templateName = TEMPLATES[data.template] ? data.template : 'icons_list';
  const build = TEMPLATES[templateName];
  const canvasHeight = computeCanvasHeight(templateName, data);
  const element = build(data, canvasHeight);

  const svg = await satori(element, {
    width: CANVAS_WIDTH,
    height: canvasHeight,
    fonts: [
      { name: 'DejaVu Sans', data: FONT_REGULAR, weight: 400, style: 'normal' },
      { name: 'DejaVu Sans Bold', data: FONT_BOLD, weight: 700, style: 'normal' },
    ],
  });

  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: CANVAS_WIDTH } });
  const pngData = resvg.render();
  return pngData.asPng();
}

function bufferToDataUri(buffer, mimetype) {
  if (!buffer) return null;
  return `data:${mimetype || 'image/jpeg'};base64,${buffer.toString('base64')}`;
}

module.exports = {
  renderPoster,
  bufferToDataUri,
  TEMPLATES: Object.keys(TEMPLATES),
};
