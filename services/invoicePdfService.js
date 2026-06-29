const PDFDocument = require('pdfkit');
const https = require('https');
const http = require('http');

/**
 * Renders an invoice to a premium, COMPACT PDF Buffer (one tight page, not a
 * sprawling A4). Three brand designs share a refined layout system:
 *
 *   design 1 — Classic:    crimson header band, serif headings, clean ledger.
 *   design 2 — Modern:     minimal, gold hairline accents, lots of whitespace.
 *   design 3 — Devotional:  cream canvas, gold double-frame, om watermark.
 *
 * Dependency-free (pdfkit built-in fonts) so it stays VPS-light.
 */

const RED = '#C0392B';
const RED_DEEP = '#9E2A1E';
const GOLD = '#C99A3D';
const GOLD_SOFT = '#E8D6A8';
const CREAM = '#FBF6EF';
const STRIPE = '#F6EFE4';
const INK = '#1F1A17';
const MUTED = '#8A7F76';
const LINE = '#E7DCCB';

function fetchImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(6000, () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

const money = (n) => 'INR ' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => new Date(d || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

async function render(invoice, tpl = {}) {
  const logoBuf = await fetchImage(tpl.logo);
  const design = tpl.design || 1;
  // Compact page: A4 width, but height trimmed to the content so it never
  // looks like a near-empty A4 sheet. ~ receipt-tall, invoice-wide.
  const W = 420; // points (~148mm)
  const rows = (invoice.items || []).length;
  const H = design === 3 ? 560 + rows * 22 : 500 + rows * 22;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: [W, H], margin: 0 });
      const chunks = [];
      doc.on('data', (d) => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      if (design === 3) drawDevotional(doc, invoice, tpl, logoBuf, W, H);
      else if (design === 2) drawModern(doc, invoice, tpl, logoBuf, W, H);
      else drawClassic(doc, invoice, tpl, logoBuf, W, H);
      doc.end();
    } catch (e) { reject(e); }
  });
}

function sellerLines(tpl) {
  // One field per line — combining phone+email overflowed the 175px column and
  // collided with the GSTIN line below.
  return [
    tpl.addressLine1, tpl.addressLine2,
    [tpl.city, tpl.state, tpl.pincode].filter(Boolean).join(', '),
    tpl.phone ? `Ph ${tpl.phone}` : null,
    tpl.email || null,
    tpl.gstin ? `GSTIN ${tpl.gstin}` : null,
  ].filter(Boolean);
}

// Always renders a logo mark: the uploaded image if present, else a branded
// placeholder badge (gold ring + business initial) so no invoice looks bare.
// `onDark` styles the placeholder for a colored header band.
function drawLogo(doc, logoBuf, x, y, size, opts = {}) {
  if (logoBuf) { try { doc.image(logoBuf, x, y, { fit: [size, size] }); return true; } catch { /* fall through */ } }
  const { onDark = false, initial = 'R' } = opts;
  const r = size / 2, cx = x + r, cy = y + r;
  doc.save();
  if (onDark) {
    // On a red band: soft white disc with a gold ring.
    doc.circle(cx, cy, r).fill('#FFFFFF').opacity(0.14).circle(cx, cy, r).fill('#FFFFFF');
    doc.opacity(1).lineWidth(1.5).strokeColor(GOLD).circle(cx, cy, r - 2).stroke();
    doc.fillColor('#FFFFFF');
  } else {
    doc.circle(cx, cy, r).fill('#FBF3DF');
    doc.lineWidth(1.5).strokeColor(GOLD).circle(cx, cy, r - 2).stroke();
    doc.fillColor(RED);
  }
  doc.font('Times-Bold').fontSize(size * 0.5).text(initial, x, cy - size * 0.32, { width: size, align: 'center' });
  doc.restore();
  return true; // placeholder counts as a logo so layout stays consistent
}

