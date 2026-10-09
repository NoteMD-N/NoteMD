/**
 * Reading an uploaded document in the browser.
 *
 * Clinicians upload previous clinic letters, results and referrals. Those
 * arrive in two shapes that need entirely different handling, and telling them
 * apart is most of the work:
 *
 *   - A **digital PDF** carries a text layer. The words are already there,
 *     exactly as typed, and extracting them is lossless.
 *   - A **scanned PDF** is photographs of paper. There is no text, only
 *     pixels, and reading it means optical character recognition.
 *
 * Both are handled here, and the route taken is recorded, because the two have
 * very different error profiles. A text layer is what the author wrote. OCR is
 * a model's best reading of an image, and on a faxed, stamped, handwritten-in-
 * the-margin clinic letter it will get things wrong. A reader of the resulting
 * summary deserves to know which applied.
 *
 * This runs in the browser rather than on the server for two reasons: parsing
 * PDFs in a Deno edge function is awkward and poorly supported, and a document
 * with a text layer never has to leave the device as an image at all.
 */

type PdfJs = typeof import("pdfjs-dist");
type PdfDocument = import("pdfjs-dist").PDFDocumentProxy;

/**
 * pdf.js is loaded on first use, not at startup.
 *
 * It is around 375KB. Most consultations never upload a document, and making
 * every clinician download a PDF engine before they can press record is a
 * poor trade for a feature used occasionally. The dynamic import puts it in
 * its own chunk, fetched the first time someone actually adds a file.
 */
let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((mod) => {
      // Served from our own origin: the Content Security Policy allows
      // scripts from 'self' only, and a CDN-hosted worker would need
      // script-src widened.
      mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      return mod;
    });
  }
  return pdfjsPromise;
}

export type ExtractionMethod = "text-layer" | "ocr" | "none";

export interface ExtractedDocument {
  method: ExtractionMethod;
  /** Text recovered from the text layer; empty when OCR is required. */
  text: string;
  pageCount: number;
  /** Page images to be read by the vision model, when OCR is required. */
  pageImages: Blob[];
}

/**
 * How much text a page must carry before its text layer is believed.
 *
 * A scanned PDF is not always empty of text — it may carry a few characters
 * from a stamp, a page number, or a partial OCR someone ran years ago.
 * Accepting that as the document's content would send a summariser three
 * words and call the job done, which fails silently and looks like success.
 */
const MIN_CHARS_PER_PAGE = 100;

/** Beyond this, a document is almost certainly not consultation context. */
export const MAX_PAGES = 30;

/** Rendering scale for OCR. Enough for 10pt type to survive; not so much that
 *  a thirty-page document becomes tens of megabytes. */
const OCR_SCALE = 2.0;

/**
 * Pulls what it can out of a PDF.
 *
 * Never throws for document reasons — an unreadable file returns `none` with
 * no text, so one bad upload cannot take down the page the clinician is
 * preparing a consultation on.
 */
export async function extractPdf(file: File | Blob): Promise<ExtractedDocument> {
  const empty: ExtractedDocument = { method: "none", text: "", pageCount: 0, pageImages: [] };

  let doc: PdfDocument;
  try {
    const pdfjs = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  } catch (err) {
    console.warn("[context] Could not open PDF:", err);
    return empty;
  }

  const pageCount = Math.min(doc.numPages, MAX_PAGES);

  // Try the text layer first. It is exact where it exists, and costs nothing.
  const pageTexts: string[] = [];
  for (let n = 1; n <= pageCount; n++) {
    try {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pageTexts.push(text);
    } catch (err) {
      console.warn(`[context] Text layer failed on page ${n}:`, err);
      pageTexts.push("");
    }
  }

  const joined = pageTexts.join("\n\n").trim();
  if (joined.length >= MIN_CHARS_PER_PAGE * pageCount) {
    return { method: "text-layer", text: joined, pageCount, pageImages: [] };
  }

  // Too little text to be the document's content: it is scanned. Render the
  // pages so a vision model can read them.
  const pageImages: Blob[] = [];
  for (let n = 1; n <= pageCount; n++) {
    try {
      const image = await renderPageToImage(doc, n);
      if (image) pageImages.push(image);
    } catch (err) {
      console.warn(`[context] Could not render page ${n}:`, err);
    }
  }

  if (pageImages.length === 0) return { ...empty, pageCount };
  return { method: "ocr", text: "", pageCount, pageImages };
}

/** Renders one page to a JPEG for the vision model. */
async function renderPageToImage(
  doc: PdfDocument,
  pageNumber: number,
): Promise<Blob | null> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: OCR_SCALE });

  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) return null;

  // White, not transparent: a scanned page composited onto transparency reads
  // as black-on-black once flattened to JPEG.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: context, viewport }).promise;

  return await new Promise<Blob | null>((resolve) => {
    // JPEG rather than PNG: text pages compress far smaller, and 0.85 keeps
    // characters crisp enough to read while a PNG of the same page can be ten
    // times the size.
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.85);
  });
}

/** True when the file is something we know how to read. */
export function isSupportedDocument(file: File): boolean {
  if (file.type === "application/pdf") return true;
  return /^image\/(png|jpe?g|webp|heic|heif)$/i.test(file.type);
}

/**
 * Reads any supported upload.
 *
 * An image is already a page: there is no text layer to try, so it goes
 * straight to OCR.
 */
export async function extractDocument(file: File): Promise<ExtractedDocument> {
  if (file.type === "application/pdf") return await extractPdf(file);
  if (isSupportedDocument(file)) {
    return { method: "ocr", text: "", pageCount: 1, pageImages: [file] };
  }
  return { method: "none", text: "", pageCount: 0, pageImages: [] };
}
