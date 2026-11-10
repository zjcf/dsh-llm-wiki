import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import * as git from 'isomorphic-git';
import { Catalog } from '../dist/catalog.js';
import { Wiki } from '../dist/wiki.js';

const count = Number(process.argv[2] ?? 10000), output = process.argv[3];
if (!Number.isInteger(count) || count < 100 || count > 30000) throw new Error('压测数量范围为100至30000');
const root = await mkdtemp(join(tmpdir(), 'wiki-scale-')), historyRoot = await mkdtemp(join(tmpdir(), 'wiki-history-scale-'));
const catalog = new Catalog(root), historyWiki = new Wiki(historyRoot);
const ms = value => Math.round(value * 100) / 100;
const timed = async fn => { const start = performance.now(), value = await fn(); return { value, ms: ms(performance.now()-start) }; };
const report = { node: process.version, sources: count, pages: count };
try {
  console.log('准备隔离压测数据：'+count+'份来源、'+count+'个知识页');
  for(const folder of ['.wiki','wiki/topics','extracted'])await mkdir(join(root,folder),{recursive:true});
  const sources={}, index=[];
  for(let start=0;start<count;start+=32)await Promise.all(Array.from({length:Math.min(32,count-start)},async(_,n)=>{
    const ordinal=start+n, name='Fixture-'+String(ordinal).padStart(5,'0'), bytes=Buffer.from('压力验收原件 '+ordinal);
    const hash=createHash('sha256').update(bytes).digest('hex'), id='s-'+hash.slice(0,16), original='raw/'+id+'/'+name+'.bin';
    await mkdir(join(root,'raw',id),{recursive:true});await writeFile(join(root,original),bytes);
    sources[id]={id,name:name+'.bin',sha256:hash,original,imported_at:'2026-11-06T00:00:00.000Z',status:'pending',extraction:'unavailable',size:bytes.length};
    const page='wiki/topics/'+name+'.md';index.push('- ['+name+']('+page+')');
    await writeFile(join(root,page),'---\ntype: topic\ntitle: "'+name+'"\ncreated: "2026-11-06"\nupdated: "2026-11-06"\ntags: []\nsource_ids: ["'+id+'"]\nbasis: sources\n---\n\n'+(ordinal===count-1?'唯一命中规模验收 scale-needle\n':'')+'隔离数据集，仅用于分页和全文索引性能验证。'.repeat(30)+'\n\n[原件](../../'+original+')\n');
  }));
  await writeFile(join(root,'.wiki/manifest.json'),JSON.stringify({version:1,sources}));
  await writeFile(join(root,'index.md'),'# 压测索引\n\n'+index.sort().join('\n'));
  let maxLag=0,last=performance.now();const timer=setInterval(()=>{const now=performance.now();maxLag=Math.max(maxLag,now-last-10);last=now;},10);
  console.log('构建索引并测量主线程响应');
  const cold=await timed(()=>catalog.list({view:'sources'}));report.coldSourceListMs=cold.ms;
  report.coldKnowledgeIndexMs=(await timed(()=>catalog.list({view:'pages'}))).ms;
  const before=await catalog.metrics(), lists=[],queries=[];
  for(let i=0;i<20;i++){
    const result=await timed(()=>catalog.list({view:i%2?'pages':'sources',offset:(i*431)%(count-50)}));lists.push(result.ms);
    if(result.value.sources.length+result.value.pages.length!==50)throw new Error('分页边界异常');
    if(JSON.stringify(result.value).length>100000)throw new Error('列表响应超过100KB');
    queries.push((await timed(()=>catalog.search('唯一命中规模验收','wiki',5))).ms);
  }
  clearInterval(timer);
  report.listP95Ms=[...lists].sort((a,b)=>a-b)[18];report.searchP95Ms=[...queries].sort((a,b)=>a-b)[18];report.mainThreadMaxLagMs=ms(maxLag);
  report.firstPageBytes=Buffer.byteLength(JSON.stringify(cold.value));report.warmMetricsBefore=before;report.warmMetricsAfter=await catalog.metrics();
  console.log('测量5000个版本的分页与状态轮询');
  await historyWiki.initialize();const gitdir=join(historyRoot,'.wiki/history.git'),args={fs,gitdir};let head=(await historyWiki.historyList())[0].oid;
  const tree=(await git.readCommit({...args,oid:head})).commit.tree;
  for(let i=0;i<5000;i++)head=await git.commit({...args,ref:'refs/heads/main',parent:[head],tree,message:'压测版本 '+i+'\n\nWiki-Meta: {"kind":"maintenance"}\n',author:{name:'Fixture',email:'fixture@example.invalid'}});
  await writeFile(join(historyRoot,'.wiki/history-state.json'),JSON.stringify({head}));
  const historyPage=await timed(()=>historyWiki.historyList());report.historyVersions=5001;report.historyFirstPageMs=historyPage.ms;report.historyPageRows=historyPage.value.length;
  report.historyStatusMs=(await timed(()=>historyWiki.historyStatus(false))).ms;
  report.passed=report.warmMetricsBefore.reads===report.warmMetricsAfter.reads&&report.mainThreadMaxLagMs<150&&report.historyPageRows===50;
  if(output)await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  if(!report.passed)process.exitCode=1;
} finally { await catalog.dispose();await historyWiki.disposeCatalog();await rm(root,{recursive:true,force:true});await rm(historyRoot,{recursive:true,force:true}); }
