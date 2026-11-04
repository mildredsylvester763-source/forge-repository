import { createHash, randomUUID } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type TriggerKind = 'push' | 'pull_request' | 'schedule' | 'event' | 'manual' | 'api';

export interface PipelineTrigger {
  readonly id: string;
  readonly kind: TriggerKind;
  /** Exact FORGE event type required when kind is 'event'. */
  readonly eventType?: string;
  readonly branches?: readonly string[];
  /** Ordered glob rules. A leading ! excludes; a later positive rule may include again. */
  readonly paths?: readonly string[];
  /** Stable identifier emitted by the scheduler for a schedule occurrence. */
  readonly scheduleId?: string;
  readonly cron?: string;
  readonly timeZone?: string;
}

export type Condition =
  | { readonly op: 'all' | 'any'; readonly conditions: readonly Condition[] }
  | { readonly op: 'not'; readonly condition: Condition }
  | { readonly op: 'eq'; readonly field: string; readonly value: JsonPrimitive }
  | { readonly op: 'in'; readonly field: string; readonly values: readonly JsonPrimitive[] }
  | { readonly op: 'exists'; readonly field: string; readonly expected?: boolean };

export interface PipelineStep {
  readonly id: string;
  /** A registered task name, not arbitrary source code or a shell command. */
  readonly task: string;
  readonly needs?: readonly string[];
  readonly when?: Condition;
  readonly paths?: readonly string[];
  readonly params?: { readonly [key: string]: JsonValue };
}

export type PipelineInputType = 'string' | 'number' | 'boolean' | 'secret_ref';
export type PipelineInputValue = string | number | boolean;

export interface PipelineInputDefinition {
  readonly name: string;
  readonly type: PipelineInputType;
  readonly description?: string;
  readonly required?: boolean;
  readonly default?: PipelineInputValue;
  readonly options?: readonly PipelineInputValue[];
}

export interface PipelineDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly inputs?: readonly PipelineInputDefinition[];
  readonly triggers: readonly PipelineTrigger[];
  readonly steps: readonly PipelineStep[];
}

export interface TriggerEvent {
  readonly kind: TriggerKind;
  readonly source: string;
  readonly eventType?: string;
  readonly eventId: string;
  readonly branch?: string;
  /** Pull-request filters use the target/base branch, not the contributor's head branch. */
  readonly baseBranch?: string;
  readonly changedFiles?: readonly string[];
  readonly scheduleId?: string;
  readonly commitSha?: string;
  readonly pullRequestNumber?: number;
  readonly payload?: { readonly [key: string]: JsonValue };
}

