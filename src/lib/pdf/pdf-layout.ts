import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
import type { PdfArea, PdfBox, PdfPageLayout, PdfTextLine } from './pdf.types.js';

/*
 * What is on the pages of a PDF, measured from the top left corner of each page as it is shown: the lines of text and the places where something can be written —
 * empty rectangles, rows of letter boxes, tick boxes, lines to write on. This is how a form without fields is read: the AI is told where the questions are and where
 * the answers can go, so it only has to say which answer belongs where. Everything here is plain geometry; nothing knows about forms of the office.
 */

type Matrix = [number, number, number, number, number, number];
type Point = [number, number];
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
/** pdf.js draws a path with these steps (its `DrawOPS`). */
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 } as const;
/** How long the reading of one PDF may take. */
const TIMEOUT_MS = 20_000;
/** The most places to write that are kept per page (the ones nearest the top first). */
const MAX_AREAS = 300;
const MAX_LINES = 400;

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): Point => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
const round = (value: number): number => Math.round(value * 10) / 10;
const toBox = (rect: Rect): PdfBox => ({ x: round(rect.x0), y: round(rect.y0), width: round(rect.x1 - rect.x0), height: round(rect.y1 - rect.y0) });
const isMatrix = (value: unknown): value is Matrix => Array.isArray(value) && value.length === 6 && value.every(entry => typeof entry === 'number');

/** The lines and the places to write of the first `maxPages` pages. Throws when the PDF cannot be read. */
export async function readLayout(bytes: Buffer, maxPages: number): Promise<PdfPageLayout[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      readPages(bytes, maxPages),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readPages(bytes: Buffer, maxPages: number): Promise<PdfPageLayout[]> {
  const pdfjs = (await getResolvedPDFJS()) as unknown as { OPS: Record<string, number> };
  const document = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const pages: PdfPageLayout[] = [];
    for (let number = 1; number <= Math.min(document.numPages, maxPages); number += 1) {
      const page = await document.getPage(number);
      // The part of the page that is shown: x from the left, y from the bottom (PDF space). Everything below is measured from its top left corner.
      const [left, bottom, right, top] = page.view as [number, number, number, number];
      const toTopLeft = (x: number, y: number): Point => [x - left, top - y];

      const content = await page.getTextContent();
      const lines = textLines(content.items as unknown[], toTopLeft);
      const operators = await page.getOperatorList();
      const shapes = drawnShapes(operators.fnArray, operators.argsArray, pdfjs.OPS, toTopLeft);
      const width = right - left;
      const height = top - bottom;
      pages.push({ page: number - 1, width: round(width), height: round(height), lines: lines.slice(0, MAX_LINES), areas: areasOf(shapes, lines, width, height).slice(0, MAX_AREAS) });
      page.cleanup();
    }
    return pages;
  } finally {
    // The types of unpdf do not list it, but pdf.js documents can be destroyed: it frees the memory of the pages at once.
    await (document as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
}

/* ── Text ───────────────────────────────────────────────────────────────────────────────────────────────────────── */

interface Word {
  text: string;
  x0: number;
  x1: number;
  baseline: number;
  size: number;
}

/** The text of a page as pieces of a line: words on the same line close together are one piece; a wide gap starts a new piece (a label and an answer column). */
function textLines(items: unknown[], toTopLeft: (x: number, y: number) => Point): PdfTextLine[] {
  const words: Word[] = [];
  for (const item of items) {
    const raw = item as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
    if (typeof raw.str !== 'string' || !raw.str.trim() || !isMatrix(raw.transform)) continue;
    const [a, b, c, d, e, f] = raw.transform;
    // Only text that reads from left to right; a turned text (a margin note) is left out.
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0) continue;
    const size = Math.abs(d) || (typeof raw.height === 'number' ? raw.height : 0);
    if (size < 3) continue;
    const width = typeof raw.width === 'number' ? raw.width : 0;
    const [x0, baseline] = toTopLeft(e, f);
    words.push({ text: raw.str.replace(/\s+/g, ' '), x0, x1: x0 + width, baseline, size });
  }
  words.sort((one, two) => one.baseline - two.baseline || one.x0 - two.x0);

  const rows: Word[][] = [];
  for (const word of words) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0]!.baseline - word.baseline) <= Math.max(1.5, word.size * 0.25)) row.push(word);
    else rows.push([word]);
  }

  const lines: PdfTextLine[] = [];
  for (const row of rows) {
    row.sort((one, two) => one.x0 - two.x0);
    let piece: Word[] = [];
    const flush = () => {
      if (!piece.length) return;
      let text = '';
      piece.forEach((word, index) => {
        const gap = index ? word.x0 - piece[index - 1]!.x1 : 0;
        text += index && gap > word.size * 0.15 && !text.endsWith(' ') && !word.text.startsWith(' ') ? ` ${word.text}` : word.text;
      });
      const size = Math.max(...piece.map(word => word.size));
      const x0 = Math.min(...piece.map(word => word.x0));
      const x1 = Math.max(...piece.map(word => word.x1));
      const baseline = Math.max(...piece.map(word => word.baseline));
      const clean = text.replace(/\s+/g, ' ').trim();
      if (clean) lines.push({ text: clean.slice(0, 300), size: round(size), box: toBox({ x0, y0: baseline - size * 0.8, x1, y1: baseline + size * 0.2 }) });
      piece = [];
    };
    for (const word of row) {
      const last = piece.at(-1);
      if (last && word.x0 - last.x1 > Math.max(4, word.size * 0.9)) flush();
      piece.push(word);
    }
    flush();
  }
  return lines;
}

