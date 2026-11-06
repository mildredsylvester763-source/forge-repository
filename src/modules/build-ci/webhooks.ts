import { createHmac, timingSafeEqual } from 'node:crypto';
import type { JsonValue, TriggerEvent } from './pipeline.ts';

export type WebhookProvider = 'github' | 'gitlab';
export interface WebhookHeaders { readonly [name: string]: string | undefined; }
export interface NormalizedProviderEvent {
  readonly provider: WebhookProvider;
  readonly repository: string;
  readonly event: TriggerEvent;
}

export class WebhookPayloadError extends Error {
  constructor(message: string) { super(message); this.name = 'WebhookPayloadError'; }
}

const constantTimeEqual = (expected: string, received: string): boolean => {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

const header = (headers: WebhookHeaders, name: string): string | undefined => {
  const target = name.toLowerCase();
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === target)?.[1];
  return typeof found === 'string' ? found : undefined;
};

export function verifyGitHubWebhookSignature(rawBody: Uint8Array, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !/^sha256=[a-f0-9]{64}$/.test(signatureHeader) || secret.length < 1 || secret.length > 1024) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return constantTimeEqual(expected, signatureHeader);
}

export function verifyGitLabWebhookSignature(
  rawBody: Uint8Array,
  headers: WebhookHeaders,
  signingToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): boolean {
  const messageId = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatureHeader = header(headers, 'webhook-signature');
  if (!messageId || messageId.length > 256 || !timestamp || !/^\d{1,12}$/.test(timestamp) || !signatureHeader || signatureHeader.length > 2048) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false;
  if (!signingToken.startsWith('whsec_')) return false;
  const encodedKey = signingToken.slice('whsec_'.length);
  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) return false;
  const message = Buffer.concat([Buffer.from(`${messageId}.${timestamp}.`, 'utf8'), Buffer.from(rawBody)]);
  const expected = `v1,${createHmac('sha256', key).update(message).digest('base64')}`;
  return signatureHeader.split(' ').some((candidate) => candidate.startsWith('v1,') && constantTimeEqual(expected, candidate));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, max = 1024): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}
function positiveNumber(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}
function parseBody(rawBody: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(rawBody).toString('utf8')); }
  catch { throw new WebhookPayloadError('Webhook body is not valid JSON.'); }
  const result = object(parsed);
  if (!result) throw new WebhookPayloadError('Webhook body must be a JSON object.');
  return result;
}
interface ChangedFilesSummary {
  readonly paths?: readonly string[];
  readonly complete: boolean;
}

/**
 * Extracts paths only from the commit summaries present in a webhook. Providers
 * cap these arrays, so reaching a documented cap or observing malformed/missing
 * per-commit path metadata marks the result incomplete rather than silently
 * treating a partial list as authoritative.
 */
function pathsFromCommits(value: unknown, expectedCommitCount?: unknown, provider?: WebhookProvider): ChangedFilesSummary {
  if (!Array.isArray(value)) return Object.freeze({ complete: false });
  const paths = new Set<string>();
  let complete = true;
  if (provider === 'github' && value.length >= 2048) complete = false;
  if (provider === 'gitlab' && expectedCommitCount === undefined) complete = false;
  if (expectedCommitCount !== undefined) {
    if (!Number.isSafeInteger(expectedCommitCount) || (expectedCommitCount as number) < value.length) complete = false;
    else if ((expectedCommitCount as number) > value.length) complete = false;
  }
  for (const item of value) {
    const commit = object(item);
    if (!commit) { complete = false; continue; }
    for (const key of ['added', 'modified', 'removed']) {
      const list = commit[key];
      if (!Array.isArray(list)) { complete = false; continue; }
      for (const entry of list) {
        const path = text(entry, 1024);
        // Repository paths are untrusted webhook data. Reject absolute paths,
        // traversal segments and platform separators before any path filtering.
        if (!path || path.startsWith('/') || path.includes('\\') || /[\r\n\0]/.test(path) ||
            path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
          complete = false;
          continue;
        }
        paths.add(path);
        if (paths.size >= 5000) {
          complete = false;
          return Object.freeze({ paths: Object.freeze([...paths]), complete });
        }
      }
    }
  }
  return Object.freeze({ paths: Object.freeze([...paths]), complete });
}
function jsonPayload(values: Record<string, string | number | undefined>): { readonly [key: string]: JsonValue } {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(values)) if (value !== undefined) result[key] = value;
  return Object.freeze(result);
}

