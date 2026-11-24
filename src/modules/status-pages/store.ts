import type { StatusComponentChange, StatusComponentRecord, StatusComponentState, StatusPageRecord } from './types.ts';
export interface StatusPageStore {
  createPage(page: StatusPageRecord): Promise<StatusPageRecord>;
  getPage(id: string): Promise<StatusPageRecord | null>;
  getPageBySlug(slug: string): Promise<StatusPageRecord | null>;
  listPages(ownerId: string): Promise<StatusPageRecord[]>;
  setPublished(id: string, ownerId: string, published: boolean, now: number): Promise<StatusPageRecord | null>;
  createComponent(component: StatusComponentRecord): Promise<StatusComponentRecord>;
  listComponents(pageId: string): Promise<StatusComponentRecord[]>;
  setComponentState(pageId: string, componentId: string, state: StatusComponentState, actorId: string, reason: string, now: number): Promise<StatusComponentRecord | null>;
  listHistory(pageId: string): Promise<StatusComponentChange[]>;
}
