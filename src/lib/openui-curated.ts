'use client';

import { createLibrary } from '@openuidev/react-lang';
import { openuiChatLibrary } from '@openuidev/react-ui/genui-lib';

/**
 * Components excluded from the curated library because they emit invalid
 * HTML in the current OpenUI build (Radix Accordion-based components nest
 * an IconButton — <button> — inside the AccordionTrigger button).
 *
 * Keep this list in sync with `EXCLUDED` in scripts/build-openui-prompt.mjs.
 */
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

export const curatedLibrary = createLibrary({
  components,
  componentGroups: openuiChatLibrary.componentGroups,
  root: openuiChatLibrary.root,
});
