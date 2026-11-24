import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { StatusPageStore } from './store.ts';
import type { StatusComponentChange, StatusComponentRecord, StatusComponentState, StatusPageRecord } from './types.ts';
interface PageRow { id:string; owner_id:string; slug:string; name:string; summary:string; published:number; created_at:number; updated_at:number; }
interface ComponentRow { id:string; page_id:string; name:string; description:string; state:StatusComponentState; position:number; created_at:number; updated_at:number; }
interface ChangeRow { id:string; page_id:string; component_id:string; actor_id:string; previous_state:StatusComponentState; next_state:StatusComponentState; reason:string; created_at:number; }
const pageRecord=(r:PageRow):StatusPageRecord=>({id:r.id,ownerId:r.owner_id,slug:r.slug,name:r.name,summary:r.summary,published:r.published===1,createdAt:r.created_at,updatedAt:r.updated_at});
const componentRecord=(r:ComponentRow):StatusComponentRecord=>({id:r.id,pageId:r.page_id,name:r.name,description:r.description,state:r.state,position:r.position,createdAt:r.created_at,updatedAt:r.updated_at});
const changeRecord=(r:ChangeRow):StatusComponentChange=>({id:r.id,pageId:r.page_id,componentId:r.component_id,actorId:r.actor_id,previousState:r.previous_state,nextState:r.next_state,reason:r.reason,createdAt:r.created_at});
export class SqliteStatusPageStore implements StatusPageStore {
  constructor(private readonly db:Database) {}
  async createPage(page:StatusPageRecord):Promise<StatusPageRecord>{
    this.db.prepare('INSERT INTO status_pages (id,owner_id,slug,name,summary,published,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(page.id,page.ownerId,page.slug,page.name,page.summary,page.published?1:0,page.createdAt,page.updatedAt); return page;
  }
  async getPage(id:string):Promise<StatusPageRecord|null>{const r=this.db.prepare('SELECT * FROM status_pages WHERE id = ?').get(id) as PageRow|undefined;return r?pageRecord(r):null;}
  async getPageBySlug(slug:string):Promise<StatusPageRecord|null>{const r=this.db.prepare('SELECT * FROM status_pages WHERE slug = ?').get(slug) as PageRow|undefined;return r?pageRecord(r):null;}
  async listPages(ownerId:string):Promise<StatusPageRecord[]>{const r=this.db.prepare('SELECT * FROM status_pages WHERE owner_id = ? ORDER BY created_at DESC, id').all(ownerId) as unknown as PageRow[];return r.map(pageRecord);}
  async setPublished(id:string,ownerId:string,published:boolean,now:number):Promise<StatusPageRecord|null>{
    const r=this.db.prepare('UPDATE status_pages SET published = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(published?1:0,now,id,ownerId);
    return r.changes===0?null:this.getPage(id);
  }
  async createComponent(c:StatusComponentRecord):Promise<StatusComponentRecord>{
    this.db.prepare('INSERT INTO status_page_components (id,page_id,name,description,state,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(c.id,c.pageId,c.name,c.description,c.state,c.position,c.createdAt,c.updatedAt);return c;
  }
  async listComponents(pageId:string):Promise<StatusComponentRecord[]>{const r=this.db.prepare('SELECT * FROM status_page_components WHERE page_id = ? ORDER BY position, created_at, id').all(pageId) as unknown as ComponentRow[];return r.map(componentRecord);}
  async setComponentState(pageId:string,componentId:string,state:StatusComponentState,actorId:string,reason:string,now:number):Promise<StatusComponentRecord|null>{
    return transaction(this.db,()=>{
      const r=this.db.prepare('SELECT * FROM status_page_components WHERE id = ? AND page_id = ?').get(componentId,pageId) as ComponentRow|undefined;
      if(!r)return null;if(r.state===state)return componentRecord(r);
      this.db.prepare('UPDATE status_page_components SET state = ?, updated_at = ? WHERE id = ? AND page_id = ?').run(state,now,componentId,pageId);
      this.db.prepare('INSERT INTO status_component_changes (id,page_id,component_id,actor_id,previous_state,next_state,reason,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(),pageId,componentId,actorId,r.state,state,reason,now);
      return componentRecord({...r,state,updated_at:now});
    });
  }
  async listHistory(pageId:string):Promise<StatusComponentChange[]>{const r=this.db.prepare('SELECT * FROM status_component_changes WHERE page_id = ? ORDER BY created_at, id').all(pageId) as unknown as ChangeRow[];return r.map(changeRecord);}
}
