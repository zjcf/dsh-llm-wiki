import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wiki } from '../dist/wiki.js';
import { apply } from '../dist/dsh.js';
import { API, handler } from '../dist/api.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-cascade-'));
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const wiki = new Wiki(root); await wiki.initialize();
  const sources = [];
  for (const [name, body] of [['旧版', '过期凭据不得保留。'], ['新版', '只保留当前申请流程。'], ['补充', '新流程需要核对负责人。']]) {
    const { record } = await wiki.import(name + '.md', Buffer.from(body));
    await wiki.review({ id: record.id, title: name, body, status: 'processed' }); sources.push(record);
  }
  return { root, wiki, sources, cleanups };
}
async function waitUntil(read, predicate) {
  for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('重整任务未到达预期状态');
}

test('来源删除关联删除单来源页、追踪间接引用；多来源页合并持久任务，删除可 revert', async t => {
  const { root, wiki, sources: [old, active, extra] } = await fixture(t);
  const only = await wiki.writePage({ type: 'answer', title: '过期问答', body: '旧结论。', source_ids: [old.id] });
  const shared = await wiki.writePage({ type: 'topic', title: '申请流程', body: '混合结论。', source_ids: [old.id, active.id, extra.id] });
  const indirect = await wiki.writePage({ type: 'answer', title: '间接旧结论', body: '见[旧知识](../answers/过期问答.md)。' });
  const before = await wiki.previewDeletion(old.id);
  assert.deepEqual(new Set(before.removed), new Set([only.id, shared.id, indirect.id]));
  assert.deepEqual(before.rebuilds.map(job => job.id), [shared.id]);
  await wiki.deleteSource(old.id, before.token);
  const deleted = (await wiki.historyList())[0];
  for (const id of [only.id, shared.id, indirect.id]) await assert.rejects(wiki.page(id), /不存在/);
  assert.deepEqual(await wiki.search('混合结论'), []);
  assert.doesNotMatch(await readFile(join(root, 'index.md'), 'utf8'), /过期问答|申请流程|间接旧结论/);
  const restarted = new Wiki(root); await restarted.initialize();
  assert.deepEqual((await restarted.listRebuilds())[0].sourceIds, [active.id, extra.id].sort());
  const next = await restarted.previewDeletion(active.id); await restarted.deleteSource(active.id, next.token);
  assert.equal((await restarted.listRebuilds()).length, 1);
  assert.deepEqual((await restarted.listRebuilds())[0].sourceIds, [extra.id]);
  const last = await restarted.previewDeletion(extra.id); await restarted.deleteSource(extra.id, last.token);
  assert.deepEqual(await restarted.listRebuilds(), []);
  // 对原始删除单独验收恢复，使用另一份干净的历史状态逐个反向恢复后续删除。
  for (let i = 0; i < 2; i++) {
    const selected = (await restarted.historyList()).find(version => version.meta.kind === 'delete-source' && version.oid !== deleted.oid
      && !(i ? version.meta.subject === extra.id : false));
    const plan = await restarted.historyRevertPreview(selected.oid); await restarted.historyRevert(selected.oid, plan.token);
  }
  const plan = await restarted.historyRevertPreview(deleted.oid); await restarted.historyRevert(deleted.oid, plan.token);
  assert.equal((await restarted.page(only.id)).needsReview, false);
  assert.deepEqual((await restarted.page(shared.id)).sourceIds, [old.id, active.id, extra.id].sort());
  assert.deepEqual(await restarted.listRebuilds(), []);
  assert.deepEqual((await restarted.check()).errors, []);
});

