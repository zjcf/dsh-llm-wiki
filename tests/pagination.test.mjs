import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as git from 'isomorphic-git';
import { Wiki } from '../dist/wiki.js';
import { Catalog } from '../dist/catalog.js';
import { History } from '../dist/history.js';
import { API, handler } from '../dist/api.js';

async function fixture(t, count = 230) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-paging-')), catalog = new Catalog(root);
  const wiki = new Wiki(root);
  t.after(async () => { await catalog.dispose(); await wiki.disposeCatalog(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, 'wiki/topics'), { recursive: true });
  const entries = [];
  for (let start = 0; start < count; start += 20) {
    await Promise.all(Array.from({ length: Math.min(20, count-start) }, async (_, n) => {
      const id = 'wiki/topics/P' + String(start+n).padStart(5,'0') + '.md'; entries.push('- [知识](' + id + ')');
      await writeFile(join(root,id), '---\ntype: topic\ntitle: "分页样例 '+String(start+n).padStart(5,'0')+'"\ncreated: "2026-11-06"\nupdated: "2026-11-06"\ntags: []\nsource_ids: []\n---\n\n'+(start+n===173?'唯一匹配标记 needle-proof\n':'')+'用于分页测试的正文。'.repeat(600));
    }));
  }
  await writeFile(join(root,'index.md'), '# 索引\n\n' + entries.sort().join('\n') + '\n');
  await wiki.initialize();
  return { root, wiki, catalog, request: handler(wiki) };
}

test('知识列表服务端分页、筛选和全文查询；正文不随列表返回，热查询不重复扫描正文', async t => {
  const { wiki, catalog, request } = await fixture(t);
  const get = params => request(new Request('http://localhost'+API+'?'+new URLSearchParams({op:'list',view:'pages',...params})));
  const response = await get({}); const first = await response.json();
  assert.equal(first.total,230); assert.equal(first.pages.length,50); assert.equal(first.offset,0);
  assert.ok(first.pages.every(page=>!('body' in page)));
  assert.ok(JSON.stringify(first).length<35000,'响应只包含一页元数据');
  const second = await(await get({offset:'50'})).json();
  assert.equal(second.pages.length,50); assert.equal(second.offset,50);
  assert.equal(new Set([...first.pages,...second.pages].map(page=>page.id)).size,100);
  assert.equal((await(await get({offset:'200'})).json()).pages.length,30);
  assert.equal((await(await get({limit:'100000',offset:'-1'})).json()).pages.length,100);
  const match = await(await get({q:'唯一匹配标记'})).json(); assert.equal(match.total,1); assert.match(match.pages[0].id,/00173/);
  assert.equal((await(await get({filter:'answer'})).json()).total,0);
  await catalog.list({view:'pages'}); const before=await catalog.metrics();
  await catalog.list({view:'pages',offset:100}); await catalog.search('分页样例','wiki',5);
  assert.deepEqual(await catalog.metrics(),before,'热列表/搜索无需重新遍历或读取正文');
  await wiki.writePage({type:'answer',title:'新增归档问答',body:'增量索引验证。'});
  assert.equal((await catalog.list({view:'pages'})).total,231);
  assert.ok((await catalog.metrics()).reads-before.reads<=3,'新提交只重读变化文件');
});

test('超过1000文件的版本也只加载一页文件名，展开后才读该文件；原件不读入差异正文', async t => {
  const { root, wiki } = await fixture(t, 1100);
  const history = new History(root); await history.initialize();
  const oid=(await wiki.historyList())[0].oid;
  const original=history.blob; let reads=0;
  history.blob=async(...args)=>{reads++;return original.apply(history,args)};
  const page=await history.diff(oid,{offset:0,limit:50});
  assert.ok(page.total>1000); assert.equal(page.files.length,50); assert.equal(reads,0);
  assert.ok(page.files.every(file=>file.loaded===false&&file.before===null&&file.after===null));
  const selected=page.files.find(file=>file.path.startsWith('wiki/')) ?? (await history.diff(oid,{offset:50,limit:50})).files[0];
  const file=await history.diff(oid,{path:selected.path}); assert.equal(file.files.length,1); assert.equal(file.files[0].loaded,true); assert.ok(reads<=2);
  await assert.rejects(history.diff(oid,{path:'../secret'}),/不属于/);
});

