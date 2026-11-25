import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import { LIBRARY_CATALOG, searchLibraryDocs as runLibrarySearch } from './engine/library-docs.ts';
import { RETRIEVAL_SOURCES, searchWorkspaceContent as runWorkspaceSearch } from './engine/workspace-retrieval.ts';
import { HYBRID_LANES, hybridSearch as runHybridSearch } from './engine/hybrid-search.ts';
import { rerank as runRerank } from './engine/result-rerank.ts';
import { buildResearchReport as runBuildReport, planResearch as runPlanResearch, RESEARCH_STEPS } from './engine/research-mode.ts';
import { WorkspaceRetrievalEvents, WORKSPACE_RETRIEVAL_EVENT_VERSION } from './events.ts';
import type {
  ContentItemRecord,
  ResearchReportRecord,
  WorkspaceRetrievalStore,
} from './workspace-retrieval-store.ts';

export interface WorkspaceRetrievalDeps {
  readonly store: WorkspaceRetrievalStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

const refusal = (reason: string): AppError => new AppError(400, reason, reason);

/**
 * FORGE AI-062..066 (workspace retrieval). The service records content items
 * from the five workspace sources and searches them with the pure engines:
 * version-pinned library docs, plain retrieval, hybrid three-lane search,
 * duplicate-aware re-ranking and research mode reports. Every refusal is
 * named, never a silent guess.
 */
export class WorkspaceRetrievalService {
  private readonly store: WorkspaceRetrievalStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: WorkspaceRetrievalDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  private limitOf(limit: unknown): number {
    const raw = typeof limit === 'string' ? limit : typeof limit === 'number' ? String(limit) : undefined;
    const n = Number.parseInt(raw ?? '50', 10) || 50;
    return Math.min(Math.max(n, 1), 200);
  }

  private async emit(type: string, subjectId: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.append({
      type,
      version: WORKSPACE_RETRIEVAL_EVENT_VERSION,
      actor: { kind: 'system', id: 'forge' },
      subject: { type: 'workspace_retrieval', id: subjectId },
      payload,
    });
  }

  async listLibraryCatalog(): Promise<{ name: string; versions: string[] }[]> {
    return LIBRARY_CATALOG.map((library) => ({ name: library.name, versions: [...library.versions] }));
  }

  async listRetrievalSources(): Promise<string[]> {
    return [...RETRIEVAL_SOURCES];
  }

  async listHybridLanes(): Promise<string[]> {
    return [...HYBRID_LANES];
  }

  async listResearchSteps(): Promise<string[]> {
    return [...RESEARCH_STEPS];
  }

  async searchLibraryDocs(body: unknown): Promise<unknown> {
    const verdict = runLibrarySearch((body ?? {}) as Record<string, unknown>);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'docs-refused');
    return { library: verdict.library ?? '', version: verdict.version ?? '', results: verdict.results ?? [] };
  }

