import { anthropic } from '@ai-sdk/anthropic';

export type AITask =
  | 'enrich'
  | 'recap'
  | 'extract'
  | 'project-summary'
  | 'decision'
  | 'narrative';

const TASK_MODELS: Record<AITask, string> = {
  enrich: 'claude-haiku-4-5-20251001',
  recap: 'claude-haiku-4-5-20251001',
  extract: 'claude-haiku-4-5-20251001',
  'project-summary': 'claude-haiku-4-5-20251001',
  decision: 'claude-sonnet-4-6',
  narrative: 'claude-sonnet-4-6',
};

export function getModel(task: AITask) {
  return anthropic(TASK_MODELS[task]);
}
