/**
 * parseSection — extract structure from a generated section's markdown.
 *
 * The agent emits each section as Markdown that always begins with `## <title>`
 * and may contain `### <subsection>` blocks plus a closing `### References`
 * block (GFM footnote definitions). For the interactive renderer we need the
 * subsection headings as a list so we can offer a chip nav at the top.
 */

export interface ParsedSubsection {
  title: string;
  /** URL-safe slug for use in DOM ids. */
  slug: string;
}

export interface ParsedSection {
  /** Body with the leading `## <title>` line removed. */
  body: string;
  /** Subsection headings (`###`), excluding any `### References` block. */
  subsections: ParsedSubsection[];
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseSection(markdown: string): ParsedSection {
  const body = markdown.replace(/^##\s+[^\n]*\n+/, '');

  const subsections: ParsedSubsection[] = [];
  const re = /^###\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const title = m[1].trim();
    if (/^references\b/i.test(title)) continue;
    subsections.push({ title, slug: slugify(title) });
  }

  return { body, subsections };
}