export function normalizeGitHubWebhook(rawBody: Uint8Array, headers: WebhookHeaders): NormalizedProviderEvent {
  const eventName = header(headers, 'x-github-event');
  const deliveryId = header(headers, 'x-github-delivery');
  if (!eventName || !deliveryId) throw new WebhookPayloadError('GitHub event and delivery headers are required.');
  const body = parseBody(rawBody);
  const repository = text(object(body.repository)?.full_name, 256);
  if (!repository) throw new WebhookPayloadError('GitHub repository.full_name is required.');

  if (eventName === 'push') {
    const ref = text(body.ref, 512);
    const branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
    if (!branch) throw new WebhookPayloadError('GitHub push ref must identify a branch.');
    return Object.freeze({
      provider: 'github', repository,
      event: Object.freeze({
        kind: 'push', source: 'github:push', eventType: eventName, eventId: deliveryId,
        branch, commitSha: text(body.after, 128),
        ...(() => {
          const files = pathsFromCommits(body.commits, undefined, 'github');
          return { ...(files.paths ? { changedFiles: files.paths } : {}), changedFilesComplete: files.complete };
        })(),
        payload: jsonPayload({ repository, sender: text(object(body.sender)?.login, 128) }),
      }),
    });
  }

  if (eventName === 'pull_request') {
    const pullRequest = object(body.pull_request);
    const base = object(pullRequest?.base);
    const head = object(pullRequest?.head);
    const baseBranch = text(base?.ref, 512);
    const headBranch = text(head?.ref, 512);
    const number = positiveNumber(body.number);
    if (!baseBranch || !headBranch || !number) throw new WebhookPayloadError('GitHub pull_request base, head and number are required.');
    const action = text(body.action, 64);
    return Object.freeze({
      provider: 'github', repository,
      event: Object.freeze({
        kind: 'pull_request', source: 'github:pull_request', eventType: eventName, eventId: deliveryId,
        branch: headBranch, baseBranch, pullRequestNumber: number, commitSha: text(object(head?.sha) ? object(head?.sha)?.sha : head?.sha, 128),
        payload: jsonPayload({ repository, action, draft: typeof pullRequest?.draft === 'boolean' ? String(pullRequest.draft) : undefined }),
      }),
    });
  }

  return Object.freeze({
    provider: 'github', repository,
    event: Object.freeze({
      kind: 'event', source: `github:${eventName}`, eventType: eventName, eventId: deliveryId,
      payload: jsonPayload({ repository, action: text(body.action, 64) }),
    }),
  });
}

export function normalizeGitLabWebhook(rawBody: Uint8Array, headers: WebhookHeaders): NormalizedProviderEvent {
  const eventName = header(headers, 'x-gitlab-event');
  const deliveryId = header(headers, 'webhook-id') ?? header(headers, 'idempotency-key') ?? header(headers, 'x-gitlab-event-uuid');
  if (!eventName || !deliveryId) throw new WebhookPayloadError('GitLab event and delivery ID headers are required.');
  const body = parseBody(rawBody);
  const project = object(body.project);
  const repository = text(project?.path_with_namespace, 256);
  if (!repository) throw new WebhookPayloadError('GitLab project.path_with_namespace is required.');

  if (eventName.toLowerCase() === 'push hook') {
    const ref = text(body.ref, 512);
    const branch = ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined;
    if (!branch) throw new WebhookPayloadError('GitLab push ref must identify a branch.');
    return Object.freeze({
      provider: 'gitlab', repository,
      event: Object.freeze({
        kind: 'push', source: 'gitlab:push', eventType: eventName, eventId: deliveryId,
        branch, commitSha: text(body.checkout_sha, 128),
        ...(() => {
          const files = pathsFromCommits(body.commits, body.total_commits_count, 'gitlab');
          return { ...(files.paths ? { changedFiles: files.paths } : {}), changedFilesComplete: files.complete };
        })(),
        payload: jsonPayload({ repository, user: text(body.user_username, 128) }),
      }),
    });
  }

  if (eventName.toLowerCase() === 'merge request hook') {
    const attributes = object(body.object_attributes);
    const baseBranch = text(attributes?.target_branch, 512);
    const headBranch = text(attributes?.source_branch, 512);
    const number = positiveNumber(attributes?.iid);
    if (!baseBranch || !headBranch || !number) throw new WebhookPayloadError('GitLab merge request target, source and IID are required.');
    const lastCommit = object(attributes?.last_commit);
    return Object.freeze({
      provider: 'gitlab', repository,
      event: Object.freeze({
        kind: 'pull_request', source: 'gitlab:merge_request', eventType: eventName, eventId: deliveryId,
        branch: headBranch, baseBranch, pullRequestNumber: number, commitSha: text(lastCommit?.id, 128),
        payload: jsonPayload({ repository, action: text(attributes?.action, 64), state: text(attributes?.state, 64) }),
      }),
    });
  }

  return Object.freeze({
    provider: 'gitlab', repository,
    event: Object.freeze({
      kind: 'event', source: `gitlab:${eventName}`, eventType: eventName, eventId: deliveryId,
      payload: jsonPayload({ repository }),
    }),
  });
}