/* ── Drawing ────────────────────────────────────────────────────────────────────────────────────────────────────── */

interface Shapes {
  rects: Rect[];
  /** Horizontal lines: y, from x0 to x1. */
  hlines: Array<{ y: number; x0: number; x1: number }>;
}

/** The rectangles and horizontal lines the page draws (filled or stroked), in page measures. Clipping paths draw nothing and are left out. */
function drawnShapes(fnArray: number[], argsArray: unknown[], OPS: Record<string, number>, toTopLeft: (x: number, y: number) => Point): Shapes {
  const painting = new Set(['stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke'].map(name => OPS[name]));
  const rects: Rect[] = [];
  const hlines: Shapes['hlines'] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;

  for (let index = 0; index < fnArray.length; index += 1) {
    const op = fnArray[index];
    const args = argsArray[index] as unknown[] | null;
    if (op === OPS.save) stack.push(ctm);
    else if (op === OPS.restore) ctm = stack.pop() ?? IDENTITY;
    else if (op === OPS.transform && isMatrix(args)) ctm = multiply(ctm, args);
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args && isMatrix(args[0])) ctm = multiply(ctm, args[0]);
    } else if (op === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? IDENTITY;
    else if (op === OPS.constructPath && args) {
      // pdf.js 5: [paint operator, [path data], bounding box]
      const paint = args[0] as number;
      const data = Array.isArray(args[1]) ? (args[1][0] as ArrayLike<number> | undefined) : undefined;
      if (!painting.has(paint) || !data) continue;
      for (const path of subPaths(data)) {
        const points = path.map(([x, y]) => toTopLeft(...apply(ctm, x, y)));
        collect(points, rects, hlines);
      }
    }
  }
  return { rects, hlines };
}

/** The separate pieces of a path, as their corner points (curves end the piece: a rounded shape is not a box). */
function subPaths(data: ArrayLike<number>): Point[][] {
  const paths: Point[][] = [];
  let current: Point[] = [];
  let curved = false;
  const close = () => {
    if (current.length && !curved) paths.push(current);
    current = [];
    curved = false;
  };
  for (let index = 0; index < data.length; ) {
    const step = data[index];
    if (step === DRAW.moveTo) {
      close();
      current.push([data[index + 1]!, data[index + 2]!]);
      index += 3;
    } else if (step === DRAW.lineTo) {
      current.push([data[index + 1]!, data[index + 2]!]);
      index += 3;
    } else if (step === DRAW.curveTo) {
      curved = true;
      index += 7;
    } else if (step === DRAW.quadraticCurveTo) {
      curved = true;
      index += 5;
    } else if (step === DRAW.closePath) {
      close();
      index += 1;
    } else break;
  }
  close();
  return paths;
}

/** A piece of a path that is a rectangle (four straight corners) or a horizontal line. */
function collect(points: Point[], rects: Rect[], hlines: Shapes['hlines']): void {
  const unique = points.filter((point, index) => index === 0 || Math.abs(point[0] - points[index - 1]![0]) > 0.01 || Math.abs(point[1] - points[index - 1]![1]) > 0.01);
  if (unique.length > 4 && Math.abs(unique[0]![0] - unique.at(-1)![0]) < 0.5 && Math.abs(unique[0]![1] - unique.at(-1)![1]) < 0.5) unique.pop();
  if (unique.length === 2) {
    const [[ax, ay], [bx, by]] = unique as [Point, Point];
    if (Math.abs(ay - by) < 0.6 && Math.abs(ax - bx) >= 30) hlines.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
    return;
  }
  if (unique.length !== 4) return;
  const straight = unique.every((point, index) => {
    const next = unique[(index + 1) % 4]!;
    return Math.abs(point[0] - next[0]) < 0.6 || Math.abs(point[1] - next[1]) < 0.6;
  });
  if (!straight) return;
  const xs = unique.map(point => point[0]);
  const ys = unique.map(point => point[1]);
  const rect = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  // A very thin rectangle is a line drawn as a filled bar.
  if (height < 1.5 && width >= 30) hlines.push({ y: (rect.y0 + rect.y1) / 2, x0: rect.x0, x1: rect.x1 });
  else if (width >= 4 && height >= 4) rects.push(rect);
}

