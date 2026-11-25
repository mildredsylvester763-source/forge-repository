import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';
async function signedIn(h:Harness,email:string):Promise<{cookie:string;userId:string}>{
  const reg=await h.post('/v1/auth/register',{email,password:GOOD_PASSWORD,displayName:'Status Page Tester'});assert.equal(reg.status,201);
  const sign=await h.post('/v1/auth/sign-in',{email,password:GOOD_PASSWORD});assert.equal(sign.status,200);
  const cookie=sessionCookie(sign),me=await h.get('/v1/auth/me',{cookie});assert.equal(me.status,200);
  const body=await me.json() as {user:{id:string}};return {cookie,userId:body.user.id};
}
async function errorCode(r:Response):Promise<string>{const b=await r.json() as {error:{code:string}};return b.error.code;}
describe('status page management (OB-052)',()=>{
  it('creates, publishes and updates a public page with append-only component history',async()=>{
    const h:Harness=await startHarness();
    try{
      const owner=await signedIn(h,'status-owner@forge.test');await h.app.plans.setPlan(owner.userId,'plus');
      const created=await h.post('/v1/status-pages',{name:'Forge Service Status',slug:'forge-service',summary:'Live service health.'},{cookie:owner.cookie});assert.equal(created.status,201);
      const page=(await created.json() as {page:{id:string;published:boolean}}).page;assert.equal(page.published,false);
      const compRes=await h.post('/v1/status-pages/components',{pageId:page.id,name:'API',description:'Public API'},{cookie:owner.cookie});assert.equal(compRes.status,201);
      const comp=(await compRes.json() as {component:{id:string;state:string}}).component;assert.equal(comp.state,'operational');
      assert.equal((await h.post('/v1/status-pages/public',{slug:'forge-service'})).status,404);
      assert.equal((await h.post('/v1/status-pages/publish',{pageId:page.id,published:true},{cookie:owner.cookie})).status,200);
      const publicPage=await h.post('/v1/status-pages/public',{slug:'forge-service'});assert.equal(publicPage.status,200);
      const before=await publicPage.json() as {page:{components:Array<{state:string}>}};assert.equal(before.page.components[0]?.state,'operational');
      const changed=await h.post('/v1/status-pages/components/state',{pageId:page.id,componentId:comp.id,state:'degraded',reason:'Elevated API error rate.'},{cookie:owner.cookie});assert.equal(changed.status,200);
      const after=await h.post('/v1/status-pages/public',{slug:'forge-service'});
      const afterBody=await after.json() as {page:{components:Array<{state:string}>}};assert.equal(afterBody.page.components[0]?.state,'degraded');
      const history=await h.post('/v1/status-pages/history',{pageId:page.id},{cookie:owner.cookie});assert.equal(history.status,200);
      const historyBody=await history.json() as {changes:Array<{previousState:string;nextState:string;reason:string;actorId:string}>};
      assert.equal(historyBody.changes.length,1);assert.equal(historyBody.changes[0]?.previousState,'operational');assert.equal(historyBody.changes[0]?.nextState,'degraded');
      assert.equal(historyBody.changes[0]?.reason,'Elevated API error rate.');assert.equal(historyBody.changes[0]?.actorId,owner.userId);
    }finally{await h.close();}
  });
  it('enforces the Plus gate, page ownership, valid states and unique slugs',async()=>{
    const h:Harness=await startHarness();
    try{
      const owner=await signedIn(h,'status-owner-2@forge.test'),other=await signedIn(h,'status-other@forge.test'),free=await signedIn(h,'status-free@forge.test');
      await h.app.plans.setPlan(owner.userId,'plus');await h.app.plans.setPlan(other.userId,'plus');
      const denied=await h.get('/v1/status-pages',{cookie:free.cookie});assert.equal(denied.status,402);assert.equal(await errorCode(denied),'plan_required');
      const created=await h.post('/v1/status-pages',{name:'Platform',slug:'platform'},{cookie:owner.cookie});assert.equal(created.status,201);
      const page=(await created.json() as {page:{id:string}}).page;
      const duplicate=await h.post('/v1/status-pages',{name:'Another',slug:'platform'},{cookie:owner.cookie});assert.equal(duplicate.status,409);
      const comp=await h.post('/v1/status-pages/components',{pageId:page.id,name:'Database'},{cookie:owner.cookie});assert.equal(comp.status,201);
      const componentId=(await comp.json() as {component:{id:string}}).component.id;
      const foreign=await h.post('/v1/status-pages/components/state',{pageId:page.id,componentId,state:'major_outage',reason:'Unrelated account.'},{cookie:other.cookie});assert.equal(foreign.status,404);
      const invalid=await h.post('/v1/status-pages/components/state',{pageId:page.id,componentId,state:'unknown',reason:'Invalid state test.'},{cookie:owner.cookie});assert.equal(invalid.status,400);
      const noReason=await h.post('/v1/status-pages/components/state',{pageId:page.id,componentId,state:'degraded',reason:'no'},{cookie:owner.cookie});assert.equal(noReason.status,400);
    }finally{await h.close();}
  });
});


it('uses the SQLite store with transactional, immutable component history', async () => {
  const h: Harness = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
  try {
    const owner = await signedIn(h, 'status-sqlite@forge.test');
    await h.app.plans.setPlan(owner.userId, 'plus');
    const created = await h.post('/v1/status-pages', { name: 'SQLite Status', slug: 'sqlite-status' }, { cookie: owner.cookie });
    assert.equal(created.status, 201);
    const page = (await created.json() as { page: { id: string } }).page;
    const componentResponse = await h.post('/v1/status-pages/components', { pageId: page.id, name: 'Worker' }, { cookie: owner.cookie });
    assert.equal(componentResponse.status, 201);
    const component = (await componentResponse.json() as { component: { id: string } }).component;
    h.clock.now += 1000;
    const changed = await h.post('/v1/status-pages/components/state', {
      pageId: page.id, componentId: component.id, state: 'partial_outage', reason: 'Worker queue delay.',
    }, { cookie: owner.cookie });
    assert.equal(changed.status, 200);
    const db = h.app.db;
    assert.ok(db);
    const pageRow = db.prepare('SELECT updated_at FROM status_pages WHERE id = ?').get(page.id) as { updated_at: number };
    assert.equal(pageRow.updated_at, h.clock.now);
    const historyRow = db.prepare('SELECT id FROM status_component_changes WHERE page_id = ?').get(page.id) as { id: string };
    assert.throws(() => db.prepare('UPDATE status_component_changes SET reason = ? WHERE id = ?').run('tampered', historyRow.id), /append-only/);
  } finally {
    await h.close();
  }
});