// Compact items table. `theme`: {head, headText, stripe}.
function itemsTable(doc, invoice, x, y, w, theme) {
  const qtyX = x + w - 150, rateX = x + w - 110, totX = x + w - 56;
  const H = 20;
  doc.roundedRect(x, y, w, H, 4).fill(theme.head);
  doc.fillColor(theme.headText).font('Helvetica-Bold').fontSize(7.5);
  doc.text('DESCRIPTION', x + 10, y + 6.5);
  doc.text('QTY', qtyX, y + 6.5, { width: 30, align: 'center' });
  doc.text('RATE', rateX, y + 6.5, { width: 44, align: 'right' });
  doc.text('AMOUNT', totX, y + 6.5, { width: 50, align: 'right' });

  let ry = y + H;
  (invoice.items || []).forEach((it, i) => {
    if (i % 2 === 1) doc.rect(x, ry, w, 22).fill(theme.stripe);
    doc.fillColor(INK).font('Helvetica').fontSize(8.5);
    doc.text(it.name || '', x + 10, ry + 6.5, { width: w - 170, ellipsis: true, height: 12 });
    doc.fillColor(MUTED);
    doc.text(String(it.qty ?? 1), qtyX, ry + 6.5, { width: 30, align: 'center' });
    doc.text(money(it.unitPrice).replace('INR ', ''), rateX, ry + 6.5, { width: 44, align: 'right' });
    doc.fillColor(INK).font('Helvetica-Bold');
    doc.text(money(it.lineTotal).replace('INR ', ''), totX, ry + 6.5, { width: 50, align: 'right' });
    ry += 22;
  });
  return ry;
}

function totals(doc, invoice, x, w, y, accent) {
  const lblX = x + w - 200, valX = x + w - 110;
  let ty = y + 8;
  const row = (label, val, big) => {
    doc.font(big ? 'Helvetica-Bold' : 'Helvetica').fontSize(big ? 11 : 9).fillColor(big ? INK : MUTED);
    doc.text(label, lblX, ty, { width: 100, align: 'right' });
    doc.fillColor(big ? accent : INK).font('Helvetica-Bold').text(val, valX, ty, { width: 110, align: 'right' });
    ty += big ? 0 : 15;
    return ty;
  };
  if (invoice.discount > 0) { row('Subtotal', money(invoice.subtotal)); row('Discount', '- ' + money(invoice.discount)); }
  // Highlighted total band.
  doc.roundedRect(lblX - 6, ty - 3, w - (lblX - x) + 6, 24, 4).fill(accent === GOLD ? '#FBF3DF' : '#FBEAE7');
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text('TOTAL', lblX, ty + 4, { width: 100, align: 'right' });
  doc.fillColor(accent).fontSize(13).text(money(invoice.total), valX, ty + 3, { width: 110, align: 'right' });
  return ty + 26;
}

function partyBlock(doc, x, y, title, lines, titleColor) {
  doc.fillColor(titleColor).font('Helvetica-Bold').fontSize(7.5).text(title, x, y, { characterSpacing: 0.5 });
  doc.fillColor(INK).font('Helvetica').fontSize(8.8);
  lines.filter(Boolean).forEach((l, i) => doc.text(l, x, y + 13 + i * 12, { width: 175 }));
}

// ── Design 1: Classic ──
function drawClassic(doc, invoice, tpl, logoBuf, W, H) {
  const M = 32;
  doc.rect(0, 0, W, H).fill('#FFFFFF');
  // Header band.
  doc.rect(0, 0, W, 76).fill(RED);
  doc.rect(0, 76, W, 3).fill(GOLD);
  const hasLogo = drawLogo(doc, logoBuf, M, 18, 40, { onDark: true, initial: (tpl.businessName || 'R')[0] });
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(17).text(tpl.businessName || 'Rudraganga', hasLogo ? M + 50 : M, 22);
  doc.font('Helvetica').fontSize(7.5).fillColor('#F6D8D2').text('TAX INVOICE', hasLogo ? M + 50 : M, 44, { characterSpacing: 1 });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#fff').text(invoice.invoiceNo || '', W - M - 150, 26, { width: 150, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor('#F6D8D2').text(fmtDate(invoice.issuedAt), W - M - 150, 44, { width: 150, align: 'right' });

  let y = 98;
  const b = invoice.billTo || {};
  partyBlock(doc, M, y, 'FROM', sellerLines(tpl), RED);
  partyBlock(doc, W / 2 + 6, y, 'BILL TO', [b.name, b.phone], RED);

  y += 104;
  const after = itemsTable(doc, invoice, M, y, W - M * 2, { head: RED, headText: '#fff', stripe: STRIPE });
  const ty = totals(doc, invoice, M, W - M * 2, after + 6, RED);
  footer(doc, tpl, W, H, M);
}

