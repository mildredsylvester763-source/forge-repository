import type { WebhookProvider } from './webhooks.ts';

export interface ProviderApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

/**
 * Authenticated, provider-bound transport supplied by the integrations subsystem.
 * The Build & CI adapter supplies only fixed API paths and bounded query values;
 * the transport owns host validation, credentials, TLS and redirect policy.
 */
export interface ProviderApiTransport {
  get(path: string, query: Readonly<Record<string, string>>): Promise<ProviderApiResponse>;
}

export interface ProviderApiTransportResolver {
  resolve(input: {
    connectionId: string;
    provider: WebhookProvider;
    workspaceId: string;
    repository: string;
  }): Promise<ProviderApiTransport | null>;
}

export interface PullRequestChangedFilesInput {
  readonly connectionId: string;
  readonly provider: WebhookProvider;
  readonly workspaceId: string;
  readonly repository: string;
  readonly pullRequestNumber: number;
}

export interface PullRequestChangedFilesResult {
  readonly paths: readonly string[];
  readonly complete: boolean;
  readonly reason?: 'connection_unavailable' | 'provider_error' | 'provider_limit' | 'incomplete_diff';
}

export interface PullRequestChangedFilesResolver {
  resolve(input: PullRequestChangedFilesInput): Promise<PullRequestChangedFilesResult>;
}

const PAGE_SIZE = 100;
const GITHUB_MAX_FILES = 3_000;
const GITLAB_MAX_FILES = 5_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function header(headers: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function validPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 ||
      value.startsWith('/') || value.includes('\\') || /[\\r\\n\\0]/.test(value)) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null;
  return value;
}

function githubNextPage(link: string | undefined): number | null | 'invalid' {
  if (!link) return null;
  const next = link.split(',').find((part) => /;\\s*rel="?next"?/i.test(part));
  if (!next) return null;
  const url = /<([^>]+)>/.exec(next)?.[1];
  if (!url) return 'invalid';
  const pageText = /[?&]page=(\\d+)/.exec(url)?.[1];
  if (!pageText) return 'invalid';
  const page = Number(pageText);
  return Number.isSafeInteger(page) && page > 0 ? page : 'invalid';
}

function gitlabNextPage(
  headers: Readonly<Record<string, string | undefined>>,
  resultCount: number,
  currentPage: number,
): number | null | 'invalid' {
  const raw = header(headers, 'x-next-page');
  if (raw !== undefined) {
    if (raw === '') return null;
    const page = Number(raw);
    return Number.isSafeInteger(page) && page > currentPage ? page : 'invalid';
  }
  // Self-managed installations or proxies may omit GitLab's pagination header.
  return resultCount === PAGE_SIZE ? currentPage + 1 : null;
}

function normalizeRepository(provider: WebhookProvider, repository: string): string[] {
  if (typeof repository !== 'string' || repository.length > 256) throw new TypeError('repository is invalid');
  const parts = repository.split('/');
  const minParts = provider === 'github' ? 2 : 2;
  if (parts.length < minParts || (provider === 'github' && parts.length !== 2) ||
      parts.some((part) => !/^[A-Za-z0-9_.-]{1,100}$/.test(part) || part === '.' || part === '..')) {
    throw new TypeError(provider === 'github'
      ? 'GitHub repository must be owner/repo.'
      : 'GitLab repository must be group[/subgroup]/project.');
  }
  return parts;
}

/**
 * Retrieves bounded, paginated pull-request/merge-request file lists. Any API
 * error, provider-side diff limit, malformed path, or pagination ceiling marks
 * the result incomplete. Callers must fail open on incomplete lists so a
 * provider limitation cannot silently suppress a required pipeline.
 */
export class ProviderPullRequestChangedFilesResolver implements PullRequestChangedFilesResolver {
  private readonly transports: ProviderApiTransportResolver;
  private readonly maxPages: number;

  constructor(transports: ProviderApiTransportResolver, options: { maxPages?: number } = {}) {
    this.transports = transports;
    this.maxPages = options.maxPages ?? 30;
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 30) {
      throw new TypeError('maxPages must be an integer from 1 to 30');
    }
  }

  async resolve(input: PullRequestChangedFilesInput): Promise<PullRequestChangedFilesResult> {
    if (typeof input.connectionId !== 'string' || !input.connectionId.trim() || input.connectionId.length > 128 ||
        typeof input.workspaceId !== 'string' || !input.workspaceId.trim() || input.workspaceId.length > 128 ||
        !Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) {
      throw new TypeError('changed-file lookup identity is invalid');
    }
    const parts = normalizeRepository(input.provider, input.repository);
    let transport: ProviderApiTransport | null;
    try {
      transport = await this.transports.resolve(input);
    } catch {
      return Object.freeze({ paths: Object.freeze([]), complete: false, reason: 'connection_unavailable' });
    }
    if (!transport) return Object.freeze({ paths: Object.freeze([]), complete: false, reason: 'connection_unavailable' });

    const endpoint = input.provider === 'github'
      ? `/repos/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}/pulls/${input.pullRequestNumber}/files`
      : `/projects/${encodeURIComponent(input.repository)}/merge_requests/${input.pullRequestNumber}/diffs`;
    const paths = new Set<string>();
    let complete = true;
    let reason: PullRequestChangedFilesResult['reason'];
    let page = 1;
    const maxFiles = input.provider === 'github' ? GITHUB_MAX_FILES : GITLAB_MAX_FILES;

    for (let pageCount = 0; pageCount < this.maxPages; pageCount += 1) {
      let response: ProviderApiResponse;
      try {
        response = await transport.get(endpoint, { per_page: String(PAGE_SIZE), page: String(page) });
      } catch {
        complete = false;
        reason = 'provider_error';
        break;
      }
      if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status >= 300) {
        complete = false;
        reason = 'provider_error';
        break;
      }
      if (!Array.isArray(response.body)) {
        complete = false;
        reason = 'incomplete_diff';
        break;
      }

      for (const entry of response.body) {
        const item = record(entry);
        if (!item) { complete = false; reason ??= 'incomplete_diff'; continue; }
        if (input.provider === 'github') {
          const path = validPath(item.filename);
          if (!path) { complete = false; reason ??= 'incomplete_diff'; }
          else paths.add(path);
        } else {
          if (item.collapsed === true || item.too_large === true) {
            complete = false;
            reason ??= 'incomplete_diff';
          }
          const oldPath = validPath(item.old_path);
          const newPath = validPath(item.new_path);
          if (!oldPath || !newPath) {
            complete = false;
            reason ??= 'incomplete_diff';
          }
          if (oldPath) paths.add(oldPath);
          if (newPath) paths.add(newPath);
        }
        if (paths.size >= maxFiles) {
          complete = false;
          reason = 'provider_limit';
          break;
        }
      }
      if (!complete && reason === 'provider_limit') break;

      const nextPage = input.provider === 'github'
        ? githubNextPage(header(response.headers, 'link'))
        : gitlabNextPage(response.headers, response.body.length, page);
      if (nextPage === null) break;
      if (nextPage === 'invalid' || nextPage !== page + 1) {
        complete = false;
        reason = 'incomplete_diff';
        break;
      }
      if (pageCount === this.maxPages - 1) {
        complete = false;
        reason = 'provider_limit';
        break;
      }
      page = nextPage;
    }

    return Object.freeze({
      paths: Object.freeze([...paths].sort()),
      complete,
      ...(reason ? { reason } : {}),
    });
  }
}
