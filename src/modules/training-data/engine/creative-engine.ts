// AI-011 creative-engine - creative work registry with consent, approval, publication, revisions.
//
// Catalog law (ALG-14a/e, ALG-15): creative works (manhwa, music, voice) enter the registry only
// with the creator's consent on record. Every work is born pending; approval and rejection are
// decisions, publication requires approval, and revisions attach only to approved works.
// Published and rejected are terminal: nothing moves a terminal work again. Registration is
// idempotent by identity (creator:medium:title).
//
// Refusals:
//   creative-no-input / creative-no-creator / creative-invalid-medium:<medium>
//   creative-no-title / creative-no-consent / creative-consent-required / creative-no-now
//   creative-no-work-id / creative-unknown-work:<id>
//   creative-terminal-state:<status>
//   creative-unapproved
//   revision-no-content

export type CreativeMedium = 'manhwa' | 'music' | 'voice';

export const CREATIVE_MEDIA: string[] = ['manhwa', 'music', 'voice'];
export const CREATIVE_TERMINAL_STATUSES: string[] = ['published', 'rejected'];

export interface CreativeWork {
  workId: string;
  creator: string;
  medium: CreativeMedium;
  title: string;
  status: 'pending' | 'approved' | 'rejected' | 'published';
  revisions: CreativeRevision[];
  fingerprint: string;
  createdAt: number;
}

export interface CreativeRevision {
  revisionId: string;
  content: string;
  fingerprint: string;
  createdAt: number;
}

export interface RegisterCreativeInput {
  creator: string;
  medium: string;
  title: string;
  consent: { granted: boolean };
  now: number;
}

export interface SubmitRevisionInput {
  workId: string;
  content: string;
  now: number;
}

export interface WorkRef {
  workId: string;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function fp(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33 + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-8);
}

// Register a creative work. Consent is checked by the caller (AI-002) and passed in as a
// decision; a work without consent on record is refused. The works array is appended to by
// the caller on success; this function never mutates it. Duplicate identity wins.
export function registerCreativeWork(
  input: RegisterCreativeInput,
  works: CreativeWork[]
): Verdict<CreativeWork & { duplicate: boolean }> {
  if (!input) return fail('creative-no-input');
  if (!isNonEmptyString(input.creator)) return fail('creative-no-creator');
  if (!CREATIVE_MEDIA.includes(input.medium)) return fail('creative-invalid-medium:' + String(input.medium));
  if (!isNonEmptyString(input.title)) return fail('creative-no-title');
  if (!input.consent || typeof input.consent !== 'object') return fail('creative-no-consent');
  if (input.consent.granted !== true) return fail('creative-consent-required');
  if (!isNum(input.now)) return fail('creative-no-now');
  const identity = input.creator + ':' + input.medium + ':' + input.title;
  const fingerprint = 'crfp_' + fp(identity);
  const dup = works.find((w) => w.fingerprint === fingerprint);
  if (dup) return { ok: true, value: { ...dup, duplicate: true } };
  const work: CreativeWork = {
    workId: 'cr_' + (works.length + 1),
    creator: input.creator,
    medium: input.medium as CreativeMedium,
    title: input.title,
    status: 'pending',
    revisions: [],
    fingerprint,
    createdAt: input.now,
  };
  return { ok: true, value: { ...work, duplicate: false } };
}

function findWork(workId: string, works: CreativeWork[]): Verdict<CreativeWork> {
  if (!isNonEmptyString(workId)) return fail('creative-no-work-id');
  const work = works.find((w) => w.workId === workId);
  if (!work) return fail('creative-unknown-work:' + String(workId));
  if (CREATIVE_TERMINAL_STATUSES.includes(work.status)) return fail('creative-terminal-state:' + work.status);
  return { ok: true, value: work };
}

// Approve a pending or revised work. Terminal works never move again.
export function approveWork(workId: string, works: CreativeWork[]): Verdict<WorkRef & { status: CreativeWork['status'] }> {
  const found = findWork(workId, works);
  if (!found.ok) return found;
  found.value.status = 'approved';
  return { ok: true, value: { workId: found.value.workId, status: found.value.status } };
}

// Reject a work. Rejection is terminal.
export function rejectWork(workId: string, works: CreativeWork[]): Verdict<WorkRef & { status: CreativeWork['status'] }> {
  const found = findWork(workId, works);
  if (!found.ok) return found;
  found.value.status = 'rejected';
  return { ok: true, value: { workId: found.value.workId, status: found.value.status } };
}

// Publish an approved work. Publication requires approval; unapproved works are refused
// without exception, and publication is terminal.
export function publishWork(workId: string, works: CreativeWork[]): Verdict<WorkRef & { status: CreativeWork['status'] }> {
  const found = findWork(workId, works);
  if (!found.ok) return found;
  if (found.value.status !== 'approved') return fail('creative-unapproved');
  found.value.status = 'published';
  return { ok: true, value: { workId: found.value.workId, status: found.value.status } };
}

// Attach a revision to an approved work. Revisions chain on approved works only; pending,
// rejected, and published works cannot take revisions.
export function submitRevision(input: SubmitRevisionInput, works: CreativeWork[]): Verdict<CreativeRevision> {
  if (!input) return fail('creative-no-input');
  if (!isNum(input.now)) return fail('creative-no-now');
  const found = findWork(input.workId, works);
  if (!found.ok) return found;
  if (found.value.status !== 'approved') return fail('creative-unapproved');
  if (!isNonEmptyString(input.content)) return fail('revision-no-content');
  const n = found.value.revisions.length + 1;
  const revision: CreativeRevision = {
    revisionId: 'crev_' + found.value.workId + '_' + n,
    content: input.content,
    fingerprint: 'crfp_' + fp(found.value.workId + ':' + n + ':' + input.content),
    createdAt: input.now,
  };
  found.value.revisions.push(revision);
  return { ok: true, value: { ...revision } };
}
