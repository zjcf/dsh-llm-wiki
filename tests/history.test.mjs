import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { Wiki } from '../dist/wiki.js';
import { History } from '../dist/history.js';
import { GitSync, gitHttp } from '../dist/git-sync.js';
import { handler, API } from '../dist/api.js';

async function fixture(t, credentials) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = new Wiki(root, credentials); await wiki.initialize();
  return { wiki, root, history: new History(root) };
}
async function record(wiki) { await wiki.historyRecordExternal((await wiki.historyExternalPreview()).token); }

test('每次业务变更生成版本，revert 保留后续来源和全部历史', async t => {
  const { wiki, root } = await fixture(t);
  const { record: a } = await wiki.import('甲.md', Buffer.from('甲的原件'));
  const selected = (await wiki.historyList())[0];
  assert.equal(selected.meta.kind, 'import');
  const { record: b } = await wiki.import('乙.md', Buffer.from('乙的原件'));
  const before = await wiki.historyList();
  const preview = await wiki.historyRevertPreview(selected.oid);
  assert.deepEqual(preview.conflicts, []);
  await wiki.historyRevert(selected.oid, preview.token);
  assert.deepEqual((await wiki.listSources()).map(s => s.id), [b.id]);
  await assert.rejects(readFile(join(root, a.original)), { code: 'ENOENT' });
  assert.equal((await wiki.original(b.id)).bytes.toString(), '乙的原件');
  const after = await wiki.historyList();
  assert.equal(after.length, before.length + 1);
  assert.equal(after[0].meta.kind, 'revert');
  assert.equal(after[0].meta.reverts, selected.oid);
  assert.equal(after[0].parent, before[0].oid);
  assert.deepEqual(after.slice(1).map(v => v.oid), before.map(v => v.oid));
  assert.deepEqual((await wiki.check()).errors, []);
});

test('revert 冲突和过期确认均不写文件，不移动历史', async t => {
  const { wiki } = await fixture(t);
  const { record: source } = await wiki.import('样例.md', Buffer.from('内容'));
  const first = await wiki.writePage({ type: 'topic', title: '主题', body: '第一行\n\n中间行\n\n最后行', source_ids: [source.id] });
  const page = await wiki.page(first.id);
  await wiki.updatePage({ id: first.id, expected_revision: page.revision, old_text: '中间行', new_text: '选中变更' });
  const selected = (await wiki.historyList())[0].oid;
  const preview = await wiki.historyRevertPreview(selected);
  const current = await wiki.page(first.id);
  await wiki.updatePage({ id: first.id, expected_revision: current.revision, old_text: '选中变更', new_text: '后续变更' });
  const head = (await wiki.historyStatus()).head, body = (await wiki.page(first.id)).body;
  await assert.rejects(wiki.historyRevert(selected, preview.token), /重新预览/);
  const conflict = await wiki.historyRevertPreview(selected);
  assert.ok(conflict.conflicts.includes(first.id));
  await assert.rejects(wiki.historyRevert(selected, conflict.token), /冲突/);
  assert.equal((await wiki.historyStatus()).head, head);
  assert.equal((await wiki.page(first.id)).body, body);
});

test('整组整理通过一个 revert 提交撤销，保留穿插导入和原始历史', async t => {
  const { wiki } = await fixture(t);
  const { record: source } = await wiki.import('整理.md', Buffer.from('整理内容'), true);
  await wiki.claimReview(); await wiki.setReviewSession(source.id, 'curation-fixture');
  await wiki.review({ id: source.id, title: '整理', body: '整理内容', status: 'processed' }, true, 'curation-fixture');
  const other = await wiki.import('穿插.md', Buffer.from('穿插导入'));
  await wiki.writePage({ type: 'answer', title: '整理问答', body: '回答', source_ids: [source.id] }, 'curation-fixture');
  await wiki.finishReview(source.id);
  const selected = (await wiki.historyList())[0], count = (await wiki.historyList()).length;
  assert.equal(selected.meta.kind, 'review-complete');
  const preview = await wiki.historyRevertPreview(selected.oid);
  assert.equal(preview.commits.length, 4);
  assert.deepEqual(preview.conflicts, []);
  await wiki.historyRevert(selected.oid, preview.token);
  assert.equal((await wiki.historyList()).length, count + 1);
  assert.equal((await wiki.source(source.id)).status, 'pending');
  assert.equal((await wiki.source(other.record.id)).id, other.record.id);
  assert.equal((await wiki.listPages()).length, 0);
  assert.equal((await wiki.historyList())[0].meta.revertedCommits.length, 4);
  assert.deepEqual((await wiki.check()).errors, []);
});

