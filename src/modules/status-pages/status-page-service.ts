import { randomUUID } from 'node:crypto';
import { AppError } from '../../kernel/errors.ts';
import type { Clock } from '../../kernel/clock.ts';
import { errorCode } from '../../kernel/sql.ts';
import type { StatusPageStore } from './store.ts';
import { STATUS_COMPONENT_STATES, type CreateStatusComponentInput, type CreateStatusPageInput, type StatusComponentChange, type StatusComponentRecord, type StatusComponentState, type StatusPageRecord } from './types.ts';
export interface StatusPageView extends StatusPageRecord { readonly components: readonly StatusComponentRecord[]; }
function isConflict(err:unknown):boolean{const code=errorCode(err);const message=err instanceof Error?err.message:String(err);return code==='23505'||code==='SQLITE_CONSTRAINT_UNIQUE'||message.includes('status_page_slug_conflict')||message.includes('status_component_name_conflict')||message.toLowerCase().includes('unique constraint');}
export class StatusPageService {
  constructor(private readonly store:StatusPageStore,private readonly clock:Clock){}
  private async ownedPage(ownerId:string,pageId:string):Promise<StatusPageRecord>{const p=await this.store.getPage(pageId);if(!p||p.ownerId!==ownerId)throw new AppError(404,'status_page_not_found','Status page not found.');return p;}
  async createPage(ownerId:string,input:CreateStatusPageInput):Promise<StatusPageView>{
    const name=input.name.trim(),slug=input.slug.trim().toLowerCase(),summary=(input.summary??'').trim();
    if(name.length<2||name.length>80)throw new AppError(400,'status_page_invalid','Page name must contain 2 to 80 characters.');
    if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)||slug.length>50)throw new AppError(400,'status_page_invalid','Slug must use lowercase letters, numbers and single hyphens.');
    if(summary.length>500)throw new AppError(400,'status_page_invalid','Summary must not exceed 500 characters.');
    const now=this.clock();const page:StatusPageRecord={id:randomUUID(),ownerId,slug,name,summary,published:false,createdAt:now,updatedAt:now};
    try{await this.store.createPage(page);}catch(err){if(isConflict(err))throw new AppError(409,'status_page_conflict','That status page slug is already in use.');throw err;}
    return {...page,components:[]};
  }
  async listPages(ownerId:string):Promise<StatusPageView[]>{const pages=await this.store.listPages(ownerId);return Promise.all(pages.map(async p=>({...p,components:await this.store.listComponents(p.id)})));}
  async addComponent(ownerId:string,input:CreateStatusComponentInput):Promise<StatusComponentRecord>{
    await this.ownedPage(ownerId,input.pageId);const name=input.name.trim(),description=(input.description??'').trim();
    if(name.length<2||name.length>80)throw new AppError(400,'status_component_invalid','Component name must contain 2 to 80 characters.');
    if(description.length>240)throw new AppError(400,'status_component_invalid','Component description must not exceed 240 characters.');
    const state=input.state??'operational';if(!STATUS_COMPONENT_STATES.includes(state))throw new AppError(400,'status_component_state_invalid','Unknown component state.');
    const components=await this.store.listComponents(input.pageId),now=this.clock();
    const c:StatusComponentRecord={id:randomUUID(),pageId:input.pageId,name,description,state,position:components.length,createdAt:now,updatedAt:now};
    try{return await this.store.createComponent(c);}catch(err){if(isConflict(err))throw new AppError(409,'status_component_conflict','A component with that name already exists on this page.');throw err;}
  }
  async setComponentState(ownerId:string,pageId:string,componentId:string,state:string,reason:string):Promise<StatusComponentRecord>{
    await this.ownedPage(ownerId,pageId);if(!STATUS_COMPONENT_STATES.includes(state as StatusComponentState))throw new AppError(400,'status_component_state_invalid','Unknown component state.');
    const why=reason.trim();if(why.length<5||why.length>500)throw new AppError(400,'status_component_reason_required','A change reason of 5 to 500 characters is required.');
    const c=await this.store.setComponentState(pageId,componentId,state as StatusComponentState,ownerId,why,this.clock());if(!c)throw new AppError(404,'status_component_not_found','Status component not found.');return c;
  }
  async publish(ownerId:string,pageId:string,published:boolean):Promise<StatusPageView>{await this.ownedPage(ownerId,pageId);const p=await this.store.setPublished(pageId,ownerId,published,this.clock());if(!p)throw new AppError(404,'status_page_not_found','Status page not found.');return {...p,components:await this.store.listComponents(pageId)};}
  async history(ownerId:string,pageId:string):Promise<StatusComponentChange[]>{await this.ownedPage(ownerId,pageId);return this.store.listHistory(pageId);}
  async publicPage(slug:string):Promise<StatusPageView|null>{const p=await this.store.getPageBySlug(slug);if(!p||!p.published)return null;return {...p,components:await this.store.listComponents(p.id)};}
}
