import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { Wiki } from '../dist/wiki.js';

test('目录按类别分节并带一句话摘要，日志使用统一前缀', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-structure-')); t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = new Wiki(root); await wiki.initialize(); t.after(() => wiki.disposeCatalog());
  const { record } = await wiki.import('归档.md', Buffer.from('归档后核对大小。'));
  await wiki.review({ id: record.id, title: '归档说明', body: '归档后核对大小。', status: 'processed', summary: '归档\n校验要点' });
  const topic = await wiki.writePage({ type: 'topic', title: '归档校验', body: '核对大小。', source_ids: [record.id], summary: '归档后如何校验' });
  const answer = await wiki.writePage({ type: 'answer', title: '如何归档？', body: '复制后核对大小。' });
  const index = await readFile(join(root, 'index.md'), 'utf8');
  assert.match(index, /## 来源与原文\n\n- \[归档说明\]\(wiki\/sources\/s-[0-9a-f]+\.md\) — 归档 校验要点\n/);
  assert.match(index, /## 主题知识\n\n- \[归档校验\]\([^)]+\) — 归档后如何校验\n/);
  assert.match(index, /## QA 问答\n\n- \[如何归档？\]\([^)]+\)\n/);
  assert.doesNotMatch(index, / · /);
  // 局部修改保留原摘要，条目不重复。
  const page = await wiki.page(topic.id);
  await wiki.updatePage({ id: topic.id, expected_revision: page.revision, old_text: '核对大小', new_text: '核对大小和名称' });
  const updated = await readFile(join(root, 'index.md'), 'utf8');
  assert.equal(updated.match(/\[归档校验\]/g).length, 1);
  assert.match(updated, /— 归档后如何校验/);
  assert.match(await readFile(join(root, topic.id), 'utf8'), /summary: "归档后如何校验"/);
  const log = await readFile(join(root, 'log.md'), 'utf8');
  assert.match(log, /^## \[\d{4}-\d\d-\d\dT[^\]]+\] ingest \| 归档说明$/m);
  assert.match(log, new RegExp('^## \\[[^\\]]+\\] page \\| ' + answer.id.replace(/[?]/g, '\\?') + '$', 'm'));
  assert.deepEqual((await wiki.check()).errors, []);
});

test('按知识页 ID 写的链接转为相对路径；不存在的页面拒绝写入；孤立页列入检查警告', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-links-')); t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = new Wiki(root); await wiki.initialize(); t.after(() => wiki.disposeCatalog());
  const entity = await wiki.writePage({ type: 'entity', title: '归档 服务', body: '负责归档。' });
  await assert.rejects(wiki.writePage({ type: 'topic', title: '坏链接', body: '见 [不存在](wiki/topics/没有.md)。' }), /链接的知识页不存在/);
  const topic = await wiki.writePage({ type: 'topic', title: '归档流程', body: '由 [归档服务](' + entity.id + '#职责) 执行。' });
  assert.match((await wiki.page(topic.id)).body, /\]\(\.\.\/entities\/%E5%BD%92%E6%A1%A3%20%E6%9C%8D%E5%8A%A1\.md#职责\)/);
  const checked = await wiki.check();
  assert.deepEqual(checked.errors, []);
  const orphans = checked.warnings.find(line => line.startsWith('孤立知识页'));
  assert.match(orphans, /孤立知识页 1 个/); assert.match(orphans, /归档流程/); assert.doesNotMatch(orphans, /归档 服务/);
});

test('旧版平铺目录迁移到对应分节，保留手写内容', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-legacy-index-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'index.md'), '# 知识库首页\n\n手写说明。\n\n## 来源与原文\n\n- [新材料](wiki/sources/s-2.md) · 来源摘要\n- [旧材料](wiki/sources/s-1.md) · 来源摘要\n\n- [归档](wiki/topics/%E5%BD%92%E6%A1%A3.md) · 主题知识\n\n- [问答](wiki/answers/a.md) · QA 问答\n');
  const wiki = new Wiki(root); await wiki.initialize(); t.after(() => wiki.disposeCatalog());
  assert.equal(await readFile(join(root, 'index.md'), 'utf8'),
    '# 知识库首页\n\n手写说明。\n\n## 来源与原文\n\n- [新材料](wiki/sources/s-2.md)\n- [旧材料](wiki/sources/s-1.md)\n\n## 主题知识\n\n- [归档](wiki/topics/%E5%BD%92%E6%A1%A3.md)\n\n## QA 问答\n\n- [问答](wiki/answers/a.md)\n');
  assert.equal((await wiki.historyList())[0].meta.title, '按类别整理知识目录');
});
