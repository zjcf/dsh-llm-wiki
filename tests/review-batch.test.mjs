import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Wiki } from '../dist/wiki.js';
import { ReviewDraft } from '../dist/review-draft.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = new Wiki(root); await wiki.initialize();
  const { record } = await wiki.import('归档流程.md', Buffer.from('归档后核对文件名称和大小。'), true);
  await wiki.claimReview(); await wiki.setReviewSession(record.id, 'single-review', true);
  return { wiki, record, draft: new ReviewDraft(wiki, 'single-review') };
}

test('一次整理的来源摘要、多次知识写入和更新只发布一个提交，revert 只撤销该提交', async t => {
  const { wiki, record, draft } = await fixture(t);
  const before = await wiki.historyList();
  await draft.record({ id: record.id, title: '归档流程', body: '归档后核对名称和大小。', status: 'processed' });
  const saved = await draft.writePage({ type: 'answer', title: '如何归档', body: '归档后核对名称。', source_ids: [record.id] });
  await draft.updatePage({ id: saved.id, expected_revision: saved.revision, old_text: '核对名称', new_text: '核对名称和大小', source_ids: [record.id] });
  assert.match((await draft.readPage(saved.id)).text, /名称和大小/);
  assert.ok((await wiki.search('归档', 'wiki', 10, draft.overlay)).some(hit => hit.id === saved.id));
  await assert.rejects(wiki.page(saved.id), /不存在/);
  assert.equal((await wiki.source(record.id)).status, 'pending');
  assert.deepEqual((await wiki.historyStatus()).dirty, []);
  assert.equal((await wiki.historyList()).length, before.length);
  await wiki.finishReview(record.id, draft.batch(), 'single-review');
  const after = await wiki.historyList(); assert.equal(after.length, before.length + 1);
  assert.equal(after[0].meta.single, true); assert.equal(after[0].meta.kind, 'review-complete');
  assert.match((await wiki.page(saved.id)).body, /名称和大小/);
  assert.equal((await wiki.source(record.id)).status, 'processed');
  const preview = await wiki.historyRevertPreview(after[0].oid); await wiki.historyRevert(after[0].oid, preview.token);
  assert.equal((await wiki.source(record.id)).status, 'pending');
  await assert.rejects(wiki.page(saved.id), /不存在/);
  assert.deepEqual((await wiki.historyList())[0].meta.revertedCommits, [after[0].oid]);
  assert.ok((await wiki.historyList()).some(version => version.oid === after[0].oid));
});

test('任务失败不发布草稿；并发知识更新会阻止整批覆盖，来源页也保持原状', async t => {
  const { wiki, record, draft } = await fixture(t);
  await draft.record({ id: record.id, title: '归档流程', body: '归档核对名称。', status: 'processed' });
  const saved = await draft.writePage({ type: 'topic', title: '归档校验', body: '草稿结论。', source_ids: [record.id] });
  await wiki.writePage({ type: 'topic', title: '归档校验', body: '另一个任务已保存的内容。', source_ids: [record.id] });
  const count = (await wiki.historyList()).length;
  await assert.rejects(wiki.finishReview(record.id, draft.batch(), 'single-review'), /revision/);
  assert.equal((await wiki.historyList()).length, count);
  assert.match((await wiki.page(saved.id)).body, /另一个任务/);
  assert.equal((await wiki.source(record.id)).status, 'pending');
  await assert.rejects(wiki.page('wiki/sources/' + record.id + '.md'), /不存在/);
  await wiki.failReview(record.id, '测试：任务失败');
  assert.equal((await wiki.historyList()).length, count);
  assert.deepEqual((await wiki.historyStatus()).dirty, []);
});
