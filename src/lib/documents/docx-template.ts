import { UnprocessableEntityException } from '@nestjs/common';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';

/*
 * Reading Word templates (`.docx` with merge fields such as `{employee.first_name}`). These are plain functions of the file's bytes, so the seed
 * can use them too; DocumentsService wraps them for the app.
 */

/** The parts of a Word file that can hold merge fields. */
const TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
/** `{employee.first_name}`, `{#items}` … — the default delimiters. */
const TAG = /\{([^{}]*)\}/g;

export interface TemplateTag {
  /** The merge field as written, without the braces and the `#` / `/` / `^` marker: `employee.first_name`. */
  tag: string;
  /** `value` is a field that is replaced; `open` / `close` mark a repeated or conditional block (`{#x}…{/x}`, `{^x}…{/x}`). */
  kind: 'value' | 'open' | 'close';
  /** How many blocks it sits in (a field inside a block is looked up in that block's data). */
  depth: number;
}

export interface TemplateProblem {
  message: string;
  /** The text of the tag the problem is about, when known. */
  tag?: string;
}

/** Reads `a.b.c` from nested data; `undefined` when any step is missing. */
export function lookup(data: unknown, path: string[]): unknown {
  let current: unknown = data;
  for (const step of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return current;
}

export const splitTag = (tag: string): string[] =>
  tag
    .trim()
    .split('.')
    .map(part => part.trim());

/** What docxtemplater says about a broken template, in a form a person can act on. */
export function problemsOf(error: unknown): TemplateProblem[] {
  const errors = (error as { properties?: { errors?: unknown[] } })?.properties?.errors;
  const list = Array.isArray(errors) && errors.length ? errors : [error];
  return list.slice(0, 10).map(entry => {
    const properties = (entry as { properties?: { explanation?: string; xtag?: string; context?: string } }).properties;
    const tag = properties?.xtag ?? properties?.context;
    return { message: properties?.explanation ?? (entry as Error).message ?? 'The template could not be read.', ...(typeof tag === 'string' && tag && { tag: tag.slice(0, 80) }) };
  });
}

/** Opens a Word file as a template; a 422 says what is wrong when it is not a Word file or its merge fields are written wrongly. */
export function openTemplate(template: Buffer, options: Record<string, unknown> = {}): Docxtemplater {
  let zip: PizZip;
  try {
    zip = new PizZip(template);
  } catch {
    throw new UnprocessableEntityException({ code: 'file_content_mismatch', message: 'This is not a Word (.docx) file.' });
  }
  if (!zip.file('word/document.xml')) throw new UnprocessableEntityException({ code: 'file_content_mismatch', message: 'This is not a Word (.docx) file.' });
  try {
    return new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true, errorLogging: false, ...options });
  } catch (error) {
    throw new UnprocessableEntityException({ code: 'template_invalid', message: 'The merge fields in this Word file are not written correctly.', details: { problems: problemsOf(error) } });
  }
}

/** The merge fields a Word file uses (in order of appearance, with repeats), or a 422 saying what is wrong with it. */
export function scanTemplate(template: Buffer): TemplateTag[] {
  const document = openTemplate(template);
  const tags: TemplateTag[] = [];
  const zip = document.getZip() as PizZip;
  for (const name of Object.keys(zip.files).filter(file => TEXT_PARTS.test(file))) {
    let text = '';
    try {
      text = document.getFullText(name);
    } catch {
      continue;
    }
    let depth = 0;
    for (const match of text.matchAll(TAG)) {
      const raw = (match[1] ?? '').trim();
      if (!raw) continue;
      const marker = raw[0];
      if (marker === '#' || marker === '^') {
        tags.push({ tag: raw.slice(1).trim(), kind: 'open', depth });
        depth += 1;
      } else if (marker === '/') {
        depth = Math.max(0, depth - 1);
        tags.push({ tag: raw.slice(1).trim(), kind: 'close', depth });
      } else if (marker === '@' || marker === '%' || marker === '=') {
        continue;
      } else {
        tags.push({ tag: raw, kind: 'value', depth });
      }
    }
  }
  return tags;
}
