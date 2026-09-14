const PDFDocument = require('pdfkit');

// Génère un ebook/livre complet au format PDF — couverture, sommaire avec
// numéros de page réels, préface/introduction, chapitres (avec citation,
// conseil d'expert et images d'illustration en encadrés visuels) et
// conclusion, filigrane et pied de page numéroté sur toutes les pages sauf
// la couverture. Aucune dépendance réseau : pdfkit compose le PDF
// entièrement en mémoire (voir generateEbookPdf, qui résout un Buffer).
//
// Forme attendue de `spec` (voir index.js#POST /api/ebooks/generate pour la
// construction à partir du formulaire) :
// {
//   title: string, subtitle?: string, author?: string, date?: string,
//   watermarkText?: string,
//   coverImageBuffer?: Buffer, logoImageBuffer?: Buffer,
//   introduction?: string,
//   chapters: [{ title: string, content: string,
//                quote?: { text: string, author?: string }, tip?: string,
//                images?: Buffer[] }],
//   conclusion?: string,
// }
//
// Technique du sommaire à numéros de page réels : `bufferPages: true`
// permet de revenir (switchToPage) sur une page déjà écrite AVANT d'appeler
// doc.end() — on réserve donc des pages de Sommaire vides juste après la
// couverture, on écrit tout le reste du livre en notant l'index de PREMIÈRE
// page de chaque section, puis on revient remplir le Sommaire avec ces
// numéros, et enfin on repasse sur CHAQUE page pour y ajouter filigrane et
// pied de page numéroté (les seuls éléments communs à toutes les pages).

const PAGE_MARGINS = { top: 90, bottom: 70, left: 64, right: 64 };
const COLORS = {
  heading: '#1a1a2e',
  accent: '#6c4fd6',
  body: '#333333',
  muted: '#8a8a8a',
  calloutBg: '#f6f3ff',
  calloutBorder: '#ded6fb',
  tipBg: '#fff8e1',
  tipBorder: '#ffca28',
};
const TOC_LINES_PER_PAGE = 26;

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function pageIndexCount(doc) {
  return doc.bufferedPageRange().count;
}

// ---------- Couverture ----------
function addCoverPage(doc, spec) {
  doc.addPage();
  const { width, height } = doc.page;

  if (spec.coverImageBuffer) {
    try {
      doc.image(spec.coverImageBuffer, 0, 0, { cover: [width, height] });
      doc.save();
      doc.fillOpacity(0.45).rect(0, 0, width, height).fill('#0b0b1a');
      doc.restore();
    } catch (err) {
      doc.rect(0, 0, width, height).fill('#1a1a2e');
    }
  } else {
    doc.rect(0, 0, width, height).fill('#1a1a2e');
  }

  const textWidth = width - 140;
  let y = height / 2 - 130;

  if (spec.logoImageBuffer) {
    try {
      doc.image(spec.logoImageBuffer, width / 2 - 40, y - 90, { fit: [80, 80] });
    } catch (err) {
      // logo invalide : on continue sans, la couverture reste utilisable.
    }
  }

  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(32)
    .text(spec.title || 'Sans titre', 70, y, { width: textWidth, align: 'center' });
  y = doc.y + 14;

  if (spec.subtitle) {
    doc.font('Helvetica').fontSize(16).fillColor('#e6e2fb')
      .text(spec.subtitle, 70, y, { width: textWidth, align: 'center' });
    y = doc.y + 30;
  } else {
    y += 24;
  }

  if (spec.author) {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff')
      .text(`Par ${spec.author}`, 70, y, { width: textWidth, align: 'center' });
    y = doc.y + 8;
  }
  if (spec.date) {
    doc.font('Helvetica').fontSize(11).fillColor('#cfcaf0')
      .text(spec.date, 70, y, { width: textWidth, align: 'center' });
  }
}

// ---------- Sommaire (pages réservées puis remplies en fin de génération) ----------
function reserveTocPages(doc, entryCount) {
  const pagesNeeded = Math.max(1, Math.ceil((entryCount + 2) / TOC_LINES_PER_PAGE));
  const startIndex = pageIndexCount(doc);
  for (let i = 0; i < pagesNeeded; i += 1) doc.addPage();
  return { startIndex, pagesNeeded };
}

function fillToc(doc, toc, entries) {
  let currentPage = toc.startIndex;
  doc.switchToPage(currentPage);
  doc.font('Helvetica-Bold').fontSize(22).fillColor(COLORS.heading)
    .text('Sommaire', doc.page.margins.left, doc.page.margins.top, { width: contentWidth(doc) });
  let y = doc.y + 20;

  entries.forEach((entry) => {
    if (y > doc.page.height - doc.page.margins.bottom - 20) {
      if (currentPage < toc.startIndex + toc.pagesNeeded - 1) {
        currentPage += 1;
        doc.switchToPage(currentPage);
        y = doc.page.margins.top;
      }
    }

    const pageNumX = doc.page.width - doc.page.margins.right - 34;
    const titleWidth = pageNumX - doc.page.margins.left - 10;
    doc.font('Helvetica').fontSize(11.5).fillColor(COLORS.body)
      .text(entry.label, doc.page.margins.left, y, { width: titleWidth });
    const afterTitleY = doc.y;
    doc.text(String(entry.page), pageNumX, y, { width: 34, align: 'right' });
    y = Math.max(afterTitleY, y + 15) + 6;
  });
}

