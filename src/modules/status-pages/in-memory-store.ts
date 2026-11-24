import { randomUUID } from 'node:crypto';
import type { StatusPageStore } from './store.ts';
import type { StatusComponentChange, StatusComponentRecord, StatusComponentState, StatusPageRecord } from './types.ts';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export class InMemoryStatusPageStore implements StatusPageStore {
  private readonly pages = new Map<string, StatusPageRecord>();
  private readonly components = new Map<string, StatusComponentRecord>();
  private readonly history: StatusComponentChange[] = [];
  async createPage(page: StatusPageRecord): Promise<StatusPageRecord> {
    if ([...this.pages.values()].some((item) => item.slug === page.slug)) throw new Error('status_page_slug_conflict');
    this.pages.set(page.id, copy(page)); return copy(page);
  }
  async getPage(id: string): Promise<StatusPageRecord | null> { const page = this.pages.get(id); return page ? copy(page) : null; }
  async getPageBySlug(slug: string): Promise<StatusPageRecord | null> {
    const page = [...this.pages.values()].find((item) => item.slug === slug); return page ? copy(page) : null;
  }
  async listPages(ownerId: string): Promise<StatusPageRecord[]> {
    return [...this.pages.values()].filter((item) => item.ownerId === ownerId).sort((a,b) => b.createdAt-a.createdAt || a.id.localeCompare(b.id)).map(copy);
  }
  async setPublished(id: string, ownerId: string, published: boolean, now: number): Promise<StatusPageRecord | null> {
    const current = this.pages.get(id); if (!current || current.ownerId !== ownerId) return null;
    const next = { ...current, published, updatedAt: now }; this.pages.set(id,next); return copy(next);
  }
  async createComponent(component: StatusComponentRecord): Promise<StatusComponentRecord> {
    if (!this.pages.has(component.pageId)) throw new Error('status_page_missing');
    if ([...this.components.values()].some((item) => item.pageId===component.pageId && item.name.toLowerCase()===component.name.toLowerCase())) throw new Error('status_component_name_conflict');
    this.components.set(component.id,copy(component)); return copy(component);
  }
  async listComponents(pageId: string): Promise<StatusComponentRecord[]> {
    return [...this.components.values()].filter((item)=>item.pageId===pageId).sort((a,b)=>a.position-b.position || a.createdAt-b.createdAt || a.id.localeCompare(b.id)).map(copy);
  }
  async setComponentState(pageId: string, componentId: string, state: StatusComponentState, actorId: string, reason: string, now: number): Promise<StatusComponentRecord | null> {
    const current=this.components.get(componentId); if(!current || current.pageId!==pageId) return null; if(current.state===state) return copy(current);
    const next={...current,state,updatedAt:now}; this.components.set(componentId,next);
    this.history.push({id:randomUUID(),pageId,componentId,actorId,previousState:current.state,nextState:state,reason,createdAt:now});
    const page=this.pages.get(pageId); if(page) this.pages.set(pageId,{...page,updatedAt:now});
    return copy(next);
  }
  async listHistory(pageId: string): Promise<StatusComponentChange[]> {
    return this.history.filter((item)=>item.pageId===pageId).sort((a,b)=>a.createdAt-b.createdAt || a.id.localeCompare(b.id)).map(copy);
  }
}