  async recordContentItems(userId: string, body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const rows = Array.isArray(dto.items) ? (dto.items as Record<string, unknown>[]) : [];
    if (rows.length === 0) throw refusal('items-empty');
    if (rows.length > 200) throw refusal('items-count-invalid:' + rows.length);
    const knownIds = new Set(await this.store.listIdsByUser(userId));
    for (const row of rows) {
      const source = typeof row.source === 'string' ? row.source.trim().toLowerCase() : '';
      if (!RETRIEVAL_SOURCES.includes(source)) {
        throw refusal('item-source-unknown:' + (typeof row.source === 'string' ? row.source.trim() : String(row.source ?? '')));
      }
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      if (title.length === 0) throw refusal('item-title-missing');
      if (title.length > 500) throw refusal('item-title-too-long');
      const itemBody = typeof row.body === 'string' ? row.body : '';
      if (itemBody.trim().length === 0) throw refusal('item-body-missing');
      if (itemBody.length > 5000) throw refusal('item-body-too-long');
      if (row.links !== undefined && !Array.isArray(row.links)) throw refusal('item-links-not-array');
      const links = Array.isArray(row.links) ? (row.links as unknown[]) : [];
      if (links.length > 50) throw refusal('item-links-too-many');
      for (const link of links) {
        if (typeof link !== 'string' || link.trim().length === 0) throw refusal('item-link-missing');
        if (!knownIds.has(link.trim())) throw refusal('item-link-unknown:' + link.trim());
      }
    }
    const saved: ContentItemRecord[] = [];
    for (const row of rows) {
      saved.push(await this.store.createItem({
        userId,
        source: (typeof row.source === 'string' ? row.source : '').trim().toLowerCase(),
        title: (typeof row.title === 'string' ? row.title : '').trim(),
        body: typeof row.body === 'string' ? row.body : '',
        links: Array.isArray(row.links) ? (row.links as string[]).map((l) => l.trim()) : [],
        now: this.clock(),
      }));
    }
    await this.emit(WorkspaceRetrievalEvents.ItemsRecorded, saved[0]?.id ?? userId, { recorded: saved.length });
    return { recorded: saved.length, items: saved };
  }

  async listContentItems(userId: string, limit: unknown): Promise<ContentItemRecord[]> {
    return this.store.listItemsByUser(userId, this.limitOf(limit));
  }

  async searchWorkspace(userId: string, body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const rows = await this.store.listItemsByUser(userId, 1000);
    const verdict = runWorkspaceSearch({ items: rows, query: dto.query, sources: dto.sources });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'retrieval-refused');
    return { hits: verdict.hits ?? [] };
  }

  async hybridSearchWorkspace(userId: string, body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const rows = await this.store.listItemsByUser(userId, 1000);
    const docs = rows.map((row) => ({ id: row.id, title: row.title, body: row.body, links: [...row.links] }));
    const verdict = runHybridSearch({ docs, query: dto.query, lanes: dto.lanes, weights: dto.weights });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'hybrid-refused');
    return { hits: verdict.hits ?? [] };
  }

  async rerankResults(body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runRerank({ candidates: dto.candidates, lambda: dto.lambda, depth: dto.depth });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'rerank-refused');
    return { removedDuplicates: verdict.removedDuplicates ?? 0, results: verdict.results ?? [] };
  }

  async planResearch(body: unknown): Promise<unknown> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runPlanResearch({ topic: dto.topic, steps: dto.steps });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'research-refused');
    return { topic: verdict.topic ?? '', steps: verdict.steps ?? [], stepCount: verdict.stepCount ?? 0 };
  }

  async buildReport(userId: string, body: unknown): Promise<ResearchReportRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runBuildReport({ topic: dto.topic, findings: dto.findings, openQuestions: dto.openQuestions });
    if (!verdict.ok) throw refusal(verdict.reason ?? 'research-refused');
    const record = await this.store.createReport({
      userId,
      topic: verdict.topic ?? '',
      summary: verdict.summary ?? '',
      findings: verdict.findings ?? [],
      verifiedCount: verdict.verifiedCount ?? 0,
      unverifiedCount: verdict.unverifiedCount ?? 0,
      openQuestions: verdict.openQuestions ?? [],
      now: this.clock(),
    });
    await this.emit(WorkspaceRetrievalEvents.ReportRecorded, record.id, {
      topic: record.topic,
      verified: record.verifiedCount,
      unverified: record.unverifiedCount,
    });
    return record;
  }

  async listResearchReports(userId: string, limit: unknown): Promise<ResearchReportRecord[]> {
    return this.store.listReportsByUser(userId, this.limitOf(limit));
  }

  async getResearchReport(userId: string, body: unknown): Promise<ResearchReportRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const id = typeof dto.id === 'string' ? dto.id.trim() : '';
    const record = await this.store.findReportById(userId, id);
    if (!record) throw refusal('research-report-not-found:' + id);
    return record;
  }
}
