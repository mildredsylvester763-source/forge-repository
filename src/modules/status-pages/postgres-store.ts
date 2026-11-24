import { randomUUID } from 'node:crypto';
import { withTransaction, type SqlPool } from '../../kernel/sql.ts';
import type { StatusPageStore } from './store.ts';
import type { StatusComponentChange, StatusComponentRecord, StatusComponentState, StatusPageRecord } from './types.ts';
interface PageRow {id:string;owner_id:string;slug:string;name:string;summary:string;published:boolean;created_at:number|string;updated_at:number|string;}
interface ComponentRow {id:string;page_id:string;name:string;description:string;state:StatusComponentState;position:number;created_at:number|string;updated_at:number|string;}
interface ChangeRow {id:string;page_id:string;component_id:string;actor_id:string;previous_state:StatusComponentState;next_state:StatusComponentState;reason:string;created_at:number|string;}
const pageRecord=(r:PageRow):StatusPageRecord=>({id:r.id,ownerId:r.owner_id,slug:r.slug,name:r.name,summary:r.summary,published:r.published,createdAt:Number(r.created_at),updatedAt:Number(r.updated_at)});
const componentRecord=(r:ComponentRow):StatusComponentRecord=>({id:r.id,pageId:r.page_id,name:r.name,description:r.description,state:r.state,position:r.position,createdAt:Number(r.created_at),updatedAt:Number(r.updated_at)});
const changeRecord=(r:ChangeRow):StatusComponentChange=>({id:r.id,pageId:r.page_id,componentId:r.component_id,actorId:r.actor_id,previousState:r.previous_state,nextState:r.next_state,reason:r.reason,createdAt:Number(r.created_at)});
export class PostgresStatusPageStore implements StatusPageStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async createPage(p:StatusPageRecord):Promise<StatusPageRecord>{const r=await this.pool.query<PageRow>('INSERT INTO status_pages (id,owner_id,slug,name,summary,published,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[p.id,p.ownerId,p.slug,p.name,p.summary,p.published,p.createdAt,p.updatedAt]);if(!r.rows[0])throw new Error('status page insert returned no row');return pageRecord(r.rows[0]);}
  async getPage(id:string):Promise<StatusPageRecord|null>{const r=await this.pool.query<PageRow>('SELECT * FROM status_pages WHERE id = $1',[id]);return r.rows[0]?pageRecord(r.rows[0]):null;}
  async getPageBySlug(slug:string):Promise<StatusPageRecord|null>{const r=await this.pool.query<PageRow>('SELECT * FROM status_pages WHERE slug = $1',[slug]);return r.rows[0]?pageRecord(r.rows[0]):null;}
  async listPages(ownerId:string):Promise<StatusPageRecord[]>{const r=await this.pool.query<PageRow>('SELECT * FROM status_pages WHERE owner_id = $1 ORDER BY created_at DESC, id',[ownerId]);return r.rows.map(pageRecord);}
  async setPublished(id:string,ownerId:string,published:boolean,now:number):Promise<StatusPageRecord|null>{const r=await this.pool.query<PageRow>('UPDATE status_pages SET published = $1, updated_at = $2 WHERE id = $3 AND owner_id = $4 RETURNING *',[published,now,id,ownerId]);return r.rows[0]?pageRecord(r.rows[0]):null;}
  async createComponent(c:StatusComponentRecord):Promise<StatusComponentRecord>{const r=await this.pool.query<ComponentRow>('INSERT INTO status_page_components (id,page_id,name,description,state,position,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[c.id,c.pageId,c.name,c.description,c.state,c.position,c.createdAt,c.updatedAt]);if(!r.rows[0])throw new Error('status component insert returned no row');return componentRecord(r.rows[0]);}
  async listComponents(pageId:string):Promise<StatusComponentRecord[]>{const r=await this.pool.query<ComponentRow>('SELECT * FROM status_page_components WHERE page_id = $1 ORDER BY position, created_at, id',[pageId]);return r.rows.map(componentRecord);}
  async setComponentState(pageId:string,componentId:string,state:StatusComponentState,actorId:string,reason:string,now:number):Promise<StatusComponentRecord|null>{
    return withTransaction(this.pool,async conn=>{
      const current=await conn.query<ComponentRow>('SELECT * FROM status_page_components WHERE id = $1 AND page_id = $2 FOR UPDATE',[componentId,pageId]);
      const row=current.rows[0];if(!row)return null;if(row.state===state)return componentRecord(row);
      const updated=await conn.query<ComponentRow>('UPDATE status_page_components SET state = $1, updated_at = $2 WHERE id = $3 AND page_id = $4 RETURNING *',[state,now,componentId,pageId]);
      await conn.query('INSERT INTO status_component_changes (id,page_id,component_id,actor_id,previous_state,next_state,reason,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),pageId,componentId,actorId,row.state,state,reason,now]);
      return updated.rows[0]?componentRecord(updated.rows[0]):null;
    });
  }
  async listHistory(pageId:string):Promise<StatusComponentChange[]>{const r=await this.pool.query<ChangeRow>('SELECT * FROM status_component_changes WHERE page_id = $1 ORDER BY created_at, id',[pageId]);return r.rows.map(changeRecord);}
}
