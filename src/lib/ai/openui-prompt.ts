import { OPENUI_PROMPT } from './openui-prompt-text';

/**
 * The OpenUI Lang system-prompt addendum is built at script-time by
 * `scripts/build-openui-prompt.mjs` and imported as a plain string here.
 *
 * Why: @openuidev/react-ui/genui-lib uses `createContext` which Next.js's
 * RSC-vendored React doesn't expose; importing it from a server route
 * crashes module evaluation. Running the generator in plain Node sidesteps
 * that. Re-run `npm run gen:openui` whenever the OpenUI library version
 * changes or you want to swap the prompt configuration.
 */
export function getOpenUIPrompt(): string {
  return OPENUI_PROMPT;
}