test('删除后只运行一个多来源重整会话；失败可重试，严格限制来源、完整阅读和写入目标', async t => {
  const { root, wiki, sources: [old, active, extra], cleanups } = await fixture(t);
  const shared = await wiki.writePage({ type: 'answer', title: '怎么申请', body: '过期与当前混合。', source_ids: [old.id, active.id, extra.id] });
  const tools = new Map(), routes = new Map(), agents = new Map(), names = [];
  let attempts = 0;
  const host = {
    skills: { register: () => () => {} }, agentPresets: { register: async () => async () => {} },
    workspaceRegistry: { create: async path => ({ id: 'workspace', path }) },
    effect: setup => cleanups.push(setup()),
    connection: { fetch: { register: route => { routes.set(route.path, route.fetch); return () => {}; } } },
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    sessionController: {
      async create({ sessionId }) {
        attempts++; const scoped = new Map(); let prompt;
        const caller = { agent: { id: sessionId } };
        const call = (name, args) => (scoped.get(name) ?? tools.get(name)).execute(args, caller);
        agents.set(sessionId, {
          ctx: { tools: {
            register: tool => { scoped.set(tool.name, tool); return () => scoped.delete(tool.name); },
            restrict: () => () => {}, guard: () => () => {},
          } },
          followup: message => { prompt = message.content[0].text; }, cancel() {},
          async whenIdle() {
            assert.match(prompt, /剩余原件|仍存在的来源/); assert.doesNotMatch(prompt, new RegExp(old.id));
            assert.deepEqual([...scoped.keys()], ['wiki_rebuild_page']);
            await assert.rejects(call('wiki_get_source', { id: old.id }), /剩余来源/);
            await assert.rejects(call('wiki_rebuild_page', { body: '未读', source_ids: [active.id] }), /完整读取/);
            if (attempts === 1) return;
            await call('wiki_get_source', { id: active.id });
            await assert.rejects(call('wiki_rebuild_page', { body: '漏读补充', source_ids: [active.id] }), /完整读取/);
            await call('wiki_get_source', { id: extra.id });
            await assert.rejects(call('wiki_rebuild_page', { body: '旧知识', source_ids: [old.id] }), /剩余来源/);
            await call('wiki_rebuild_page', { body: '当前申请流程，核对负责人。', source_ids: [active.id, extra.id] });
          },
        }); return { sessionId };
      },
      resolveAgent: async id => ({ agent: agents.get(id) }), rename: async ({ title }) => names.push(title),
    },
  };
  await apply(host, { root });
  assert.equal(tools.has('wiki_rebuild_page'), false);
  const request = (op, params = {}, method = 'GET') => routes.get(API)(new Request('http://localhost' + API + '?' + new URLSearchParams({ op, ...params }), { method }));
  const preview = await (await request('delete-preview', { id: old.id })).json();
  assert.equal((await request('delete-source', { id: old.id, token: preview.token }, 'POST')).status, 200);
  await waitUntil(() => wiki.listRebuilds(), jobs => jobs[0]?.state === 'failed');
  await assert.rejects(wiki.page(shared.id), /不存在/);
  assert.deepEqual(await wiki.search('过期与当前混合'), []);
  assert.equal(attempts, 1);
  assert.equal((await request('retry-rebuild', { id: shared.id }, 'POST')).status, 202);
  await waitUntil(() => wiki.listRebuilds(), jobs => !jobs.length);
  assert.equal(attempts, 2); assert.deepEqual(names, ['删除后重整 · 怎么申请', '删除后重整 · 怎么申请']);
  const page = await wiki.page(shared.id);
  assert.deepEqual(page.sourceIds, [active.id, extra.id].sort()); assert.equal(page.needsReview, false);
  assert.doesNotMatch(page.body, /过期|待复核/); assert.match(page.body, /核对负责人/);
  const committed = await waitUntil(() => wiki.historyList(), versions => versions.some(version => version.meta.kind === 'review-complete' && version.meta.subject === shared.id));
  const complete = committed.find(version => version.meta.kind === 'review-complete' && version.meta.subject === shared.id);
  assert.equal(complete.meta.single, true);
  assert.equal((await wiki.historyList()).filter(version => version.meta.session === complete.meta.session).length, 1);
  assert.deepEqual((await wiki.check()).errors, []);
});

test('自动整理关闭时，多来源删除不能悄悄留下待处理任务', async t => {
  const { wiki, sources: [old, active] } = await fixture(t);
  await wiki.writePage({ type: 'topic', title: '跨来源', body: '跨来源事实。', source_ids: [old.id, active.id] });
  const request = handler(wiki), preview = await wiki.previewDeletion(old.id);
  const response = await request(new Request('http://localhost' + API + '?' + new URLSearchParams({ op: 'delete-source', id: old.id, token: preview.token }), { method: 'POST' }));
  assert.equal(response.status, 409); assert.match((await response.json()).error, /启用自动整理/);
  assert.equal((await wiki.original(old.id)).record.id, old.id);
});

test('重建与引用检查原子提交，失败不暴露半成品；证据不足可保持删除，完成后可按会话 revert', async t => {
  const { wiki, sources: [old, active] } = await fixture(t);
  const saved = await wiki.writePage({ type: 'topic', title: '证据边界', body: '旧结论。', source_ids: [old.id, active.id] });
  await wiki.deleteSource(old.id, (await wiki.previewDeletion(old.id)).token);
  const task = await wiki.claimRebuild(); await wiki.setRebuildSession(task.id, 'rebuild-proof');
  await assert.rejects(wiki.finishRebuild(task.id, 'rebuild-proof', { body: '残留[旧原件](../../' + old.original + ')', source_ids: [active.id] }), /无效引用/);
  await assert.rejects(wiki.page(saved.id), /不存在/);
  assert.equal((await wiki.listRebuilds())[0].state, 'running');
  await wiki.finishRebuild(task.id, 'rebuild-proof', { omit_reason: '剩余材料没有支持该主题的事实。' });
  assert.deepEqual(await wiki.listRebuilds(), []);
  await assert.rejects(wiki.page(saved.id), /不存在/);
  const completed = (await wiki.historyList())[0];
  const plan = await wiki.historyRevertPreview(completed.oid); await wiki.historyRevert(completed.oid, plan.token);
  const jobs = await wiki.listRebuilds();
  assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'failed', '回退恢复任务不自动重新派发');
  assert.deepEqual((await wiki.check()).errors, []);
});