test('已登记的损坏 manifest 可以 revert 恢复，不抹掉损坏记录', async t => {
  const { wiki, root } = await fixture(t);
  await writeFile(join(root, '.wiki/manifest.json'), '{ damaged'); await record(wiki);
  const selected = (await wiki.historyList())[0];
  const preview = await wiki.historyRevertPreview(selected.oid); await wiki.historyRevert(selected.oid, preview.token);
  assert.deepEqual(await wiki.listSources(), []);
  assert.equal((await wiki.historyList())[1].oid, selected.oid);
});

test('删除来源的反向提交恢复原件、知识、登记和引用，保留删除记录', async t => {
  const { wiki, root } = await fixture(t);
  const bytes = Buffer.from('原件字节\n');
  const { record: source } = await wiki.import('原件.md', bytes);
  await wiki.review({ id: source.id, title: '来源', body: '原件字节', status: 'processed' });
  const page = await wiki.writePage({ type: 'answer', title: '问答', body: '回答', source_ids: [source.id] });
  const { token } = await wiki.previewDeletion(source.id); await wiki.deleteSource(source.id, token);
  const deleted = (await wiki.historyList())[0];
  assert.equal(deleted.meta.kind, 'delete-source');
  await assert.rejects(readFile(join(root, source.original)), { code: 'ENOENT' });
  const plan = await wiki.historyRevertPreview(deleted.oid); assert.deepEqual(plan.conflicts, []);
  await wiki.historyRevert(deleted.oid, plan.token);
  assert.deepEqual((await wiki.original(source.id)).bytes, bytes);
  assert.ok((await wiki.page(page.id)).sourceIds.includes(source.id));
  assert.match(await readFile(join(root, 'log.md'), 'utf8'), /删除当前来源[\s\S]*revert/);
  assert.deepEqual((await wiki.check()).errors, []);
});

test('未知改动不被日常提交吞并，只有管理入口能登记，随后可 revert', async t => {
  const { wiki, root } = await fixture(t);
  const original = await readFile(join(root, 'index.md'), 'utf8');
  await writeFile(join(root, 'index.md'), original + '\n外部改动\n');
  await assert.rejects(wiki.import('新.md', Buffer.from('新材料')), /未登记改动/);
  assert.deepEqual((await wiki.historyStatus()).dirty, ['index.md']);
  await record(wiki); const unknown = (await wiki.historyList())[0];
  assert.equal(unknown.meta.kind, 'external-unverified');
  const plan = await wiki.historyRevertPreview(unknown.oid);
  await wiki.historyRevert(unknown.oid, plan.token);
  assert.equal(await readFile(join(root, 'index.md'), 'utf8'), original);
  assert.deepEqual((await wiki.historyStatus()).dirty, []);
});

test('业务中途失败恢复全部文件；启动补偿未提交事务且不改写分支', async t => {
  const { wiki, root, history } = await fixture(t);
  const initial = await wiki.historyStatus();
  await assert.rejects(history.transaction(async () => {
    await writeFile(join(root, 'index.md'), '中途修改');
    await writeFile(join(root, 'wiki/topics/半成品.md'), '不应残留');
    throw new Error('业务失败');
  }, { kind: 'test' }), /业务失败/);
  assert.deepEqual((await wiki.historyStatus()).dirty, []);
  await assert.rejects(readFile(join(root, 'wiki/topics/半成品.md')), { code: 'ENOENT' });
  await writeFile(join(root, '.wiki/history-transaction.json'), JSON.stringify({ head: initial.head, id: 'interrupted-fixture', manifest: null }));
  await writeFile(join(root, 'index.md'), '进程中断');
  const restarted = new Wiki(root); await restarted.initialize();
  assert.equal((await restarted.historyStatus()).head, initial.head);
  assert.deepEqual((await restarted.historyStatus()).dirty, []);
});

