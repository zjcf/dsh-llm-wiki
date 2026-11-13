import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Wiki} from '../dist/wiki.js';
import {apply} from '../dist/dsh.js';
import {API, handler} from '../dist/api.js';

async function snapshot(root) {
  const result={};
  async function walk(path) { for(const f of await readdir(join(root,path),{withFileTypes:true})) {
    const p=path?path+'/'+f.name:f.name;
    if(f.isDirectory())await walk(p);else result[p]=createHash('sha256').update(await readFile(join(root,p))).digest('hex');
  }}
  await walk('');return result;
}

test('只读实例不写共享库、不取凭据、不启动 Agent；缓存独立且能读取管理实例的新提交',async t=>{
  const base=await mkdtemp(join(tmpdir(),'wiki-readonly-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const root=join(base,'data'),cacheDir=join(base,'reader-cache');
  const writer=new Wiki(root);await writer.initialize();t.after(()=>writer.disposeCatalog());
  const {record}=await writer.import('只读材料.md',Buffer.from('蓝鲸归档规定：保存原件。'));
  await writer.review({id:record.id,title:'只读材料',body:'保存原件。',status:'processed'});
  const page=await writer.writePage({type:'answer',title:'蓝鲸归档问答',body:'保存原件。',source_ids:[record.id]});
  const before=await snapshot(root),tools=new Map(),routes=new Map(),effects=[];
  const unavailable=()=>{throw Error('只读模式不能访问写入依赖')};
  const host={credentials:{resolve:unavailable},agentPresets:{register:unavailable},sessionController:{create:unavailable},
    skills:{register:()=>()=>{}},workspaceRegistry:{create:async path=>({id:'reader-ws',path})},effect:f=>effects.push(f()),
    tools:{register:tool=>{tools.set(tool.name,tool);return()=>tools.delete(tool.name)}},
    connection:{fetch:{register:route=>{routes.set(route.path,route.fetch);return()=>{}}}}};
  await apply(host,{root,readOnly:true,autoReview:true,cacheDir});t.after(async()=>{for(const f of effects.reverse())await f()});
  assert.deepEqual([...tools.keys()].sort(),['wiki_list','wiki_search','wiki_read_page','wiki_get_source','wiki_read_source','wiki_read_image','wiki_lint'].sort());
  const call=(name,args)=>tools.get(name).execute(args);
  assert.equal((await call('wiki_list',{})).totalPages,2);
  assert.match((await call('wiki_read_page',{id:page.id})).text,/保存原件/);
  assert.ok((await call('wiki_search',{query:'蓝鲸'})).hits.length);
  const request=routes.get(API);
  for(const op of ['import','retry-review','retry-rebuild','delete-source','delete-page','extract-source','history-settings','history-sync','history-revert','history-external']) {
    const response=await request(new Request('http://localhost'+API+'?op='+op,{method:'POST',body:'invalid body, must reject before parsing'}));
    assert.equal(response.status,403,op);assert.match((await response.json()).error,/只读/);
  }
  for(const op of ['delete-preview','delete-page-preview','history-revert-preview','history-external-preview'])assert.equal((await request(new Request('http://localhost'+API+'?op='+op))).status,403);
  const status=await(await request(new Request('http://localhost'+API+'?op=history-status&inspect=1'))).json();assert.equal(status.readOnly,true);
  assert.equal((await(await request(new Request('http://localhost'+API+'?op=list'))).json()).readOnly,true);
  assert.deepEqual(await snapshot(root),before,'启动、查询、历史及被拒绝的写请求都不能修改共享库');
  assert.ok((await readdir(cacheDir)).includes('catalog.sqlite'));
  const updated=await writer.updatePage({id:page.id,expected_revision:page.revision,old_text:'保存原件',new_text:'保存蓝鲸原件并核对哈希'});
  assert.equal((await call('wiki_read_page',{id:page.id})).revision,updated.revision);
  assert.ok((await call('wiki_search',{query:'核对哈希'})).hits.some(h=>h.id===page.id));
  const reader=new Wiki(root,undefined,{readOnly:true,cacheDir:join(base,'second-cache')});await reader.initialize();
  await assert.rejects(reader.writePage({type:'topic',title:'拒绝',body:'拒绝'}),/只读/);
  assert.throws(()=>reader.historySync(),/只读/);
  assert.deepEqual((await reader.check()).errors,[]);await reader.disposeCatalog();
});

test('只读模式拒绝在共享知识库内放置可写缓存',()=>{
  for(const cacheDir of ['/tmp/wiki','.wiki/cache','/tmp/wiki/cache'])assert.throws(()=>new Wiki('/tmp/wiki',undefined,{readOnly:true,cacheDir}),/缓存目录/);
});
