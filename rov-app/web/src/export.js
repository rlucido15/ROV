// Export the generated ROV markdown to a formatted DOCX (client-side) or a
// clean print-to-PDF view. No server round-trip — keeps the document in the
// browser session, consistent with the zero-storage posture.
//
// DOCX generation uses the `docx` npm library (bundled at build time by Vite).
// PDF uses the browser's print pipeline against a purpose-built print window.

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
} from "docx";

// US Letter in DXA (1440 = 1 inch)
const PAGE = { width: 12240, height: 15840 };
const CONTENT_WIDTH = PAGE.width - 1440 * 2; // 1" margins each side => 9360 dxa
const ACCENT = "28B5CF";
const ACCENT2 = "F46744";
const INK = "1A1A1A";
const MUTED = "6B7280";

/* ----------------------------- markdown parse ----------------------------- */
// Mirrors renderMarkdown in App.jsx: headings, hr, tables, lists, bold, paragraphs.

function parseInline(text) {
  // Split on **bold** and [VERIFY:...] / ledger tags, return docx TextRuns.
  const parts = text.split(/(\*\*[^*]+\*\*|\[VERIFY[^\]]*\]|\b(?:APP|CMP|ADR|PRI)-\d{2}\b)/g);
  return parts.filter((p) => p !== "").map((p) => {
    if (/^\*\*[^*]+\*\*$/.test(p)) return new TextRun({ text: p.slice(2, -2), bold: true });
    if (/^\[VERIFY/i.test(p)) return new TextRun({ text: p, bold: true, color: ACCENT2 });
    if (/^(APP|CMP|ADR|PRI)-\d{2}$/.test(p)) return new TextRun({ text: p, bold: true, color: ACCENT, font: "Consolas" });
    return new TextRun({ text: p });
  });
}

function headingParagraph(text, level) {
  const map = {
    1: { heading: HeadingLevel.HEADING_1, size: 32, color: INK, border: true },
    2: { heading: HeadingLevel.HEADING_2, size: 26, color: INK },
    3: { heading: HeadingLevel.HEADING_3, size: 23, color: INK },
    4: { heading: HeadingLevel.HEADING_4, size: 21, color: MUTED },
  };
  const cfg = map[level] || map[4];
  return new Paragraph({
    heading: cfg.heading,
    spacing: { before: level <= 2 ? 300 : 200, after: 120 },
    ...(cfg.border ? { border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 6 } } } : {}),
    children: [new TextRun({ text, bold: true, size: cfg.size, color: cfg.color })],
  });
}

function tableFromRows(header, rows) {
  const cols = header.length;
  const colW = Math.floor(CONTENT_WIDTH / cols);
  const columnWidths = Array(cols).fill(colW);

  const cell = (text, opts = {}) =>
    new TableCell({
      width: { size: colW, type: WidthType.DXA },
      shading: opts.header ? { type: ShadingType.CLEAR, fill: "EEF4F6", color: "auto" } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({
        children: [new TextRun({ text: String(text).replace(/\*\*/g, ""), bold: !!opts.header, size: 18, font: "Consolas" })],
      })],
    });

  const headRow = new TableRow({ tableHeader: true, children: header.map((h) => cell(h, { header: true })) });
  const bodyRows = rows.map((r) => new TableRow({
    children: Array.from({ length: cols }, (_, i) => cell(r[i] ?? "")),
  }));

  return new Table({
    columnWidths,
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
    },
    rows: [headRow, ...bodyRows],
  });
}

function markdownToDocxChildren(md) {
  const lines = (md || "").replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;

  const splitCells = (line) =>
    line.split("|").map((c) => c.trim()).filter((_, idx, arr) => !((idx === 0 && arr[0] === "") || (idx === arr.length - 1 && arr[arr.length - 1] === "")));

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // horizontal rule
    if (/^---+$/.test(line.trim())) {
      out.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 } },
        spacing: { before: 160, after: 160 },
        children: [new TextRun({ text: "" })],
      }));
      i++; continue;
    }

    // table
    if (line.includes("|") && lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const header = splitCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) { rows.push(splitCells(lines[i])); i++; }
      out.push(tableFromRows(header, rows));
      out.push(new Paragraph({ spacing: { after: 100 }, children: [new TextRun("")] }));
      continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { out.push(headingParagraph(h[2], h[1].length)); i++; continue; }

    // bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        out.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 40 }, children: parseInline(lines[i].replace(/^\s*[-*]\s+/, "")) }));
        i++;
      }
      continue;
    }

    // numbered list -> rendered as plain paragraphs keeping the number (simplest, avoids numbering config)
    if (/^\s*\d+\.\s+/.test(line)) {
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        out.push(new Paragraph({ spacing: { after: 40 }, indent: { left: 360 }, children: parseInline(lines[i].trim()) }));
        i++;
      }
      continue;
    }

    // paragraph
    out.push(new Paragraph({ spacing: { after: 120 }, children: parseInline(line) }));
    i++;
  }
  return out;
}

