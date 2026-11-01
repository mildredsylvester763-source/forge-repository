// Pure step narration and goal parsing engine for live agent testing
// (FORGE TQ-008, TQ-012). Plain-language goals split into a deterministic
// task list, and every recorded action gets a human-readable narration.
// Typed values are narrated by length only, never echoed, so secrets
// survive the log by construction.

export interface ParsedTask {
  id: string;
  text: string;
  keywords: string[];
}

export interface GoalVerdict {
  ok: boolean;
  reason?: string;
  tasks?: ParsedTask[];
}

export const GOAL_TASK_LIMIT = 12;

// Filler words carry no task semantics: goals are matched by what the user
// wants done, not by their articles and connectives, so determiners and
// connectives are dropped before keywords are drawn. Short tokens are
// already gone by the length rule; these are the words that survive length
// but still mean nothing.
const STOPWORDS = new Set([
  'the',
  'and',
  'but',
  'for',
  'with',
  'into',
  'onto',
  'then',
  'that',
  'this',
  'from',
  'your',
  'you',
]);

export function keywordsOf(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return Array.from(new Set(tokens));
}

export function parseGoal(goal: unknown): GoalVerdict {
  if (typeof goal !== 'string') {
    return { ok: false, reason: 'goal-not-a-string' };
  }
  const trimmed = goal.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'goal-empty' };
  }
  const parts = trimmed
    .split(/\r?\n|;|\bthen\b/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return { ok: false, reason: 'goal-empty' };
  }
  if (parts.length > GOAL_TASK_LIMIT) {
    return { ok: false, reason: 'goal-too-many-tasks:' + parts.length };
  }
  const seen = new Set<string>();
  const tasks: ParsedTask[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tasks.push({ id: 'task-' + (tasks.length + 1), text: part, keywords: keywordsOf(part) });
  }
  if (tasks.length === 0) {
    return { ok: false, reason: 'goal-empty' };
  }
  return { ok: true, tasks };
}

export interface NarratableStep {
  action?: unknown;
  target?: unknown;
  value?: unknown;
  direction?: unknown;
  key?: unknown;
  count?: unknown;
}

export interface NarrationVerdict {
  ok: boolean;
  reason?: string;
  text?: string;
}

const TARGET_REQUIRED = new Set([
  'click',
  'tap',
  'type',
  'scroll',
  'drag',
  'hover',
  'wait',
  'assert',
  'upload',
  'menu',
  'long-press',
]);

export function narrate(step: NarratableStep): NarrationVerdict {
  const action = typeof step?.action === 'string' ? step.action.trim().toLowerCase() : '';
  if (action.length === 0) {
    return { ok: false, reason: 'narration-action-missing' };
  }
  const target = typeof step.target === 'string' ? step.target.trim() : '';
  if (TARGET_REQUIRED.has(action) && target.length === 0) {
    return { ok: false, reason: 'narration-missing-target:' + action };
  }
  switch (action) {
    case 'click':
    case 'tap':
      return { ok: true, text: 'Clicking ' + target };
    case 'type': {
      const value = typeof step.value === 'string' ? step.value : '';
      return { ok: true, text: 'Typing ' + value.length + ' characters into ' + target };
    }
    case 'scroll': {
      const dir =
        typeof step.direction === 'string' && step.direction.length > 0
          ? step.direction
          : 'down';
      const count =
        Number.isInteger(step.count) && (step.count as number) > 0
          ? (step.count as number)
          : 1;
      return { ok: true, text: 'Scrolling ' + dir + ' ' + count + ' time(s) on ' + target };
    }
    case 'drag':
      return { ok: true, text: 'Dragging ' + target };
    case 'hover':
      return { ok: true, text: 'Hovering over ' + target };
    case 'key': {
      const key = typeof step.key === 'string' && step.key.length > 0 ? step.key : 'unknown-key';
      return { ok: true, text: 'Pressing ' + key };
    }
    case 'upload':
      return { ok: true, text: 'Uploading a file to ' + target };
    case 'navigate':
      return { ok: true, text: 'Opening ' + (target.length > 0 ? target : 'the app') };
    case 'wait':
      return { ok: true, text: 'Waiting for ' + target };
    case 'assert':
      return { ok: true, text: 'Checking ' + target };
    case 'swipe': {
      const dir =
        typeof step.direction === 'string' && step.direction.length > 0
          ? step.direction
          : 'left';
      return { ok: true, text: 'Swiping ' + dir + (target.length > 0 ? ' on ' + target : '') };
    }
    case 'long-press':
      return { ok: true, text: 'Long-pressing ' + target };
    case 'pinch':
      return { ok: true, text: 'Pinching ' + (target.length > 0 ? target : 'the screen') };
    case 'multi-touch':
      return {
        ok: true,
        text: 'Multi-touching ' + (target.length > 0 ? target : 'the screen'),
      };
    case 'stylus-pressure':
      return {
        ok: true,
        text: 'Drawing with stylus pressure on ' + (target.length > 0 ? target : 'the canvas'),
      };
    case 'back':
      return { ok: true, text: 'Pressing back' };
    case 'home':
      return { ok: true, text: 'Going home' };
    case 'rotate':
      return { ok: true, text: 'Rotating the device' };
    case 'install':
      return { ok: true, text: 'Installing the app build' };
    case 'terminate':
      return { ok: true, text: 'Terminating the app' };
    case 'menu':
      return { ok: true, text: 'Opening menu ' + target };
    case 'window-resize':
      return { ok: true, text: 'Resizing the window' };
    case 'file-dialog':
      return { ok: true, text: 'Working the file dialog' };
    default:
      return { ok: false, reason: 'narration-unknown-action:' + action };
  }
}
