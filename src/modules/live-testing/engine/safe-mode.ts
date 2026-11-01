// Pure safe mode engine for live agent testing (FORGE TQ-030). Safe mode
// is the default and is forced on for production environments: AI testers
// can never destroy real data, pay real money, send real messages or type
// real addresses into real forms. The safe mode check runs BEFORE the
// platform vocabulary: security before mechanics. Every block is named.

export type Environment = 'dev' | 'test' | 'staging' | 'production';

export const ENVIRONMENTS: Environment[] = ['dev', 'test', 'staging', 'production'];

export interface SafeModeDecision {
  safeMode: boolean;
  forced: boolean;
}

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && (ENVIRONMENTS as string[]).includes(value);
}

export function resolveSafeMode(requested: unknown, environment: unknown): SafeModeDecision {
  const env = isEnvironment(environment) ? environment : 'staging';
  if (env === 'production') {
    return { safeMode: true, forced: true };
  }
  const wantsOff = requested === false || requested === 'false' || requested === 0;
  return { safeMode: !wantsOff, forced: false };
}

const DESTRUCTIVE_ACTIONS = ['delete', 'wipe', 'purge', 'drop', 'erase', 'format', 'uninstall'];
const PAYMENT_ACTIONS = ['pay', 'purchase', 'checkout', 'buy', 'subscribe', 'charge', 'billing'];
const MESSAGE_ACTIONS = [
  'send-message',
  'send-email',
  'send-sms',
  'invite',
  'post',
  'publish',
  'share',
];

const EMAIL_RE = /[^\s"']+@[^\s"']+\.[^\s"']+/;

export interface StepIntent {
  action?: unknown;
  target?: unknown;
  payload?: unknown;
}

export interface SafeModeVerdict {
  ok: boolean;
  reason?: string;
}

export function evaluateStep(step: StepIntent, safeMode: boolean): SafeModeVerdict {
  if (!safeMode) {
    return { ok: true };
  }
  const action = typeof step?.action === 'string' ? step.action.trim().toLowerCase() : '';
  if (action.length === 0) {
    return { ok: false, reason: 'safe-mode-action-missing' };
  }
  if (DESTRUCTIVE_ACTIONS.includes(action)) {
    return { ok: false, reason: 'safe-mode-blocks-destructive:' + action };
  }
  if (PAYMENT_ACTIONS.includes(action)) {
    return { ok: false, reason: 'safe-mode-blocks-payment:' + action };
  }
  if (MESSAGE_ACTIONS.includes(action)) {
    return { ok: false, reason: 'safe-mode-blocks-real-message:' + action };
  }
  let payloadText = '';
  try {
    payloadText = JSON.stringify(step?.payload ?? {});
  } catch {
    return { ok: false, reason: 'safe-mode-blocks-unreadable-payload:' + action };
  }
  if (EMAIL_RE.test(payloadText)) {
    return { ok: false, reason: 'safe-mode-blocks-real-address:' + action };
  }
  return { ok: true };
}