/* ------------------------------- public API ------------------------------- */

export async function exportDocx(rovMarkdown, caseInfo) {
  const children = [
    // internal disclaimer footer note at the very end
    ...markdownToDocxChildren(rovMarkdown),
    new Paragraph({
      spacing: { before: 300 },
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC", space: 6 } },
      children: [new TextRun({
        text: "Prepared with an evidence-organization tool. Verify every figure against source documents before submission. Not an appraisal or a USPAP determination.",
        italics: true, size: 16, color: MUTED,
      })],
    }),
  ];

  const doc = new Document({
    creator: "ROV Assistant",
    title: "Reconsideration of Value Request",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 21, color: INK } },
      },
    },
    sections: [{
      properties: { page: { size: { width: PAGE.width, height: PAGE.height }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children,
    }],
  });

  const blob = await Packer.toBlob(doc);
  triggerDownload(blob, filename(caseInfo, "docx"));
}

// Clean print-to-PDF via a purpose-built window (browser handles PDF).
export function exportPdf(rovMarkdown, caseInfo) {
  const w = window.open("", "_blank");
  if (!w) return;
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const html = esc(rovMarkdown)
    .replace(/^#{4}\s+(.*)$/gm, "<h4>$1</h4>")
    .replace(/^#{3}\s+(.*)$/gm, "<h3>$1</h3>")
    .replace(/^#{2}\s+(.*)$/gm, "<h2>$1</h2>")
    .replace(/^#\s+(.*)$/gm, "<h1>$1</h1>")
    .replace(/^-{3,}$/gm, "<hr>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .split(/\n{2,}/).map((b) => (/^<h|^<hr/.test(b.trim()) ? b : "<p>" + b.replace(/\n/g, "<br>") + "</p>")).join("\n")
    // simple markdown tables -> html tables
    .replace(/<p>((?:\|.*<br>?)+.*)<\/p>/g, (m, body) => mdTableToHtml(body));

  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(filename(caseInfo, "").replace(/\.$/, ""))}</title>
    <style>
      body { font: 11.5pt/1.55 Georgia, 'Times New Roman', serif; color:#1a1a1a; max-width:7.2in; margin:0.9in auto; padding:0 0.3in; }
      h1 { font-size:16pt; border-bottom:2px solid #28b5cf; padding-bottom:8px; }
      h2 { font-size:13pt; margin-top:20px; } h3 { font-size:12pt; } h4 { font-size:11pt; color:#555; }
      table { border-collapse:collapse; width:100%; margin:12px 0; font-size:10pt; }
      th,td { border:1px solid #bbb; padding:5px 8px; text-align:left; }
      th { background:#eef4f6; }
      p { margin:0 0 9px; } hr { border:none; border-top:1px solid #ccc; margin:18px 0; }
      .disc { margin-top:28px; padding-top:10px; border-top:1px solid #ccc; font-size:8.5pt; color:#777; }
    </style></head><body>${html}
    <p class="disc">Prepared with an evidence-organization tool. Verify every figure against source documents before submission. Not an appraisal or a USPAP determination.</p>
    </body></html>`);
  w.document.close(); w.focus();
  setTimeout(() => w.print(), 350);
}

function mdTableToHtml(block) {
  const lines = block.split(/<br>?/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return "<p>" + block + "</p>";
  const cells = (l) => l.split("|").map((c) => c.trim()).filter((_, i, a) => !((i === 0 && a[0] === "") || (i === a.length - 1 && a[a.length - 1] === "")));
  const header = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  const th = header.map((h) => `<th>${h.replace(/\*\*/g, "")}</th>`).join("");
  const trs = rows.map((r) => "<tr>" + r.map((c) => `<td>${c.replace(/\*\*/g, "")}</td>`).join("") + "</tr>").join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

/* -------------------------------- helpers -------------------------------- */

function filename(caseInfo, ext) {
  const addr = (caseInfo?.address || "ROV").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ROV";
  return `Reconsideration-of-Value_${addr}${ext ? "." + ext : ""}`;
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