// ---------- Sections texte génériques (préface, conclusion) ----------
function addTextSection(doc, heading, body) {
  const startIndex = pageIndexCount(doc);
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(22).fillColor(COLORS.heading).text(heading);
  doc.moveDown(1);
  doc.font('Helvetica').fontSize(11.5).fillColor(COLORS.body)
    .text(body || '', { align: 'justify', lineGap: 4 });
  return startIndex;
}

// ---------- Encadré visuel (citation / conseil d'expert) ----------
function addCallout(doc, text, bg, border) {
  const x = doc.page.margins.left;
  const width = contentWidth(doc);
  const padding = 12;
  doc.font('Helvetica-Oblique').fontSize(11);
  const textHeight = doc.heightOfString(text, { width: width - padding * 2 });
  const boxHeight = textHeight + padding * 2;

  if (doc.y + boxHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }

  const y = doc.y;
  doc.roundedRect(x, y, width, boxHeight, 6).fillAndStroke(bg, border);
  doc.fillColor(COLORS.body).font('Helvetica-Oblique').fontSize(11)
    .text(text, x + padding, y + padding, { width: width - padding * 2 });
  doc.x = x;
  doc.y = y + boxHeight + 12;
}

// ---------- Chapitre (titre, corps, citation, conseil, images) ----------
function addChapter(doc, chapter, chapterNumber) {
  const startIndex = pageIndexCount(doc);
  doc.addPage();

  doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.accent)
    .text(`CHAPITRE ${chapterNumber}`);
  doc.font('Helvetica-Bold').fontSize(23).fillColor(COLORS.heading)
    .text(chapter.title || `Chapitre ${chapterNumber}`);
  doc.moveDown(1);

  doc.font('Helvetica').fontSize(11.5).fillColor(COLORS.body)
    .text(chapter.content || '', { align: 'justify', lineGap: 4 });

  if (chapter.quote && chapter.quote.text) {
    doc.moveDown(1);
    const quoteText = `❝ ${chapter.quote.text} ❞${chapter.quote.author ? `\n— ${chapter.quote.author}` : ''}`;
    addCallout(doc, quoteText, COLORS.calloutBg, COLORS.calloutBorder);
  }

  if (chapter.tip) {
    doc.moveDown(0.5);
    addCallout(doc, `💡 Conseil d'expert : ${chapter.tip}`, COLORS.tipBg, COLORS.tipBorder);
  }

  (chapter.images || []).forEach((imgBuffer) => {
    try {
      doc.moveDown(0.5);
      if (doc.y > doc.page.height - doc.page.margins.bottom - 180) {
        doc.addPage();
      }
      const maxWidth = contentWidth(doc);
      const x = doc.page.margins.left + (maxWidth - Math.min(maxWidth, 320)) / 2;
      doc.image(imgBuffer, x, doc.y, { fit: [Math.min(maxWidth, 320), 280] });
      doc.moveDown(14);
    } catch (err) {
      // Image invalide/corrompue : ignorée plutôt que de faire échouer tout le PDF.
    }
  });

  return startIndex;
}

// ---------- Filigrane, en-tête et pied de page (passe finale, toutes pages sauf couverture) ----------
function addWatermark(doc, text) {
  if (!text) return;
  const { width, height } = doc.page;
  doc.save();
  doc.rotate(-45, { origin: [width / 2, height / 2] });
  doc.fillOpacity(0.07).fillColor('#000000').font('Helvetica-Bold').fontSize(54)
    .text(text, 0, height / 2 - 30, { width, align: 'center' });
  doc.restore();
}

function addHeaderFooter(doc, printedNumber, spec) {
  const width = contentWidth(doc);
  doc.fillOpacity(1).font('Helvetica').fontSize(9).fillColor(COLORS.muted)
    .text(spec.title || '', doc.page.margins.left, 32, { width, align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted)
    .text(String(printedNumber), doc.page.margins.left, doc.page.height - 46, { width, align: 'center' });
}

function finalizePages(doc, spec) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    if (i === 0) continue; // couverture : ni filigrane ni pied de page.
    doc.switchToPage(i);
    addWatermark(doc, spec.watermarkText);
    addHeaderFooter(doc, i, spec);
  }
}

function generateEbookPdf(spec) {
  return new Promise((resolve, reject) => {
    let doc;
    try {
      doc = new PDFDocument({ size: 'A4', margins: PAGE_MARGINS, bufferPages: true, autoFirstPage: false });
    } catch (err) {
      reject(err);
      return;
    }

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      addCoverPage(doc, spec);

      const chapters = Array.isArray(spec.chapters) ? spec.chapters : [];
      const entryCount = (spec.introduction ? 1 : 0) + chapters.length + (spec.conclusion ? 1 : 0);
      const toc = reserveTocPages(doc, entryCount);

      const tocEntries = [];
      if (spec.introduction) {
        const page = addTextSection(doc, 'Préface / Introduction', spec.introduction);
        tocEntries.push({ label: 'Préface / Introduction', page });
      }
      chapters.forEach((chapter, idx) => {
        const page = addChapter(doc, chapter, idx + 1);
        tocEntries.push({ label: `${idx + 1}. ${chapter.title || `Chapitre ${idx + 1}`}`, page });
      });
      if (spec.conclusion) {
        const page = addTextSection(doc, 'Conclusion', spec.conclusion);
        tocEntries.push({ label: 'Conclusion', page });
      }

      fillToc(doc, toc, tocEntries);
      finalizePages(doc, spec);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateEbookPdf };
