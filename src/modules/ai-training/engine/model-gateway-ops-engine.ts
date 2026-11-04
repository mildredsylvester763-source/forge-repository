// ============================================================================
// FILE: src/modules/ai-training/engine/model-gateway-ops-engine.ts
// ============================================================================
// Gateway operations (FORGE AI-053..056). Pure decisions, no I/O.
//   redactGatewayLog / admitGatewayLog - prompt and response logging with
//       destructive redaction BEFORE storage (AI-053): secret keys, bearer
//       tokens, emails and phone numbers never reach the database; the row
//       carries only redacted text plus honest counts. Zero-retention
//       workspaces store metadata only, never content. Admission is
//       content-fingerprint idempotent; the log cap is a loud named refusal,
//       never a silent drop.
//   planLogRetention / planZeroRetentionRoute - retention law for sensitive
//       workspaces (AI-054): a zero-retention workspace may only route to
//       providers that retain nothing; UNKNOWN retention counts as retention.
//   registerCapabilityMatrix / matchModelCapabilities - what each model can
//       do (AI-055): code, vision, audio, tools. A request goes to the cheapest
//       capable active model; a missing capability is refused by name, never
//       routed to a model that would hallucinate the skill.
//   normalizeToolCall / canonicalizeArgs - one tool-call shape for every
//       provider (AI-056): OpenAI JSON-string arguments, Anthropic input
//       objects and generic args all normalize; the fingerprint is invariant
//       to argument key order.
//   registerOutputSchema / validateStructuredOutput - structured-output
//       contracts (AI-056): wrong types, missing fields and illegal enum
//       values are refused by name with the exact field.
// Validation: pinned vectors + 4x500-case mulberry32(42) sweeps + order
// independence in model-gateway-ops-engine.spec.ts (CI green is ground truth).

import { ProviderDescriptor } from './model-gateway-engine';

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface RedactedText {
  text: string;
  count: number;
  findings: Array<{ kind: string; count: number }>;
}

export interface RedactedLog {
  prompt: string;
  response: string;
  redactionCount: number;
  findings: Array<{ kind: string; count: number }>;
}

export interface GatewayLogValue {
  id: string;
  providerId: string;
  modelId: string;
  prompt: string;
  response: string;
  redactionCount: number;
  findings: Array<{ kind: string; count: number }>;
  contentOmitted: boolean;
  loggedAt: number;
}

export interface LogAdmission {
  admitted: GatewayLogValue;
  duplicate: boolean;
}

export interface RetentionDecision {
  mode: string;
  persistContent: boolean;
  persistMetadata: boolean;
}

export interface RetentionRouteDecision {
  primaryId: string;
  chain: string[];
  estimatedCostUsd: number;
  providersExcluded: string[];
}

export interface CapabilityMatrixValue {
  modelId: string;
  capabilities: string[];
  maxContextTokens: number;
  costPer1kIn: number;
  costPer1kOut: number;
  active: boolean;
  fingerprint: string;
}

export interface CapabilityMatch {
  primaryId: string;
  chain: string[];
}

export interface NormalizedToolCall {
  providerId: string;
  name: string;
  args: Record<string, unknown>;
  fingerprint: string;
}

export interface OutputFieldSpec {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  enumValues?: string[];
}

export interface OutputSchemaValue {
  schemaId: string;
  fields: OutputFieldSpec[];
  fingerprint: string;
}

export interface SchemaRegistration {
  schema: OutputSchemaValue;
  duplicate: boolean;
  fingerprint: string;
}

/** The only capabilities the registry knows (AI-055). */
export const CAPABILITY_KINDS = ['code', 'vision', 'audio', 'tools'];

/** The only tool-call wire formats the normalizer speaks (AI-056). */
export const TOOLCALL_PROVIDERS = ['openai', 'anthropic', 'generic'];

/** The only retention modes a workspace may have (AI-054). */
export const RETENTION_MODES = ['standard', 'zero'];

/** Hard cap on stored gateway log entries - a loud refusal, never a silent drop. */
export const LOG_MAX_ENTRIES = 500;

/** Unknown provider retention counts as retention (conservative by law). */
export const DEFAULT_RETENTION_DAYS = 30;

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

const djb2hex8 = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-8);
};

// --- AI-053: destructive redaction BEFORE storage, with honest counts ---
const REDACTION_PATTERNS: Array<{ rx: RegExp; repl: string; kind: string }> = [
  { rx: /sk-[A-Za-z0-9_-]{8,}/g, repl: '[SECRET-KEY]', kind: 'secret-key' },
  { rx: /[Bb]earer[ ]+[A-Za-z0-9._-]{8,}/g, repl: '[TOKEN]', kind: 'token' },
  { rx: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g, repl: '[EMAIL]', kind: 'email' },
  { rx: /[+][0-9]{1,3}[- ]?([0-9][- ]?){7,12}[0-9]/g, repl: '[PHONE]', kind: 'phone' },
];

const redactText = (text: string): RedactedText => {
  let cur = text;
  let count = 0;
  const findings: Array<{ kind: string; count: number }> = [];
  for (const p of REDACTION_PATTERNS) {
    let hit = 0;
    cur = cur.replace(p.rx, () => {
      hit++;
      return p.repl;
    });
    if (hit > 0) findings.push({ kind: p.kind, count: hit });
    count += hit;
  }
  return { text: cur, count, findings };
};

export function redactGatewayLog(input: { prompt: string; response: string }): Verdict<RedactedLog> {
  const prompt = String(input.prompt ?? '');
  const response = String(input.response ?? '');
  if (prompt.trim().length === 0 && response.trim().length === 0) {
    return { ok: false, reason: 'log-empty-entry' };
  }
  const rp = redactText(prompt);
  const rr = redactText(response);
  return {
    ok: true,
    value: {
      prompt: rp.text,
      response: rr.text,
      redactionCount: rp.count + rr.count,
      findings: rp.findings.concat(rr.findings),
    },
  };
}

// --- AI-053/054: log admission. Redact first; zero-retention stores no
// content; content-fingerprint idempotent; loud cap refusal. ---
export function admitGatewayLog(input: {
  providerId: string;
  modelId: string;
  prompt: string;
  response: string;
  persistContent?: boolean;
  maxEntries?: number;
  now: number;
  entries: GatewayLogValue[];
}): Verdict<LogAdmission> {
  const providerId = String(input.providerId ?? '').trim();
  const modelId = String(input.modelId ?? '').trim();
  const prompt = String(input.prompt ?? '');
  const response = String(input.response ?? '');
  if (providerId.length === 0) {
    return { ok: false, reason: 'log-no-provider' };
  }
  const red = redactGatewayLog({ prompt, response });
  if (!red.ok) {
    return red;
  }
  const id = 'log_' + djb2hex8(providerId + ':' + modelId + ':' + prompt + ':' + response);
  const entries = input.entries ?? [];
  const dup = entries.find((e) => e.id === id);
  if (dup) {
    return { ok: true, value: { admitted: dup, duplicate: true } };
  }
  const maxEntries = input.maxEntries ?? LOG_MAX_ENTRIES;
  if (entries.length >= maxEntries) {
    return { ok: false, reason: 'log-over-cap:' + entries.length };
  }
  const persistContent = input.persistContent !== false;
  return {
    ok: true,
    value: {
      admitted: {
        id,
        providerId,
        modelId,
        prompt: persistContent ? red.value.prompt : '',
        response: persistContent ? red.value.response : '',
        redactionCount: red.value.redactionCount,
        findings: red.value.findings,
        contentOmitted: !persistContent,
        loggedAt: input.now,
      },
      duplicate: false,
    },
  };
}

// --- AI-054: the retention law of a workspace ---
export function planLogRetention(input: { workspaceRetentionMode: string }): Verdict<RetentionDecision> {
  const mode = String(input.workspaceRetentionMode ?? '');
  if (mode === 'zero') {
    return { ok: true, value: { mode, persistContent: false, persistMetadata: true } };
  }
  if (mode === 'standard') {
    return { ok: true, value: { mode, persistContent: true, persistMetadata: true } };
  }
  return { ok: false, reason: 'retention-unknown-mode:' + mode };
}

// --- AI-054: zero-retention routing. A sensitive workspace only leaves to
// providers that retain nothing; unknown retention counts as retention. ---
export function planZeroRetentionRoute(input: {
  providers: Array<ProviderDescriptor & { retentionDays?: number }>;
  workspaceRetentionMode: string;
  promptTokens: number;
  outputTokens: number;
}): Verdict<RetentionRouteDecision> {
  const providers = input.providers ?? [];
  const mode = String(input.workspaceRetentionMode ?? '');
  if (!RETENTION_MODES.includes(mode)) {
    return { ok: false, reason: 'retention-unknown-mode:' + mode };
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    return { ok: false, reason: 'retention-no-providers' };
  }
  const need = input.promptTokens + input.outputTokens;
  let eligible = providers.filter((p) => p.active);
  const excluded = providers.filter((p) => !p.active).map((p) => p.id);
  if (mode === 'zero') {
    const zero = eligible.filter((p) => (p.retentionDays ?? DEFAULT_RETENTION_DAYS) === 0);
    for (const p of eligible) {
      if ((p.retentionDays ?? DEFAULT_RETENTION_DAYS) !== 0) excluded.push(p.id);
    }
    eligible = zero;
    if (eligible.length === 0) {
      return { ok: false, reason: 'retention-no-zero-retention-providers' };
    }
  }
  const capable = eligible.filter((p) => p.maxTokens >= need);
  if (capable.length === 0) {
    return { ok: false, reason: 'retention-no-capable-provider:' + need };
  }
  const ranked = capable.slice().sort((a, b) =>
    a.costPer1kOut !== b.costPer1kOut
      ? a.costPer1kOut - b.costPer1kOut
      : a.id < b.id ? -1 : 1,
  );
  const primary = ranked[0];
  return {
    ok: true,
    value: {
      primaryId: primary.id,
      chain: ranked.map((p) => p.id),
      estimatedCostUsd: round6(
        (input.promptTokens / 1000) * primary.costPer1kIn +
        (input.outputTokens / 1000) * primary.costPer1kOut,
      ),
      providersExcluded: excluded,
    },
  };
}

// --- AI-055: capability registry - what each model can do ---
export function registerCapabilityMatrix(input: {
  modelId: string;
  capabilities: string[];
  maxContextTokens: number;
  costPer1kIn: number;
  costPer1kOut: number;
  active: boolean;
  existing: CapabilityMatrixValue[];
}): Verdict<{ matrix: CapabilityMatrixValue; duplicate: boolean; fingerprint: string }> {
  const modelId = String(input.modelId ?? '').trim();
  if (modelId.length === 0) {
    return { ok: false, reason: 'capability-no-model' };
  }
  const caps = Array.from(new Set((input.capabilities ?? []).map((c) => String(c).trim())))
    .filter(Boolean)
    .sort();
  for (const c of caps) {
    if (!CAPABILITY_KINDS.includes(c)) {
      return { ok: false, reason: 'capability-unknown:' + c };
    }
  }
  if (caps.length === 0) {
    return { ok: false, reason: 'capability-empty' };
  }
  const fingerprint = 'cap_' + djb2hex8(
    modelId + ':' + caps.join('|') + ':' + input.maxContextTokens + ':' +
    input.costPer1kIn + ':' + input.costPer1kOut + ':' + input.active,
  );
  const dup = (input.existing ?? []).find((m) => m.fingerprint === fingerprint);
  if (dup) {
    return { ok: true, value: { matrix: dup, duplicate: true, fingerprint } };
  }
  return {
    ok: true,
    value: {
      matrix: {
        modelId,
        capabilities: caps,
        maxContextTokens: input.maxContextTokens,
        costPer1kIn: input.costPer1kIn,
        costPer1kOut: input.costPer1kOut,
        active: input.active,
        fingerprint,
      },
      duplicate: false,
      fingerprint,
    },
  };
}

// --- AI-055: the cheapest capable active model wins; a capability no
// active model has is refused by name, never guessed around. ---
export function matchModelCapabilities(input: {
  required: string[];
  models: CapabilityMatrixValue[];
  promptTokens: number;
  outputTokens: number;
}): Verdict<CapabilityMatch> {
  const required = Array.from(new Set((input.required ?? []).map((c) => String(c).trim())))
    .filter(Boolean);
  for (const c of required) {
    if (!CAPABILITY_KINDS.includes(c)) {
      return { ok: false, reason: 'capability-unknown:' + c };
    }
  }
  const models = input.models ?? [];
  if (models.length === 0) {
    return { ok: false, reason: 'capability-no-models' };
  }
  const active = models.filter((m) => m.active);
  for (const c of required) {
    if (!active.some((m) => m.capabilities.includes(c))) {
      return { ok: false, reason: 'capability-no-model-supports:' + c };
    }
  }
  const need = input.promptTokens + input.outputTokens;
  const capable = active
    .filter((m) => required.every((c) => m.capabilities.includes(c)))
    .filter((m) => m.maxContextTokens >= need);
  if (capable.length === 0) {
    return { ok: false, reason: 'capability-no-capable-model:' + need };
  }
  const ranked = capable.slice().sort((a, b) =>
    a.costPer1kOut !== b.costPer1kOut
      ? a.costPer1kOut - b.costPer1kOut
      : a.modelId < b.modelId ? -1 : 1,
  );
  return {
    ok: true,
    value: { primaryId: ranked[0].modelId, chain: ranked.map((m) => m.modelId) },
  };
}

// --- AI-056: one tool-call shape for every provider. The fingerprint is
// invariant to argument key order (canonical form sorts keys). ---
export function canonicalizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = args[k];
    const encoded = Array.isArray(v)
      ? '[' + v.map((x) => JSON.stringify(x)).join(',') + ']'
      : v !== null && typeof v === 'object'
        ? JSON.stringify(v)
        : JSON.stringify(v);
    parts.push(JSON.stringify(k) + ':' + encoded);
  }
  return parts.join('|');
}

export function normalizeToolCall(input: {
  providerId: string;
  name?: string;
  argumentsJson?: string;
  args?: Record<string, unknown>;
}): Verdict<NormalizedToolCall> {
  const providerId = String(input.providerId ?? '');
  if (!TOOLCALL_PROVIDERS.includes(providerId)) {
    return { ok: false, reason: 'toolcall-unknown-provider:' + providerId };
  }
  const name = String(input.name ?? '').trim();
  if (name.length === 0) {
    return { ok: false, reason: 'toolcall-missing-name' };
  }
  let parsed: Record<string, unknown> | undefined;
  if (providerId === 'openai') {
    if (typeof input.argumentsJson !== 'string') {
      return { ok: false, reason: 'toolcall-missing-arguments' };
    }
    try {
      parsed = JSON.parse(input.argumentsJson) as Record<string, unknown>;
    } catch {
      return { ok: false, reason: 'toolcall-invalid-arguments' };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'toolcall-invalid-arguments' };
    }
  } else {
    const args = input.args;
    if (args === null || args === undefined || typeof args !== 'object' || Array.isArray(args)) {
      return { ok: false, reason: 'toolcall-missing-arguments' };
    }
    parsed = args as Record<string, unknown>;
  }
  const fingerprint = 'tc_' + djb2hex8(providerId + ':' + name + ':' + canonicalizeArgs(parsed));
  return { ok: true, value: { providerId, name, args: parsed, fingerprint } };
}

// --- AI-056: structured-output contracts, fingerprint idempotent ---
export function registerOutputSchema(input: {
  schemaId: string;
  fields: OutputFieldSpec[];
  existing: OutputSchemaValue[];
}): Verdict<SchemaRegistration> {
  const schemaId = String(input.schemaId ?? '').trim();
  if (schemaId.length === 0) {
    return { ok: false, reason: 'schema-no-id' };
  }
  const fields = input.fields ?? [];
  if (!Array.isArray(fields) || fields.length === 0) {
    return { ok: false, reason: 'schema-no-fields' };
  }
  const types = ['string', 'number', 'boolean', 'object', 'array'];
  for (const f of fields) {
    if (!String(f.name ?? '').trim()) {
      return { ok: false, reason: 'schema-field-no-name' };
    }
    if (!types.includes(f.type)) {
      return { ok: false, reason: 'schema-unknown-type:' + f.type };
    }
  }
  const canonical = fields
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((f) =>
      f.name + ':' + f.type + ':' + (f.required !== false) + ':' +
      (f.enumValues ? f.enumValues.join(',') : ''),
    )
    .join('|');
  const fingerprint = 'os_' + djb2hex8(schemaId + ':' + canonical);
  const dup = (input.existing ?? []).find((s) => s.fingerprint === fingerprint);
  if (dup) {
    return { ok: true, value: { schema: dup, duplicate: true, fingerprint } };
  }
  return {
    ok: true,
    value: { schema: { schemaId, fields, fingerprint }, duplicate: false, fingerprint },
  };
}

// --- AI-056: strict structured-output validation, refusals name the field ---
export function validateStructuredOutput(input: {
  fields: OutputFieldSpec[];
  output: unknown;
}): Verdict<{ fieldsChecked: number }> {
  const output = input.output;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, reason: 'output-not-object' };
  }
  for (const f of input.fields ?? []) {
    const v = (output as Record<string, unknown>)[f.name];
    if (v === undefined) {
      if (f.required !== false) {
        return { ok: false, reason: 'output-missing-field:' + f.name };
      }
      continue;
    }
    const t = typeof v;
    if (f.type === 'array' && !Array.isArray(v)) {
      return { ok: false, reason: 'output-wrong-type:' + f.name + ':array' };
    }
    if (f.type === 'object' && (t !== 'object' || Array.isArray(v))) {
      return { ok: false, reason: 'output-wrong-type:' + f.name + ':object' };
    }
    if (f.type !== 'array' && f.type !== 'object' && t !== f.type) {
      return { ok: false, reason: 'output-wrong-type:' + f.name + ':' + f.type };
    }
    if (f.enumValues && f.enumValues.length > 0 && !f.enumValues.includes(v as string)) {
      return { ok: false, reason: 'output-not-enum:' + f.name + ':' + String(v) };
    }
  }
  return { ok: true, value: { fieldsChecked: (input.fields ?? []).length } };
}