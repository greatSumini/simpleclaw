export * from './types.js';
export { routeMessage, routeMessage as routeDiscord } from './router.js';
export { classifyMail } from './importance.js';
export {
  buildRepoWorkSystemAppend,
  buildSimpleClawMaintenanceSystemAppend,
  buildWikiIngestSystemAppend,
  SIMPLECLAW_RESTART_MARKER,
  detectPermanentRuleIntent,
  PERMANENT_RULE_NOTICE_INSTRUCTION,
} from './prompt.js';
export type { RepoWorkPromptArgs, SimpleClawMaintenancePromptArgs, WikiIngestPromptArgs } from './prompt.js';