test('运行中整理禁止撤销；版本和同步操作仅在管理 API 提供', async t => {
  const { wiki } = await fixture(t);
  const { record: source } = await wiki.import('排队.md', Buffer.from('材料'), true);
  await wiki.claimReview();
  await assert.rejects(wiki.historyRevertPreview((await wiki.historyList())[0].oid), /整理任务/);
  const request = handler(wiki);
  assert.equal((await request(new Request('http://localhost' + API + '?op=history-revert'))).status, 404);
  const response = await request(new Request('http://localhost' + API + '?op=history-status'));
  assert.equal(response.status, 200);
  assert.equal((await wiki.source(source.id)).review_job, 'running');
});

function credentialFixture() {
  const secrets = new Map();
  return { secrets, async set(ref, value) { secrets.set(ref, value); }, async resolve(ref) { return secrets.has(ref) ? { value: secrets.get(ref) } : undefined; }, async unset(ref) { secrets.delete(ref); } };
}
async function waitFor(fn, matches, limit = 150) {
  let last;
  for (let i = 0; i < limit; i++) { last = await fn(); if (matches(last)) return last; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('同步状态未达到预期：' + JSON.stringify(last));
}

test('Token 存宿主、配置 CAS 与目标绑定，失败不泄露 Token并保留待同步版本', async t => {
  const credentials = credentialFixture(); const { history, root } = await fixture(t);
  const sync = new GitSync(history, credentials, { async request() { throw new Error('网络失败 secret-fixture-token'); } });
  await sync.initialize(); t.after(() => sync.dispose());
  const before = await sync.status();
  await sync.save({ url: 'https://example.test/wiki.git', branch: 'main', token: 'secret-fixture-token', revision: before.revision });
  const failed = await waitFor(() => sync.status(), s => !!s.error);
  assert.doesNotMatch(JSON.stringify(failed), /secret-fixture-token/);
  assert.equal(failed.pending, 1);
  assert.equal(failed.configured, true);
  const config = await readFile(join(root, '.wiki/history-remote.json'), 'utf8');
  assert.doesNotMatch(config, /secret-fixture-token/);
  await assert.rejects(sync.save({ url: 'https://other.test/wiki.git', branch: 'main', revision: failed.revision }), /重新填写 Token/);
  await assert.rejects(sync.save({ url: before.url, branch: 'main', revision: before.revision }), /已变化/);
  await assert.rejects(sync.save({ url: 'https://user:secret@example.test/wiki.git', branch: 'main', token: 'secret', revision: failed.revision }), /不能包含凭据/);
  const versions = await history.list();
  assert.equal(versions.length, 1, '配置和 Token 均不进入数据版本');
});

test('业务写入期间自动推送等待完成，不把暂态文件误判为篡改并永久停推', async t => {
  const credentials=credentialFixture(),{history,root}=await fixture(t);let calls=0;
  const sync=new GitSync(history,credentials,{async request(){calls++;throw new Error('fixture offline');}});
  await sync.initialize();t.after(()=>sync.dispose());
  await writeFile(join(root,'.wiki/write.lock'),'fixture');
  const status=await sync.status();await sync.save({url:'https://example.test/wiki.git',branch:'main',token:'fixture-token',revision:status.revision});
  await waitFor(async()=>({running:!!sync.current}),s=>!s.running);
  assert.equal(calls,0);assert.equal((await sync.status()).error,null);
  await rm(join(root,'.wiki/write.lock'));
  await waitFor(async()=>({calls}),s=>s.calls>0);
});

async function gitServer(t) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-git-server-'));
  const repo = join(root, 'wiki.git');
  const run = (...args) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  run('init', '--bare', repo); run('--git-dir', repo, 'config', 'http.receivepack', 'true');
  run('--git-dir', repo, 'config', 'receive.denyNonFastForwards', 'true');
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Basic ' + Buffer.from('oauth2:fixture-token').toString('base64')) { response.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }); response.end(); return; }
    const url = new URL(request.url, 'http://fixture');
    const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, REQUEST_METHOD: request.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers['content-type'] ?? '', REMOTE_USER: 'fixture' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let headers = Buffer.alloc(0), sent = false;
    child.stdout.on('data', chunk => {
      if (sent) { response.write(chunk); return; }
      headers = Buffer.concat([headers, chunk]); const end = headers.indexOf('\r\n\r\n'); if (end < 0) return;
      const parsed = {}, lines = headers.subarray(0, end).toString().split('\r\n'); let status = 200;
      for (const line of lines) { const colon = line.indexOf(':'); const key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim(); if (key === 'status') status = Number(value.slice(0, 3)); else parsed[key] = value; }
      response.writeHead(status, parsed); response.write(headers.subarray(end + 4)); sent = true;
    });
    child.on('close', () => response.end()); request.pipe(child.stdin);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const http = { request: request => gitHttp.request({ ...request, url: request.url.replace('https://fixture.test', 'http://127.0.0.1:' + server.address().port) }) };
  return { repo, run, http, url: 'http://127.0.0.1:' + server.address().port + '/wiki.git' };
}

