import type { ChunkInput, WorkItemForChunking } from './util';
import { approxTokens, passesMinimum, parseMetadata } from './util';

interface Section {
  heading: string;
  body: string;
}

function splitByHeadings(md: string): Section[] {
  if (!md.trim()) return [];
  const lines = md.split('\n');
  const sections: Section[] = [];
  let currentHeading = '';
  let currentBody: string[] = [];

  const flush = () => {
    const body = currentBody.join('\n').trim();
    if (currentHeading || body) {
      sections.push({ heading: currentHeading || '(intro)', body });
    }
  };

  for (const line of lines) {
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      currentHeading = m[2].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  flush();

  return sections.filter(s => s.body.trim().length > 0 || s.heading !== '(intro)');
}

export function chunkNotion(item: WorkItemForChunking): ChunkInput[] {
  const body = item.body || '';
  const metadata = parseMetadata(item.metadata);
  const breadcrumbParts = [item.title];
  if (metadata?.parent_database) breadcrumbParts.unshift(String(metadata.parent_database).slice(0, 40));
  const breadcrumb = breadcrumbParts.join(' / ');

  const sections = splitByHeadings(body);
  const chunks: ChunkInput[] = [];

  if (sections.length <= 1) {
    const text = [breadcrumb, body].filter(Boolean).join('\n\n');
    if (passesMinimum(text)) {
      chunks.push({
        chunk_type: 'notion_section',
        chunk_text: text,
        position: 0,
        token_count: approxTokens(text),
        metadata: { heading: null, breadcrumb },
      });
    }
    return chunks;
  }

  sections.forEach((section, i) => {
    const text = `${breadcrumb} / ${section.heading}\n\n${section.body}`;
    if (passesMinimum(text)) {
      chunks.push({
        chunk_type: 'notion_section',
        chunk_text: text,
        position: i,
        token_count: approxTokens(text),
        metadata: { heading: section.heading, breadcrumb },
      });
    }
  });
  return chunks;
}
