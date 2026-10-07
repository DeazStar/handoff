import PDFDocument from "pdfkit";
import type { CvEntry, ResolvedCover, ResolvedCv } from "@jobhunt/core/agent";

const MARGIN = { top: 40, bottom: 40, left: 42, right: 42 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Characters the built-in PDF fonts can draw (Latin-1 plus a few Windows punctuation marks).
const DRAWABLE = /[ -~ -ÿ‘’“”–—•…€™]/;

/** Replaces characters the PDF fonts cannot draw, so nothing renders as garbage. */
export function drawable(text: string): string {
  return [...text.normalize("NFC")].map((c) => (DRAWABLE.test(c) ? c : "?")).join("");
}

function formatDate(d: string): string {
  const [y, m] = d.split("-");
  return m ? `${MONTHS[Number(m) - 1]} ${y}` : y!;
}

export function formatDateRange(e: Pick<CvEntry, "startDate" | "endDate" | "isCurrent">): string {
  const start = e.startDate ? formatDate(e.startDate) : "";
  const end = e.isCurrent ? "Present" : e.endDate ? formatDate(e.endDate) : "";
  if (start && end) return `${start} – ${end}`;
  return start || (end ? `– ${end}` : "");
}

const shortLink = (u: string) => u.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");

/**
 * Draws the CV. The layout is fixed here: one column, standard fonts, section order and
 * spacing. A plan decides what goes in and in what order, never how it looks.
 * Page count is returned so callers can refuse a CV that runs too long.
 */
export async function renderCvPdf(cv: ResolvedCv): Promise<{ pdf: Buffer; pages: number }> {
  const doc = new PDFDocument({
    size: "A4",
    margins: MARGIN,
    bufferPages: true,
    info: { Title: `${cv.header.name} - CV`, Author: cv.header.name },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const ended = new Promise<void>((resolve) => doc.on("end", () => resolve()));

  const left = MARGIN.left;
  const width = doc.page.width - MARGIN.left - MARGIN.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensureSpace = (h: number) => {
    if (doc.y + h > bottom()) doc.addPage();
  };
  const font = (name: "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique", size: number, color = "#000000") =>
    doc.font(name).fontSize(size).fillColor(color);

  // Header
  font("Helvetica-Bold", 19).text(drawable(cv.header.name), left, MARGIN.top, { width, align: "center" });
  const contact = [cv.header.email, cv.header.phone, cv.header.location, ...cv.header.links.map(shortLink)].filter(Boolean) as string[];
  if (contact.length) {
    font("Helvetica", 9, "#333333").text(drawable(contact.join("  |  ")), left, doc.y + 2, { width, align: "center" });
  }

  const heading = (title: string) => {
    ensureSpace(48);
    doc.y += 9;
    font("Helvetica-Bold", 10.5).text(title.toUpperCase(), left, doc.y, { width });
    const y = doc.y + 1;
    doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.6).strokeColor("#555555").stroke();
    doc.y = y + 5;
  };

  const entryHeader = (title: string, dates: string, sub: string) => {
    ensureSpace(44);
    const y = doc.y;
    font("Helvetica", 9);
    const dateWidth = dates ? doc.widthOfString(drawable(dates)) + 12 : 0;
    font("Helvetica-Bold", 10).text(drawable(title), left, y, { width: width - dateWidth });
    const titleEnd = doc.y;
    if (dates) font("Helvetica", 9, "#333333").text(drawable(dates), left, y + 0.5, { width, align: "right" });
    doc.y = Math.max(titleEnd, doc.y);
    if (sub) font("Helvetica-Oblique", 9, "#333333").text(drawable(sub), left, doc.y, { width });
    doc.y += 1.5;
  };

  const bullets = (items: string[]) => {
    for (const text of items) {
      font("Helvetica", 9.5);
      ensureSpace(doc.heightOfString(drawable(text), { width: width - 16 }) + 3);
      const y = doc.y;
      doc.text("•", left + 5, y, { lineBreak: false });
      doc.text(drawable(text), left + 16, y, { width: width - 16, lineGap: 1 });
      doc.y += 1.5;
    }
    doc.y += 3;
  };

  const sub = (e: CvEntry) => [e.organization, e.location, e.note].filter(Boolean).join("  |  ");

  if (cv.summary.length) {
    heading("Summary");
    font("Helvetica", 9.5).text(drawable(cv.summary.join(" ")), left, doc.y, { width, lineGap: 1 });
  }
  if (cv.experience.length) {
    heading("Professional Experience");
    for (const { entry, bullets: b } of cv.experience) {
      entryHeader(entry.title, formatDateRange(entry), sub(entry));
      bullets(b);
    }
  }
  if (cv.education.length) {
    heading("Education");
    for (const { entry } of cv.education) {
      entryHeader(entry.title, formatDateRange(entry), [entry.organization, entry.location, entry.note].filter(Boolean).join("  |  "));
      doc.y += 3;
    }
  }
  if (cv.skills.length) {
    heading("Technical Skills");
    for (const g of cv.skills) {
      font("Helvetica", 9.5);
      ensureSpace(doc.heightOfString(drawable(`${g.group}: ${g.items.join(" | ")}`), { width }) + 3);
      font("Helvetica-Bold", 9.5).text(drawable(`${g.group}: `), left, doc.y, { width, continued: true });
      font("Helvetica", 9.5).text(drawable(g.items.join(" | ")), { lineGap: 1 });
      doc.y += 1.5;
    }
  }
  if (cv.projects.length) {
    heading("Projects");
    for (const { entry, bullets: b } of cv.projects) {
      entryHeader(entry.title, formatDateRange(entry), [entry.organization, entry.note].filter(Boolean).join("  |  "));
      bullets(b);
    }
  }

  const pages = doc.bufferedPageRange().count;
  doc.end();
  await ended;
  return { pdf: Buffer.concat(chunks), pages };
}

const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return y && m && d ? `${d} ${LONG_MONTHS[m - 1]} ${y}` : iso;
};

/**
 * Draws a cover letter: sender, date, recipient, subject, greeting, the paragraphs, sign-off. One column, standard fonts.
 * The agent supplies only the paragraphs; everything else comes from the server. Page count is returned so a letter that
 * runs past one page can be refused.
 */
export async function renderCoverPdf(c: ResolvedCover): Promise<{ pdf: Buffer; pages: number }> {
  const margin = { top: 56, bottom: 56, left: 64, right: 64 };
  const doc = new PDFDocument({ size: "A4", margins: margin, bufferPages: true, info: { Title: `${c.header.name} - Cover letter`, Author: c.header.name } });
  const chunks: Buffer[] = [];
  doc.on("data", (x: Buffer) => chunks.push(x));
  const ended = new Promise<void>((resolve) => doc.on("end", () => resolve()));
  const left = margin.left;
  const width = doc.page.width - margin.left - margin.right;
  const font = (name: "Helvetica" | "Helvetica-Bold", size: number, color = "#000000") => doc.font(name).fontSize(size).fillColor(color);

  font("Helvetica-Bold", 16).text(drawable(c.header.name), left, margin.top, { width });
  const contact = [c.header.email, c.header.phone, c.header.location, ...c.header.links.map(shortLink)].filter(Boolean) as string[];
  if (contact.length) font("Helvetica", 9, "#333333").text(drawable(contact.join("  |  ")), left, doc.y + 2, { width });
  const rule = doc.y + 6;
  doc.moveTo(left, rule).lineTo(left + width, rule).lineWidth(0.6).strokeColor("#555555").stroke();
  doc.y = rule + 16;

  font("Helvetica", 10, "#333333").text(drawable(longDate(c.date)), left, doc.y, { width });
  doc.y += 10;
  font("Helvetica", 10.5).text(drawable(c.recipient), left, doc.y, { width });
  if (c.company) font("Helvetica", 10.5).text(drawable(c.company), left, doc.y, { width });
  doc.y += 10;
  font("Helvetica-Bold", 10.5).text(drawable(c.subject), left, doc.y, { width });
  doc.y += 12;
  font("Helvetica", 10.5).text(drawable(c.greeting), left, doc.y, { width });
  doc.y += 8;
  for (const p of c.paragraphs) {
    font("Helvetica", 10.5).text(drawable(p), left, doc.y, { width, lineGap: 2.5 });
    doc.y += 9;
  }
  font("Helvetica", 10.5).text(drawable(c.closing), left, doc.y + 4, { width });
  font("Helvetica-Bold", 10.5).text(drawable(c.signature), left, doc.y + 18, { width });

  const pages = doc.bufferedPageRange().count;
  doc.end();
  await ended;
  return { pdf: Buffer.concat(chunks), pages };
}