export class PipelineDefinitionError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid pipeline definition: ${issues.join('; ')}`);
    this.name = 'PipelineDefinitionError';
    this.issues = issues;
  }
}

export class PipelineGraphError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid pipeline graph: ${issues.join('; ')}`);
    this.name = 'PipelineGraphError';
    this.issues = issues;
  }
}

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const TASK = /^[a-z][a-z0-9_.-]{0,127}$/;
const INPUT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SECRET_REF = /^workspace\.[a-z][a-z0-9_-]{0,63}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TRIGGER_KINDS = new Set<TriggerKind>(['push', 'pull_request', 'schedule', 'event', 'manual', 'api']);
const MAX_PIPELINE_DEFINITION_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}.${key}: unknown field`);
    if (DANGEROUS_KEYS.has(key)) issues.push(`${path}.${key}: unsafe property name`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) issues.push(`${path}.${key}: required`);
}

function text(value: unknown, path: string, issues: string[], max = 256): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    issues.push(`${path}: expected a non-empty string of at most ${max} characters`);
    return undefined;
  }
  return value;
}

function stringList(value: unknown, path: string, issues: string[], maxItems = 100): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    issues.push(`${path}: expected an array containing 1..${maxItems} strings`);
    return undefined;
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    const parsed = text(item, `${path}[${index}]`, issues, 512);
    if (parsed !== undefined) result.push(parsed);
  });
  return result;
}

function validateJson(value: unknown, path: string, issues: string[], depth = 0, seen = new Set<object>()): value is JsonValue {
  if (depth > 16) {
    issues.push(`${path}: JSON nesting exceeds 16 levels`);
    return false;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issues.push(`${path}: numbers must be finite`);
    return Number.isFinite(value);
  }
  if (typeof value !== 'object') {
    issues.push(`${path}: only JSON values are allowed`);
    return false;
  }
  if (seen.has(value)) {
    issues.push(`${path}: cyclic values are not allowed`);
    return false;
  }
  seen.add(value);
  let valid = true;
  if (Array.isArray(value)) {
    if (value.length > 1000) issues.push(`${path}: arrays may contain at most 1000 items`);
    value.forEach((item, index) => { if (!validateJson(item, `${path}[${index}]`, issues, depth + 1, seen)) valid = false; });
  } else if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 256) issues.push(`${path}: objects may contain at most 256 properties`);
    for (const [key, item] of entries) {
      if (DANGEROUS_KEYS.has(key)) {
        issues.push(`${path}.${key}: unsafe property name`);
        valid = false;
      }
      if (!validateJson(item, `${path}.${key}`, issues, depth + 1, seen)) valid = false;
    }
  } else {
    issues.push(`${path}: only plain JSON objects are allowed`);
    valid = false;
  }
  seen.delete(value);
  return valid;
}

function validateField(value: unknown, path: string, issues: string[]): string | undefined {
  const field = text(value, path, issues, 128);
  if (field !== undefined && (!FIELD.test(field) || field.split('.').some((part) => DANGEROUS_KEYS.has(part)))) {
    issues.push(`${path}: invalid field path`);
    return undefined;
  }
  return field;
}

function validateCondition(value: unknown, path: string, issues: string[], depth = 0): Condition | undefined {
  if (depth > 8) {
    issues.push(`${path}: condition nesting exceeds 8 levels`);
    return undefined;
  }
  if (!isRecord(value)) {
    issues.push(`${path}: expected a condition object`);
    return undefined;
  }
  const op = value.op;
  if (op === 'all' || op === 'any') {
    exactKeys(value, ['op', 'conditions'], ['op', 'conditions'], path, issues);
    if (!Array.isArray(value.conditions) || value.conditions.length === 0 || value.conditions.length > 32) {
      issues.push(`${path}.conditions: expected 1..32 conditions`);
      return undefined;
    }
    const conditions = value.conditions.map((child, i) => validateCondition(child, `${path}.conditions[${i}]`, issues, depth + 1)).filter((c): c is Condition => c !== undefined);
    return conditions.length === value.conditions.length ? { op, conditions } : undefined;
  }
  if (op === 'not') {
    exactKeys(value, ['op', 'condition'], ['op', 'condition'], path, issues);
    const condition = validateCondition(value.condition, `${path}.condition`, issues, depth + 1);
    return condition ? { op, condition } : undefined;
  }
  if (op === 'eq' || op === 'in' || op === 'exists') {
    const allowed = op === 'eq' ? ['op', 'field', 'value'] : op === 'in' ? ['op', 'field', 'values'] : ['op', 'field', 'expected'];
    exactKeys(value, allowed, op === 'exists' ? ['op', 'field'] : ['op', 'field', op === 'eq' ? 'value' : 'values'], path, issues);
    const field = validateField(value.field, `${path}.field`, issues);
    if (!field) return undefined;
    if (op === 'eq') {
      if (!(value.value === null || ['string', 'number', 'boolean'].includes(typeof value.value)) || (typeof value.value === 'number' && !Number.isFinite(value.value))) {
        issues.push(`${path}.value: expected a JSON primitive`);
        return undefined;
      }
      return { op, field, value: value.value as JsonPrimitive };
    }
    if (op === 'in') {
      if (!Array.isArray(value.values) || value.values.length === 0 || value.values.length > 100 || value.values.some((v) => !(v === null || ['string', 'number', 'boolean'].includes(typeof v)))) {
        issues.push(`${path}.values: expected 1..100 JSON primitives`);
        return undefined;
      }
      return { op, field, values: value.values as JsonPrimitive[] };
    }
    if (value.expected !== undefined && typeof value.expected !== 'boolean') {
      issues.push(`${path}.expected: expected a boolean`);
      return undefined;
    }
    return value.expected === undefined ? { op, field } : { op, field, expected: value.expected };
  }
  issues.push(`${path}.op: unsupported condition operator`);
  return undefined;
}


function validateGlobList(value: unknown, path: string, issues: string[]): string[] | undefined {
  const patterns = stringList(value, path, issues, 100);
  if (!patterns) return undefined;
  let hasPositive = false;
  patterns.forEach((pattern, index) => {
    const raw = pattern.startsWith('!') ? pattern.slice(1) : pattern;
    if (!pattern.startsWith('!')) hasPositive = true;
    if (!raw || raw.startsWith('/') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw) || raw.split('/').some((part) => part === '' || part === '.' || part === '..') || /[\[\]{}]/.test(raw)) {
      issues.push(`${path}[${index}]: unsupported or unsafe glob pattern`);
    }
  });
  if (!hasPositive) issues.push(`${path}: at least one positive pattern is required`);
  return patterns;
}

function validCronField(field: string, min: number, max: number): boolean {
  return field.split(',').every((part) => {
    if (!part) return false;
    const [base, stepText, extra] = part.split('/');
    if (extra !== undefined) return false;
    if (stepText !== undefined && (!/^\d+$/.test(stepText) || Number(stepText) < 1 || Number(stepText) > max - min + 1)) return false;
    if (base === undefined) return false;
    if (base === '*') return true;
    const range = base.split('-');
    if (range.length > 2 || range.some((piece) => !/^\d+$/.test(piece))) return false;
    const values = range.map(Number);
    return values.every((n) => n >= min && n <= max) && (values.length === 1 || values[0]! <= values[1]!);
  });
}

function validateCron(value: unknown, path: string, issues: string[]): string | undefined {
  const cron = text(value, path, issues, 128);
  if (cron !== undefined) {
    const fields = cron.trim().split(/\s+/);
    const bounds: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    if (fields.length !== 5 || fields.some((field, index) => {
      const bound = bounds[index];
      return !bound || !validCronField(field, bound[0], bound[1]);
    })) {
      issues.push(`${path}: expected a valid five-field cron expression (minute hour day month weekday)`);
      return undefined;
    }
  }
  return cron;
}

/** Strict runtime validation. Unknown keys fail rather than being silently ignored. */
export function validatePipelineDefinition(input: unknown): PipelineDefinition {
  const issues: string[] = [];
  if (!isRecord(input)) throw new PipelineDefinitionError(['root: expected an object']);
  exactKeys(input, ['id', 'name', 'description', 'inputs', 'triggers', 'steps'], ['id', 'name', 'triggers', 'steps'], 'root', issues);
  const id = text(input.id, 'id', issues, 64);
  if (id && !ID.test(id)) issues.push('id: must start with a lowercase letter and contain only lowercase letters, digits or hyphens');
  const name = text(input.name, 'name', issues, 100);
  const description = input.description === undefined ? undefined : text(input.description, 'description', issues, 1000);

  const inputs: PipelineInputDefinition[] = [];
  if (input.inputs !== undefined) {
    if (!Array.isArray(input.inputs) || input.inputs.length > 50) {
      issues.push('inputs: expected at most 50 input definitions');
    } else {
      const seenInputNames = new Set<string>();
      input.inputs.forEach((raw, index) => {
        const path = `inputs[${index}]`;
        if (!isRecord(raw)) { issues.push(`${path}: expected an object`); return; }
        exactKeys(raw, ['name', 'type', 'description', 'required', 'default', 'options'], ['name', 'type'], path, issues);
        const name = text(raw.name, `${path}.name`, issues, 64);
        if (name && !INPUT_NAME.test(name)) issues.push(`${path}.name: use lowercase letters, digits and underscores; start with a letter`);
        if (name && seenInputNames.has(name)) issues.push(`${path}.name: duplicate input name`);
        if (name) seenInputNames.add(name);
        const type = raw.type;
        if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'secret_ref') {
          issues.push(`${path}.type: expected string, number, boolean or secret_ref`);
        }
        const description = raw.description === undefined ? undefined : text(raw.description, `${path}.description`, issues, 500);
        if (raw.required !== undefined && typeof raw.required !== 'boolean') issues.push(`${path}.required: expected a boolean`);
        const required = raw.required === undefined ? raw.default === undefined : raw.required as boolean;
        const matchesType = (value: unknown): value is PipelineInputValue => {
          if (type === 'string') return typeof value === 'string' && value.length <= 4096;
          if (type === 'secret_ref') return typeof value === 'string' && SECRET_REF.test(value);
          if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
          if (type === 'boolean') return typeof value === 'boolean';
          return false;
        };
        if (raw.default !== undefined && !matchesType(raw.default)) issues.push(`${path}.default: value does not match input type`);
        if (type === 'secret_ref' && (raw.default !== undefined || raw.options !== undefined)) issues.push(`${path}: secret_ref inputs cannot define defaults or allowed-value lists; the consuming workspace must supply its own reference`);
        if (required && raw.default !== undefined) issues.push(`${path}: required inputs cannot also define a default`);
        let options: PipelineInputValue[] | undefined;
        if (raw.options !== undefined) {
          if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > 100) {
            issues.push(`${path}.options: expected 1..100 allowed values`);
          } else {
            options = [];
            raw.options.forEach((option, optionIndex) => {
              if (!matchesType(option)) issues.push(`${path}.options[${optionIndex}]: value does not match input type`);
              else options?.push(option);
            });
            if (new Set(options.map((value) => JSON.stringify(value))).size !== options.length) issues.push(`${path}.options: duplicate allowed value`);
            if (raw.default !== undefined && !options.some((value) => Object.is(value, raw.default))) issues.push(`${path}.default: value must be included in options`);
          }
        }
        if (name && (type === 'string' || type === 'number' || type === 'boolean' || type === 'secret_ref')) {
          inputs.push({
            name, type,
            ...(description !== undefined ? { description } : {}),
            required,
            ...(raw.default !== undefined && matchesType(raw.default) ? { default: raw.default } : {}),
            ...(options ? { options } : {}),
          });
        }
      });
    }
  }

  const triggers: PipelineTrigger[] = [];
  if (!Array.isArray(input.triggers) || input.triggers.length === 0 || input.triggers.length > 20) {
    issues.push('triggers: expected 1..20 trigger definitions');
  } else {
    const seenTriggerIds = new Set<string>();
    input.triggers.forEach((raw, index) => {
      const path = `triggers[${index}]`;
      if (!isRecord(raw)) { issues.push(`${path}: expected an object`); return; }
      exactKeys(raw, ['id', 'kind', 'eventType', 'branches', 'paths', 'scheduleId', 'cron', 'timeZone'], ['id', 'kind'], path, issues);
      const triggerId = text(raw.id, `${path}.id`, issues, 64);
      if (triggerId && !ID.test(triggerId)) issues.push(`${path}.id: invalid identifier`);
      if (triggerId && seenTriggerIds.has(triggerId)) issues.push(`${path}.id: duplicate trigger identifier`);
      if (triggerId) seenTriggerIds.add(triggerId);
      if (typeof raw.kind !== 'string' || !TRIGGER_KINDS.has(raw.kind as TriggerKind)) issues.push(`${path}.kind: unsupported trigger kind`);
      const kind = raw.kind as TriggerKind;
      const eventType = kind === 'event' ? text(raw.eventType, `${path}.eventType`, issues, 128) : undefined;
      if (kind === 'event' && eventType && !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(eventType)) issues.push(`${path}.eventType: expected a dotted FORGE event type`);
      if (kind !== 'event' && raw.eventType !== undefined) issues.push(`${path}.eventType: only valid for event triggers`);
      const branches = raw.branches === undefined ? undefined : validateGlobList(raw.branches, `${path}.branches`, issues);
      const paths = raw.paths === undefined ? undefined : validateGlobList(raw.paths, `${path}.paths`, issues);
      let scheduleId: string | undefined;
      let cron: string | undefined;
      let timeZone: string | undefined;
      if (kind === 'schedule') {
        scheduleId = text(raw.scheduleId, `${path}.scheduleId`, issues, 128);
        cron = validateCron(raw.cron, `${path}.cron`, issues);
        timeZone = raw.timeZone === undefined ? 'UTC' : text(raw.timeZone, `${path}.timeZone`, issues, 128);
        if (timeZone) {
          try { new Intl.DateTimeFormat('en', { timeZone }).format(0); }
          catch { issues.push(`${path}.timeZone: invalid IANA time zone`); }
        }
        if (branches || paths) issues.push(`${path}: schedule triggers do not accept branch or path filters`);
      } else if (raw.scheduleId !== undefined || raw.cron !== undefined || raw.timeZone !== undefined) {
        issues.push(`${path}: schedule fields are only valid for schedule triggers`);
      }
      if (triggerId && TRIGGER_KINDS.has(kind) && (kind !== 'schedule' || (scheduleId && cron))) {
        triggers.push({
          id: triggerId, kind,
          ...(branches ? { branches } : {}), ...(paths ? { paths } : {}),
          ...(eventType ? { eventType } : {}), ...(scheduleId ? { scheduleId } : {}), ...(cron ? { cron } : {}), ...(timeZone ? { timeZone } : {}),
        });
      }
    });
  }

  const steps: PipelineStep[] = [];
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 100) {
    issues.push('steps: expected 1..100 step definitions');
  } else {
    const seenStepIds = new Set<string>();
    input.steps.forEach((raw, index) => {
      const path = `steps[${index}]`;
      if (!isRecord(raw)) { issues.push(`${path}: expected an object`); return; }
      exactKeys(raw, ['id', 'task', 'needs', 'when', 'paths', 'params'], ['id', 'task'], path, issues);
      const stepId = text(raw.id, `${path}.id`, issues, 64);
      if (stepId && !ID.test(stepId)) issues.push(`${path}.id: invalid identifier`);
      if (stepId && seenStepIds.has(stepId)) issues.push(`${path}.id: duplicate step identifier`);
      if (stepId) seenStepIds.add(stepId);
      const task = text(raw.task, `${path}.task`, issues, 128);
      if (task && !TASK.test(task)) issues.push(`${path}.task: invalid registered task name`);
      const needs = raw.needs === undefined ? undefined : stringList(raw.needs, `${path}.needs`, issues, 100);
      if (needs && new Set(needs).size !== needs.length) issues.push(`${path}.needs: duplicate dependency`);
      const when = raw.when === undefined ? undefined : validateCondition(raw.when, `${path}.when`, issues);
      const paths = raw.paths === undefined ? undefined : validateGlobList(raw.paths, `${path}.paths`, issues);
      let params: { [key: string]: JsonValue } | undefined;
      if (raw.params !== undefined) {
        if (!isRecord(raw.params)) issues.push(`${path}.params: expected a JSON object`);
        else if (validateJson(raw.params, `${path}.params`, issues)) params = raw.params as { [key: string]: JsonValue };
      }
      if (stepId && task) steps.push({ id: stepId, task, ...(needs ? { needs } : {}), ...(when ? { when } : {}), ...(paths ? { paths } : {}), ...(params ? { params } : {}) });
    });
  }

  if (issues.length > 0) throw new PipelineDefinitionError(issues);
  const definition: PipelineDefinition = {
    id: id as string,
    name: name as string,
    ...(description !== undefined ? { description } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    triggers,
    steps,
  };
  const serialized = JSON.stringify(definition);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PIPELINE_DEFINITION_BYTES) {
    throw new PipelineDefinitionError([`root: serialized pipeline definition exceeds ${MAX_PIPELINE_DEFINITION_BYTES} bytes`]);
  }
  orderPipelineSteps(definition);
  return deepFreeze(JSON.parse(serialized) as PipelineDefinition);
}

/** Resolve and validate invocation inputs without resolving secret references into secret material. */
export function resolvePipelineInputs(
  definition: PipelineDefinition,
  supplied: unknown = {},
): Readonly<Record<string, PipelineInputValue>> {
  if (!isRecord(supplied)) throw new PipelineDefinitionError(['inputs: expected an object']);
  const declarations = definition.inputs ?? [];
  const byName = new Map(declarations.map((item) => [item.name, item]));
  const issues: string[] = [];
  for (const key of Object.keys(supplied)) {
    if (!byName.has(key)) issues.push(`inputs.${key}: undeclared input`);
    if (DANGEROUS_KEYS.has(key)) issues.push(`inputs.${key}: unsafe property name`);
  }
  const resolved: Record<string, PipelineInputValue> = {};
  for (const declaration of declarations) {
    const provided = Object.hasOwn(supplied, declaration.name);
    const value = provided ? supplied[declaration.name] : declaration.default;
    if (value === undefined) {
      if (declaration.required) issues.push(`inputs.${declaration.name}: required value is missing`);
      continue;
    }
    const valid =
      declaration.type === 'string' ? typeof value === 'string' && value.length <= 4096 :
      declaration.type === 'secret_ref' ? typeof value === 'string' && SECRET_REF.test(value) :
      declaration.type === 'number' ? typeof value === 'number' && Number.isFinite(value) :
      declaration.type === 'boolean' ? typeof value === 'boolean' : false;
    if (!valid) {
      issues.push(`inputs.${declaration.name}: value does not match declared type ${declaration.type}`);
      continue;
    }
    if (declaration.options && !declaration.options.some((option) => Object.is(option, value))) {
      issues.push(`inputs.${declaration.name}: value is not in the allowed options`);
      continue;
    }
    resolved[declaration.name] = value as PipelineInputValue;
  }
  if (issues.length > 0) throw new PipelineDefinitionError(issues);
  return deepFreeze(resolved);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

/** Stable topological levels. Steps in one level have no dependencies on each other and may run in parallel. */
export function orderPipelineSteps(definition: Pick<PipelineDefinition, 'steps'>): readonly (readonly string[])[] {
  const byId = new Map(definition.steps.map((step) => [step.id, step]));
  const completed = new Set<string>();
  const levels: string[][] = [];
  const issues: string[] = [];
  for (const step of definition.steps) {
    for (const dependency of step.needs ?? []) {
      if (!byId.has(dependency)) issues.push(`${step.id}: unknown dependency ${dependency}`);
      if (dependency === step.id) issues.push(`${step.id}: step cannot depend on itself`);
    }
  }
  if (issues.length) throw new PipelineGraphError(issues);
  while (completed.size < definition.steps.length) {
    const ready = definition.steps.filter((step) => !completed.has(step.id) && (step.needs ?? []).every((dependency) => completed.has(dependency)));
    if (ready.length === 0) {
      const blocked = definition.steps.filter((step) => !completed.has(step.id)).map((step) => step.id);
      throw new PipelineGraphError([`dependency cycle involving: ${blocked.join(', ')}`]);
    }
    const level = ready.map((step) => step.id);
    levels.push(level);
    level.forEach((id) => completed.add(id));
  }
  return levels.map((level) => Object.freeze(level));
}

function globRegex(pattern: string): RegExp {
  let output = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') { output += '(?:.*/)?'; i += 1; }
        else output += '.*';
      } else output += '[^/]*';
    } else if (char === '?') output += '[^/]';
    else output += char.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return new RegExp(`${output}$`);
}

/** Ordered GitHub-style path/branch glob evaluation. `!pattern` excludes; later positive rules can re-include. */
export function matchesOrderedPatterns(value: string, patterns: readonly string[]): boolean {
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith('!');
    if (globRegex(negative ? pattern.slice(1) : pattern).test(value)) included = !negative;
  }
  return included;
}

export interface PathMatch {
  readonly matched: boolean;
  readonly degraded: boolean;
  readonly reason?: 'changed_files_unavailable' | 'no_changed_files' | 'no_path_match';
}

/** Missing diffs fail open: an unavailable diff must not silently suppress required validation. */
export function evaluatePathFilter(patterns: readonly string[] | undefined, changedFiles: readonly string[] | undefined): PathMatch {
  if (!patterns || patterns.length === 0) return { matched: true, degraded: false };
  if (changedFiles === undefined) return { matched: true, degraded: true, reason: 'changed_files_unavailable' };
  if (changedFiles.length === 0) return { matched: false, degraded: false, reason: 'no_changed_files' };
  return changedFiles.some((path) => matchesOrderedPatterns(path, patterns))
    ? { matched: true, degraded: false }
    : { matched: false, degraded: false, reason: 'no_path_match' };
}

function fieldValue(context: unknown, field: string): unknown {
  let current: unknown = context;
  for (const part of field.split('.')) {
    if (!isRecord(current) || DANGEROUS_KEYS.has(part) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

export function evaluateCondition(condition: Condition, context: unknown): boolean {
  switch (condition.op) {
    case 'all': return condition.conditions.every((child) => evaluateCondition(child, context));
    case 'any': return condition.conditions.some((child) => evaluateCondition(child, context));
    case 'not': return !evaluateCondition(condition.condition, context);
    case 'eq': return Object.is(fieldValue(context, condition.field), condition.value);
    case 'in': return condition.values.some((value) => Object.is(fieldValue(context, condition.field), value));
    case 'exists': return (fieldValue(context, condition.field) !== undefined) === (condition.expected ?? true);
  }
}

export interface TriggerEvaluation {
  readonly triggerId: string;
  readonly matched: boolean;
  readonly degraded: boolean;
  readonly reasons: readonly string[];
}

export function evaluateTrigger(trigger: PipelineTrigger, event: TriggerEvent): TriggerEvaluation {
  const reasons: string[] = [];
  if (trigger.kind !== event.kind) return { triggerId: trigger.id, matched: false, degraded: false, reasons: ['event_kind_mismatch'] };
  if (trigger.kind === 'schedule' && trigger.scheduleId !== event.scheduleId) {
    return { triggerId: trigger.id, matched: false, degraded: false, reasons: ['schedule_id_mismatch'] };
  }
  if (trigger.kind === 'event' && trigger.eventType !== event.eventType) {
    return { triggerId: trigger.id, matched: false, degraded: false, reasons: ['event_type_mismatch'] };
  }
  const branch = event.kind === 'pull_request' ? event.baseBranch : event.branch;
  if (trigger.branches) {
    if (!branch || !matchesOrderedPatterns(branch, trigger.branches)) reasons.push('branch_filter_mismatch');
  }
  const pathResult = evaluatePathFilter(trigger.paths, event.changedFiles);
  if (!pathResult.matched) reasons.push(pathResult.reason ?? 'path_filter_mismatch');
  if (pathResult.degraded) reasons.push('changed_files_unavailable_fail_open');
  return { triggerId: trigger.id, matched: reasons.every((reason) => reason === 'changed_files_unavailable_fail_open'), degraded: pathResult.degraded, reasons };
}

export function evaluatePipelineTriggers(triggers: readonly PipelineTrigger[], event: TriggerEvent): readonly TriggerEvaluation[] {
  return triggers.map((trigger) => evaluateTrigger(trigger, event));
}

export function triggerIdempotencyKey(workspaceId: string, pipelineId: string, event: Pick<TriggerEvent, 'source' | 'eventId'>): string {
  if (!workspaceId || !pipelineId || !event.source || !event.eventId) throw new TypeError('workspace, pipeline, event source and event ID are required');
  return createHash('sha256').update(JSON.stringify([workspaceId, pipelineId, event.source, event.eventId])).digest('hex');
}

export interface DryRunStep {
  readonly stepId: string;
  readonly task: string;
  readonly status: 'included' | 'skipped';
  readonly reasons: readonly string[];
  readonly needs: readonly string[];
}

export interface DryRunPlan {
  readonly dryRun: true;
  readonly pipelineId: string;
  readonly triggered: boolean | null;
  readonly triggerEvaluations: readonly TriggerEvaluation[];
  readonly parallelGroups: readonly (readonly string[])[];
  readonly steps: readonly DryRunStep[];
  readonly sideEffects: false;
  readonly resolvedInputs: Readonly<Record<string, PipelineInputValue>>;
}

/** Pure planning only: no task execution, run creation, secret resolution, queue writes or deployments. */
export function buildDryRunPlan(definition: PipelineDefinition, event?: TriggerEvent, suppliedInputs?: unknown): DryRunPlan {
  const groups = orderPipelineSteps(definition);
  const resolvedInputs = resolvePipelineInputs(definition, suppliedInputs);
  const triggerEvaluations = event ? evaluatePipelineTriggers(definition.triggers, event) : [];
  const triggered = event ? triggerEvaluations.some((item) => item.matched) : null;
  const context = event ? {
    kind: event.kind,
    eventType: event.eventType,
    source: event.source,
    eventId: event.eventId,
    branch: event.branch,
    baseBranch: event.baseBranch,
    changedFiles: event.changedFiles,
    scheduleId: event.scheduleId,
    commitSha: event.commitSha,
    pullRequestNumber: event.pullRequestNumber,
    payload: event.payload ?? {},
  } : {};
  const steps: DryRunStep[] = [];
  const statusById = new Map<string, DryRunStep['status']>();
  const stepById = new Map(definition.steps.map((step) => [step.id, step]));
  for (const level of groups) {
    for (const stepId of level) {
      const step = stepById.get(stepId);
      if (!step) continue;
      const reasons: string[] = [];
      let include = triggered !== false;
      if (triggered === false) reasons.push('pipeline_trigger_not_matched');
      const skippedDependency = (step.needs ?? []).find((dependency) => statusById.get(dependency) === 'skipped');
      if (include && skippedDependency) {
        include = false;
        reasons.push(`dependency_skipped:${skippedDependency}`);
      }
      if (include && step.when && event && !evaluateCondition(step.when, context)) {
        include = false;
        reasons.push('condition_false');
      }
      if (include && step.when && !event) reasons.push('condition_not_evaluated_without_event');
      if (include && step.paths) {
        const pathResult = evaluatePathFilter(step.paths, event?.changedFiles);
        if (!pathResult.matched) { include = false; reasons.push(pathResult.reason ?? 'step_path_filter_mismatch'); }
        if (pathResult.degraded) reasons.push('changed_files_unavailable_fail_open');
        if (!event) reasons.push('path_filter_not_evaluated_without_event');
      }
      const status = include ? 'included' : 'skipped';
      statusById.set(step.id, status);
      steps.push({ stepId: step.id, task: step.task, status, reasons, needs: step.needs ?? [] });
    }
  }
  return deepFreeze({ dryRun: true as const, pipelineId: definition.id, triggered, triggerEvaluations, parallelGroups: groups, steps, sideEffects: false as const, resolvedInputs });
}

export interface PipelineTemplateSource {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly templateHash: string;
  readonly publisherWorkspaceId: string;
}

export interface PipelineVersion {
  readonly pipelineId: string;
  readonly version: number;
  readonly definition: PipelineDefinition;
  readonly definitionHash: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly rollbackOfVersion?: number;
  readonly templateSource?: PipelineTemplateSource;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function createPipelineVersion(definitionInput: unknown, version: number, createdBy: string, createdAt = new Date().toISOString(), rollbackOfVersion?: number, templateSource?: PipelineTemplateSource): PipelineVersion {
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('version must be a positive safe integer');
  if (!createdBy.trim()) throw new TypeError('createdBy is required');
  if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError('createdAt must be a valid ISO date');
  if (rollbackOfVersion !== undefined && (!Number.isSafeInteger(rollbackOfVersion) || rollbackOfVersion < 1 || rollbackOfVersion >= version)) {
    throw new TypeError('rollbackOfVersion must identify an earlier positive version');
  }
  if (templateSource && (!templateSource.templateId.trim() || !templateSource.publisherWorkspaceId.trim() || !Number.isSafeInteger(templateSource.templateVersion) || templateSource.templateVersion < 1 || !/^[a-f0-9]{64}$/.test(templateSource.templateHash))) throw new TypeError('templateSource is invalid');
  const definition = validatePipelineDefinition(definitionInput);
  const hash = createHash('sha256').update(canonicalJson(definition)).digest('hex');
  return deepFreeze({
    pipelineId: definition.id,
    version,
    definition,
    definitionHash: hash,
    createdAt: new Date(createdAt).toISOString(),
    createdBy,
    ...(rollbackOfVersion !== undefined ? { rollbackOfVersion } : {}),
    ...(templateSource ? { templateSource: Object.freeze({ ...templateSource }) } : {}),
  });
}

/** Rollback is append-only: it creates a new version containing the selected historical definition. */
export function createRollbackVersion(history: readonly PipelineVersion[], targetVersion: number, createdBy: string, createdAt = new Date().toISOString()): PipelineVersion {
  if (history.length === 0) throw new TypeError('pipeline has no version history');
  const pipelineId = history[0]?.pipelineId;
  if (!pipelineId || history.some((item) => item.pipelineId !== pipelineId) || new Set(history.map((item) => item.version)).size !== history.length) {
    throw new TypeError('version history must belong to one pipeline and contain unique versions');
  }
  const target = history.find((item) => item.version === targetVersion);
  if (!target) throw new TypeError(`version ${targetVersion} does not exist`);
  const latest = Math.max(...history.map((item) => item.version));
  if (!Number.isSafeInteger(latest) || latest < 1) throw new TypeError('invalid version history');
  return createPipelineVersion(target.definition, latest + 1, createdBy, createdAt, targetVersion, target.templateSource);
}

export function newPipelineId(): string {
  // The prefix guarantees compatibility with the validated pipeline ID format.
  return `pipeline-${randomUUID()}`;
}