test('历史按游标每页50条，无重复无遗漏；状态轮询不扫描全库，显式巡检仍可发现外部修改', async t => {
  const { root, wiki, request } = await fixture(t,2);
  const gitdir=join(root,'.wiki/history.git'), args={fs,gitdir};
  let head=(await wiki.historyList())[0].oid; const tree=(await git.readCommit({...args,oid:head})).commit.tree;
  for(let i=0;i<125;i++)head=await git.commit({...args,ref:'refs/heads/main',parent:[head],tree,message:'测试版本 '+i+'\n\nWiki-Meta: {"kind":"maintenance"}\n',author:{name:'Fixture',email:'fixture@example.invalid'}});
  await writeFile(join(root,'.wiki/history-state.json'),JSON.stringify({head}));
  const get=before=>request(new Request('http://localhost'+API+'?'+new URLSearchParams({op:'history-list',...(before?{before}:{})})));
  const all=[];let cursor;
  do {const page=await(await get(cursor)).json();assert.ok(page.items.length<=50);all.push(...page.items.map(v=>v.oid));if(!page.more)break;cursor=page.items.at(-1).oid;}while(true);
  assert.equal(all.length,126);assert.equal(new Set(all).size,126);
  const dirty=wiki.history.dirty.bind(wiki.history);let scans=0;wiki.history.dirty=async()=>{scans++;return dirty()};
  await request(new Request('http://localhost'+API+'?op=history-status'));await request(new Request('http://localhost'+API+'?op=history-status'));assert.equal(scans,0);
  const path=join(root,'wiki/topics/P00000.md');await writeFile(path,(await readFile(path,'utf8'))+'\n外部更改。');
  const inspected=await(await request(new Request('http://localhost'+API+'?op=history-status&inspect=1'))).json();
  assert.equal(scans,1);assert.ok(inspected.dirty.includes('wiki/topics/P00000.md'));
});

test('首次来源列表不等待正文索引；重整任务也分页，损坏的派生索引可重建', async t => {
  const { root, wiki, catalog } = await fixture(t,80);
  await writeFile(join(root,'.wiki/catalog.sqlite'),'not a database');
  const manifest=JSON.parse(await readFile(join(root,'.wiki/manifest.json'),'utf8'));manifest.rebuilds={};
  for(let i=0;i<75;i++){const id='wiki/topics/task-'+String(i).padStart(3,'0')+'.md';manifest.rebuilds[id]={id,title:'任务'+i,type:'topic',state:'failed',sourceIds:[]};}
  await writeFile(join(root,'.wiki/manifest.json'),JSON.stringify(manifest));
  const first=await catalog.list({view:'sources'});assert.equal(first.counts.pages,80);assert.equal(first.counts.rebuilds,75);assert.equal(first.rebuilds.length,20);
  assert.equal((await catalog.metrics()).reads,0,'来源列表不读任何正文');
  const next=await catalog.list({view:'sources',jobOffset:20});assert.equal(next.rebuildOffset,20);assert.equal(new Set([...first.rebuilds,...next.rebuilds].map(job=>job.id)).size,40);
  assert.equal((await catalog.list({view:'sources',jobOffset:10000})).rebuilds.length,15);
  const page=await catalog.list({view:'pages'});assert.equal(page.pages.length,50);assert.equal(page.total,80);assert.equal(catalog.progress.indexing,false);
  assert.ok(fs.readdirSync(join(root,'.wiki')).some(name=>name.startsWith('catalog.sqlite.corrupt-')));
  await wiki.disposeCatalog();
});
