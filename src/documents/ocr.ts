/**
 * On-device OCR for scanned PDFs.
 *
 * Most real executed side letters are scans — pdf-parse returns near-empty
 * text for them. When that happens we render each page with pdf.js and run
 * Tesseract over the images, all locally. The only network access is a
 * one-time download of Tesseract's public English model (~15 MB, cached
 * under data/ocr-cache); no document content ever leaves the machine.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { config } from '../config.js';

const MAX_PAGES = 25;
const RENDER_SCALE = 2.2;

/** Heuristic: a real text-layer PDF yields far more than this per page. */
export function isLikelyScanned(extractedText: string, pageCount: number): boolean {
  const dense = extractedText.replace(/\s+/g, '');
  return dense.length < Math.max(200, 40 * pageCount);
}

/** Render PDF pages to PNG buffers using pdf.js + a native canvas. */
export async function renderPdfPages(buffer: Buffer, maxPages = MAX_PAGES): Promise<Buffer[]> {
  const canvasMod = await import('@napi-rs/canvas');
  // pdf.js expects these DOM globals in Node
  const g = globalThis as Record<string, unknown>;
  g.DOMMatrix ??= canvasMod.DOMMatrix;
  g.ImageData ??= canvasMod.ImageData;
  g.Path2D ??= canvasMod.Path2D;

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const images: Buffer[] = [];
  const pages = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    let viewport = page.getViewport({ scale: RENDER_SCALE });
    // a crafted (or just unusual) PDF can declare an enormous page box —
    // clamp the render target so one page can't demand gigabytes of canvas
    const MAX_DIM = 4_000;
    const MAX_PIXELS = 12_000_000;
    const shrink = Math.min(
      1,
      MAX_DIM / Math.max(viewport.width, viewport.height),
      Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)),
    );
    if (shrink < 1) viewport = page.getViewport({ scale: RENDER_SCALE * shrink });
    const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // @napi-rs/canvas's 2D context is API-compatible with the DOM context pdf.js expects
    await page.render({ canvasContext: ctx as never, viewport }).promise;
    images.push(canvas.toBuffer('image/png'));
  }
  await doc.destroy();
  return images;
}

/** OCR a set of page images with Tesseract (English), entirely on-device. */
export async function ocrImages(images: Buffer[]): Promise<string> {
  const { createWorker } = await import('tesseract.js');
  const cachePath = path.join(path.dirname(path.resolve(config.dbPath)), 'ocr-cache');
  fs.mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker('eng', 1, { cachePath });
  try {
    const texts: string[] = [];
    for (const image of images) {
      const { data } = await worker.recognize(image);
      texts.push(data.text);
    }
    return texts.join('\n\n');
  } finally {
    await worker.terminate();
  }
}

/** Full pipeline: scanned PDF buffer → text. */
export async function ocrPdf(buffer: Buffer): Promise<string> {
  const images = await renderPdfPages(buffer);
  if (images.length === 0) return '';
  return ocrImages(images);
}
