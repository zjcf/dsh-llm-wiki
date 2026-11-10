import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync } from 'fflate';
import { extract } from '../dist/extract.js';
import { Wiki } from '../dist/wiki.js';
import { readLines } from '../dist/reading.js';
import { imageDocx, imagePdf } from './image-fixtures.mjs';
import { handler, API } from '../dist/api.js';

test('保留 Word 标题、列表、表格行列；PDF 图片按坐标插入对应文字之间', async () => {
  const docx = zipSync({
    'word/document.xml': Buffer.from('<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>操作方法</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>执行步骤</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>参数</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>值</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>端口</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>8080</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'),
  });
  const result = await extract('structure.docx', docx);
  assert.match(result.text, /## 操作方法/);
  assert.match(result.text, /1\. 执行步骤/);
  assert.match(result.text, /\| 参数 \| 值 \|\n\| --- \| --- \|\n\| 端口 \| 8080 \|/);
  const pdf = await extract('structure.pdf', imagePdf());
  assert.match(pdf.text, /image-proof-pdf[\s\S]*!\[[\s\S]*image-proof-tail/);
});

test('简短来源不能膨胀成报告；分段读取不漏长行；检索按来源去重', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-reading-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = new Wiki(root); await wiki.initialize();
  const input = '# 小流程\n\n1. 打开页面\n2. 复制下载链接\n3. 保存文件\n';
  const { record } = await wiki.import('小流程.md', Buffer.from(input));
  const info = await wiki.sourceInfo(record.id);
  assert.equal(info.reviewGuide.mode, 'compact'); assert.equal(info.more, false);
  await assert.rejects(wiki.review({id:record.id,title:'小流程',body:'无关审计报告。'.repeat(100),status:'processed'}), /整理正文过长/);
  assert.equal((await wiki.source(record.id)).status, 'pending');
  const { pageId } = await wiki.review({id:record.id,title:'小流程',body:input.replace('# 小流程\n',''),status:'processed'});
  const hit = (await wiki.search('小流程'))[0];
  assert.deepEqual(hit.readArgs, { id: pageId });
  assert.equal((await wiki.readPage(record.text)).kind, 'source');
  assert.match((await wiki.readPage(record.text)).text, /复制下载链接/);
  await writeFile(join(root, 'extracted/' + record.id + '-reader.md'), input);
  assert.equal((await wiki.search('下载', 'all')).length, 1);
  assert.equal((await wiki.search('下载', 'all'))[0].id, pageId);
  const previous = await readFile(join(root, pageId), 'utf8');
  await wiki.historyRecordExternal((await wiki.historyExternalPreview()).token);
  await wiki.retryReview(record.id); const claimed = await wiki.claimReview(); assert.equal(claimed.id, record.id);
  assert.equal(await readFile(join(root, pageId), 'utf8'), previous);
  await wiki.review({id:record.id,title:'小流程',body:'1. 打开页面\n2. 复制下载链接\n3. 保存文件',status:'processed'},true);
  const text = '前言\n' + 'A'.repeat(18000) + '\n结束';
  let line = 1, column = 0, output = [];
  for(let i=0;i<10;i++) {
    const chunk = readLines(text,line,80,undefined,column); output.push(chunk.text);
    if(!chunk.more)break;
    const sameLine = chunk.nextColumn !== undefined;
    output.push(sameLine ? '' : '\n'); line=chunk.nextLine;column=chunk.nextColumn ?? 0;
  }
  assert.equal(output.join(''),text);
  for(let i=0;i<7;i++) {
    const {record:s} = await wiki.import('检索'+i+'.md',Buffer.from('下载 专有标记 '+i));
    await wiki.review({id:s.id,title:'下载'+i,body:'下载 专有标记 '+i,status:'processed'});
  }
  assert.equal((await wiki.search('下载')).length,5);
});

test('AI 改写标题后，仍可按原文标题命中知识页；抽取命中项可直接读取', async t => {
  const root=await mkdtemp(join(tmpdir(),'wiki-alias-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const wiki=new Wiki(root);await wiki.initialize();
  const {record}=await wiki.import('FAQ.md',Buffer.from('# curl 下载群晖分享\n\n1. 打开分享页面。\n2. 复制下载链接。'));
  const {pageId}=await wiki.review({id:record.id,title:'FAQ 操作',body:'1. 打开分享页面。\n2. 复制下载链接。',status:'processed'});
  const hit=(await wiki.search('curl 群晖'))[0];assert.equal(hit.id,pageId);assert.equal(hit.sourceHeading,'curl 下载群晖分享');
  const source=(await wiki.search('curl 群晖','sources'))[0];
  assert.match((await wiki.readPage(source.readArgs.id)).text,/curl 下载群晖分享/);
});

test('知识读取只返回相关章节；旧版自动图库不参与展示和搜索；Word 预览受沙箱约束', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-preview-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = new Wiki(root); await wiki.initialize();
  const { record } = await wiki.import('预览.docx', imageDocx());
  const {pageId} = await wiki.review({id:record.id,title:'操作',body:'## 下载\n\n复制下载链接。\n\n## 其他\n\n无关设置。',status:'partial'});
  const page=await wiki.readPage(pageId,1,60,'下载');
  assert.match(page.text,/复制下载链接/);assert.doesNotMatch(page.text,/无关设置/);
  await writeFile(join(root,pageId),(await readFile(join(root,pageId),'utf8'))+'\n<!-- wiki-source-images -->\n## 来源图片\n图库独有标记\n<!-- /wiki-source-images -->\n');
  assert.doesNotMatch((await wiki.page(pageId)).body,/图库独有标记/);
  assert.equal((await wiki.search('图库独有标记')).length,0);
  const request=handler(wiki);
  const response=await request(new Request('http://localhost'+API+'?op=preview&id='+record.id));
  assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/sandbox allow-scripts/);
  assert.doesNotMatch(response.headers.get('content-security-policy'),/allow-same-origin/);
  assert.match(response.headers.get('content-security-policy'),/default-src 'none'/);
  assert.match(await response.text(),/word|docx/i);
});
