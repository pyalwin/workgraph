// Pre-generates the OpenUI Lang system-prompt addendum into a static TS
// module. Importing @openuidev/react-ui from a Next.js server route fails
// because the vendored RSC React lacks createContext; this script runs in
// plain Node where the real React package is in scope.
//
// Run via `npm run gen:openui` (or wired into prebuild).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { openuiChatLibrary, openuiChatPromptOptions } = await import(
  '@openuidev/react-ui/genui-lib'
);
const { createLibrary } = await import('@openuidev/react-lang');

// Components that produce invalid HTML in the current OpenUI build (nest a
// <button> inside another <button> via Radix Accordion + IconButton). Keep
// this list in sync with the EXCLUDED set in src/lib/openui-curated.ts.
const EXCLUDED = new Set([
  'FoldableSection',
  'FoldableSectionRoot',
  'FoldableSectionItem',
  'FoldableSectionTrigger',
  'FoldableSectionContent',
  'Accordion',
  'AccordionItem',
  'AccordionTrigger',
  'AccordionContent',
]);

const components = Object.entries(openuiChatLibrary.components)
  .filter(([name]) => !EXCLUDED.has(name))
  .map(([, c]) => c);

const curated = createLibrary({
  components,
  componentGroups: openuiChatLibrary.componentGroups,
  root: openuiChatLibrary.root,
});

const text = curated.prompt({
  ...openuiChatPromptOptions,
  inlineMode: true,
  toolCalls: false,
});

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'src', 'lib', 'ai', 'openui-prompt-text.ts');
const banner =
  '// AUTO-GENERATED — run `npm run gen:openui` to regenerate. Do not edit by hand.\n';
fs.writeFileSync(out, banner + `export const OPENUI_PROMPT = ${JSON.stringify(text)};\n`);
console.log(`[openui] wrote ${out} (${text.length} chars)`);
