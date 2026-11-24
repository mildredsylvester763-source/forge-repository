import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { parseFields } from '../../kernel/validate.ts';
import { IdentityService, sessionCredential } from '../identity/index.ts';
import type { StatusPageService } from './status-page-service.ts';
export function statusPageRoutes(service:StatusPageService,identity:IdentityService,cookie:{name:string}):RouteTable{
  const requireUser=async(ctx:RequestContext):Promise<string>=>{const auth=await identity.authenticate(sessionCredential(ctx,cookie.name));if(!auth)throw new AppError(401,'unauthenticated','Sign in required.');return auth.user.id;};
  return {
    '/v1/status-pages':{
      GET:async(ctx):Promise<HttpResult>=>({status:200,body:{pages:await service.listPages(await requireUser(ctx))}}),
      POST:async(ctx):Promise<HttpResult>=>{const owner=await requireUser(ctx);const body=parseFields(await ctx.json(),{name:{max:80},slug:{max:50},summary:{max:500,optional:true}});return {status:201,body:{page:await service.createPage(owner,body)}};}
    },
    '/v1/status-pages/components':{POST:async(ctx):Promise<HttpResult>=>{const owner=await requireUser(ctx);const body=parseFields(await ctx.json(),{pageId:{max:64},name:{max:80},description:{max:240,optional:true}});return {status:201,body:{component:await service.addComponent(owner,body)}};}},
    '/v1/status-pages/components/state':{POST:async(ctx):Promise<HttpResult>=>{const owner=await requireUser(ctx);const body=parseFields(await ctx.json(),{pageId:{max:64},componentId:{max:64},state:{max:32},reason:{max:500}});return {status:200,body:{component:await service.setComponentState(owner,body.pageId,body.componentId,body.state,body.reason)}};}},
    '/v1/status-pages/publish':{POST:async(ctx):Promise<HttpResult>=>{const owner=await requireUser(ctx);const b=await ctx.json();if(typeof b.pageId!=='string'||b.pageId.length===0||b.pageId.length>64||typeof b.published!=='boolean')throw new AppError(400,'invalid_request','pageId and boolean published are required.');return {status:200,body:{page:await service.publish(owner,b.pageId,b.published)}};}},
    '/v1/status-pages/history':{POST:async(ctx):Promise<HttpResult>=>{const owner=await requireUser(ctx);const b=parseFields(await ctx.json(),{pageId:{max:64}});return {status:200,body:{changes:await service.history(owner,b.pageId)}};}},
    '/v1/status-pages/public':{POST:async(ctx):Promise<HttpResult>=>{const b=parseFields(await ctx.json(),{slug:{max:50}});const p=await service.publicPage(b.slug);if(!p)throw new AppError(404,'status_page_not_found','Published status page not found.');return {status:200,body:{page:{slug:p.slug,name:p.name,summary:p.summary,updatedAt:p.updatedAt,components:p.components}}};}}
  };
}