// ── Design 2: Modern ──
function drawModern(doc, invoice, tpl, logoBuf, W, H) {
  const M = 34;
  doc.rect(0, 0, W, H).fill('#FFFFFF');
  const hasLogo = drawLogo(doc, logoBuf, M, 28, 38, { initial: (tpl.businessName || 'R')[0] });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(tpl.businessName || 'Rudraganga', hasLogo ? M + 48 : M, 30);
  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(9).text('I N V O I C E', W - M - 150, 30, { width: 150, align: 'right', characterSpacing: 1 });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(invoice.invoiceNo || '', W - M - 150, 44, { width: 150, align: 'right' });
  doc.fillColor(MUTED).fontSize(8).text(fmtDate(invoice.issuedAt), W - M - 150, 55, { width: 150, align: 'right' });
  // Gold hairline.
  doc.moveTo(M, 80).lineTo(W - M, 80).lineWidth(1.5).strokeColor(GOLD).stroke();

  let y = 96;
  const b = invoice.billTo || {};
  partyBlock(doc, M, y, 'BILLED TO', [b.name, b.phone], GOLD);
  partyBlock(doc, W / 2 + 6, y, 'FROM', sellerLines(tpl), GOLD);

  y += 100;
  const after = itemsTable(doc, invoice, M, y, W - M * 2, { head: INK, headText: '#fff', stripe: '#F7F5F1' });
  totals(doc, invoice, M, W - M * 2, after + 6, GOLD);
  footer(doc, tpl, W, H, M);
}

// ── Design 3: Devotional ──
function drawDevotional(doc, invoice, tpl, logoBuf, W, H) {
  const M = 38;
  doc.rect(0, 0, W, H).fill(CREAM);
  // Double gold frame.
  doc.lineWidth(2).strokeColor(GOLD).rect(16, 16, W - 32, H - 32).stroke();
  doc.lineWidth(0.6).strokeColor(GOLD_SOFT).rect(22, 22, W - 44, H - 44).stroke();
  // Large faint om watermark, centered.
  doc.save();
  doc.fillColor(GOLD).opacity(0.06).font('Helvetica-Bold').fontSize(360).text('ॐ', 0, H / 2 - 200, { width: W, align: 'center' });
  doc.opacity(1).restore();

  doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(20).text('ॐ', 0, 32, { width: W, align: 'center' });
  const hasLogo = drawLogo(doc, logoBuf, W / 2 - 19, 28, 38, { initial: (tpl.businessName || 'R')[0] });
  doc.fillColor(RED).font('Times-Bold').fontSize(19).text(tpl.businessName || 'Rudraganga', 0, hasLogo ? 70 : 58, { width: W, align: 'center' });
  doc.fillColor(MUTED).font('Times-Roman').fontSize(8.5).text('TAX INVOICE  ·  ' + (invoice.invoiceNo || '') + '  ·  ' + fmtDate(invoice.issuedAt), 0, hasLogo ? 94 : 82, { width: W, align: 'center', characterSpacing: 0.5 });
  doc.moveTo(M + 20, hasLogo ? 114 : 102).lineTo(W - M - 20, hasLogo ? 114 : 102).lineWidth(0.8).strokeColor(GOLD).stroke();

  let y = hasLogo ? 128 : 116;
  const b = invoice.billTo || {};
  partyBlock(doc, M, y, 'BILL TO', [b.name, b.phone], RED);
  partyBlock(doc, W / 2 + 6, y, 'FROM', sellerLines(tpl), RED);

  y += 98;
  const after = itemsTable(doc, invoice, M, y, W - M * 2, { head: RED, headText: '#fff', stripe: '#F3E9D6' });
  totals(doc, invoice, M, W - M * 2, after + 6, RED);
  footer(doc, tpl, W, H, M, true);
}

function footer(doc, tpl, W, H, M, devotional) {
  const y = H - 46;
  doc.moveTo(M, y - 8).lineTo(W - M, y - 8).lineWidth(0.5).strokeColor(LINE).stroke();
  doc.fillColor(devotional ? RED : MUTED).font(devotional ? 'Times-Italic' : 'Helvetica-Oblique').fontSize(9)
     .text(tpl.footerNote || 'Thank you for choosing Rudraganga', M, y, { width: W - M * 2, align: 'center' });
  doc.fillColor('#B9AFA4').font('Helvetica').fontSize(6.5)
     .text('This is a computer-generated invoice and does not require a signature.', M, y + 14, { width: W - M * 2, align: 'center' });
}

module.exports = { render };