/* ── Places to write ────────────────────────────────────────────────────────────────────────────────────────────── */

const inside = (rect: Rect, x: number, y: number, margin = 0): boolean => x >= rect.x0 - margin && x <= rect.x1 + margin && y >= rect.y0 - margin && y <= rect.y1 + margin;
const same = (one: Rect, two: Rect): boolean => Math.abs(one.x0 - two.x0) < 1 && Math.abs(one.y0 - two.y0) < 1 && Math.abs(one.x1 - two.x1) < 1 && Math.abs(one.y1 - two.y1) < 1;
const overlaps = (one: Rect, two: Rect): boolean => one.x0 < two.x1 && two.x0 < one.x1 && one.y0 < two.y1 && two.y0 < one.y1;

/** The rectangles without text in them, rows of letter boxes, tick boxes and free lines to write on — the places an answer can go. */
function areasOf(shapes: Shapes, lines: PdfTextLine[], pageWidth: number, pageHeight: number): PdfArea[] {
  const textRects = lines.map(line => ({ x0: line.box.x, y0: line.box.y, x1: line.box.x + line.box.width, y1: line.box.y + line.box.height }));
  const hasText = (rect: Rect) => textRects.some(text => inside(rect, (text.x0 + text.x1) / 2, (text.y0 + text.y1) / 2, -0.5));

  // Empty rectangles of a sensible size, each once (a box is often filled and stroked: two shapes).
  const empty: Rect[] = [];
  for (const rect of shapes.rects) {
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    if (width > pageWidth * 0.9 && height > pageHeight * 0.4) continue;
    if (height > 240 || width < 5) continue;
    if (hasText(rect)) continue;
    if (empty.some(seen => same(seen, rect))) continue;
    empty.push(rect);
  }
  // A frame around other boxes is not a box itself.
  const boxes = empty.filter(rect => !empty.some(other => other !== rect && other.x0 >= rect.x0 - 0.5 && other.x1 <= rect.x1 + 0.5 && other.y0 >= rect.y0 - 0.5 && other.y1 <= rect.y1 + 0.5 && !same(other, rect)));

  const areas: PdfArea[] = [];
  const used = new Set<Rect>();
  // Rows of equal small squares next to each other: one answer written one character per square.
  const small = boxes.filter(rect => rect.x1 - rect.x0 >= 6 && rect.x1 - rect.x0 <= 28 && rect.y1 - rect.y0 >= 7 && rect.y1 - rect.y0 <= 32).sort((one, two) => one.y0 - two.y0 || one.x0 - two.x0);
  for (const start of small) {
    if (used.has(start)) continue;
    const row = [start];
    for (;;) {
      const last = row.at(-1)!;
      const next = small.find(rect => !used.has(rect) && !row.includes(rect) && Math.abs(rect.y0 - last.y0) < 1.5 && Math.abs(rect.y1 - last.y1) < 1.5 && rect.x0 - last.x1 > -1.5 && rect.x0 - last.x1 < 4 && Math.abs(rect.x1 - rect.x0 - (last.x1 - last.x0)) < 3);
      if (!next) break;
      row.push(next);
    }
    if (row.length < 2) continue;
    for (const rect of row) used.add(rect);
    areas.push({ kind: 'cells', cells: row.length, box: toBox({ x0: row[0]!.x0, y0: Math.min(...row.map(rect => rect.y0)), x1: row.at(-1)!.x1, y1: Math.max(...row.map(rect => rect.y1)) }) });
  }
  for (const rect of boxes) {
    if (used.has(rect)) continue;
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    if (Math.abs(width - height) <= 3 && width >= 5 && width <= 16) areas.push({ kind: 'tick', cells: 0, box: toBox(rect) });
    else if (width >= 18 && height >= 7) areas.push({ kind: 'box', cells: 0, box: toBox(rect) });
  }

  // A line with nothing written above it, that is not the edge of a box, is a line to write on.
  for (const line of shapes.hlines) {
    if (line.x1 - line.x0 < 40) continue;
    const band = { x0: line.x0, y0: line.y - 14, x1: line.x1, y1: line.y - 0.5 };
    if (shapes.rects.some(rect => line.x0 >= rect.x0 - 1 && line.x1 <= rect.x1 + 1 && (Math.abs(line.y - rect.y0) < 1.2 || Math.abs(line.y - rect.y1) < 1.2))) continue;
    if (textRects.some(text => overlaps(band, text))) continue;
    if (areas.some(area => overlaps(band, { x0: area.box.x, y0: area.box.y, x1: area.box.x + area.box.width, y1: area.box.y + area.box.height }))) continue;
    areas.push({ kind: 'line', cells: 0, box: toBox(band) });
  }
  return areas.sort((one, two) => one.box.y - two.box.y || one.box.x - two.box.x);
}