test('真实 Git HTTP 远端自动 push 与 revert；分叉时拒绝覆盖且不 force push', async t => {
  const server = await gitServer(t), credentials = credentialFixture();
  const { wiki, history } = await fixture(t);
  let offline = false;
  const transport = { request: request => { if (offline) throw new Error('offline fixture'); return server.http.request(request); } };
  const sync = new GitSync(history, credentials, transport); await sync.initialize(); t.after(() => sync.dispose());
  history.onCommit = () => sync.wake();
  // Wiki 与 fixture History 指向同一仓库；用管理写入完成后显式唤醒测试同步实例。
  const s = await sync.status(); await sync.save({ url: server.url, branch: 'main', token: 'fixture-token', revision: s.revision });
  await waitFor(() => sync.status(), s => s.state === 'synced');
  offline = true;
  const imported = await wiki.import('同步.md', Buffer.from('同步原件')); sync.wake();
  const pending = await waitFor(() => sync.status(), s => !!s.error);
  assert.ok(pending.pending > 0); assert.equal((await wiki.original(imported.record.id)).bytes.toString(), '同步原件');
  offline = false; sync.wake(true);
  await waitFor(() => sync.status(), s => s.state === 'synced');
  const remote = server.run('--git-dir', server.repo, 'rev-parse', 'refs/heads/main');
  assert.equal(remote, (await wiki.historyStatus()).head);
  const chosen = (await wiki.historyList())[0].oid, preview = await wiki.historyRevertPreview(chosen);
  await wiki.historyRevert(chosen, preview.token); sync.wake();
  await waitFor(() => sync.status(), s => s.state === 'synced');
  const reverted = server.run('--git-dir', server.repo, 'rev-parse', 'refs/heads/main');
  assert.equal(server.run('--git-dir', server.repo, 'merge-base', '--is-ancestor', remote, reverted), '');
  assert.equal((await wiki.listSources()).some(s => s.id === imported.record.id), false);
  await sync.dispose();
  const tree = server.run('--git-dir', server.repo, 'rev-parse', 'refs/heads/main^{tree}');
  const foreign = server.run('--git-dir', server.repo, 'commit-tree', tree, '-p', reverted, '-m', 'foreign history');
  server.run('--git-dir', server.repo, 'update-ref', 'refs/heads/main', foreign);
  await wiki.import('本地后续.md', Buffer.from('独立改动'));
  const restarted = new GitSync(history, credentials, server.http); await restarted.initialize(); t.after(() => restarted.dispose()); restarted.wake();
  const conflict = await waitFor(() => restarted.status(), s => !!s.error);
  assert.match(conflict.error, /远端历史/);
  assert.equal(server.run('--git-dir', server.repo, 'rev-parse', 'refs/heads/main'), foreign);
  assert.ok(conflict.pending > 0);
});

test('GitLab 空仓库默认分支拒绝时显示项目角色原因，不误报配置保存失败', async t => {
  const server = await gitServer(t), credentials = credentialFixture();
  await writeFile(join(server.repo, 'hooks/pre-receive'), '#!/bin/sh\necho "GitLab: A default branch (e.g. main) does not yet exist for this project." >&2\nexit 1\n', { mode: 0o700 });
  const { history } = await fixture(t);
  const sync = new GitSync(history, credentials, server.http); await sync.initialize(); t.after(() => sync.dispose());
  await sync.save({ url: server.url, branch: 'main', token: 'fixture-token', revision: (await sync.status()).revision });
  const status = await waitFor(() => sync.status(), s => !!s.error);
  assert.match(status.error, /尚无默认分支/); assert.match(status.error, /Maintainer\/Owner/);
  assert.equal(status.configured, true); assert.equal(status.url, server.url); assert.equal(status.pending, 1);
  assert.doesNotMatch(status.error, /fixture-token/);
});
