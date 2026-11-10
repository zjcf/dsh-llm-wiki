import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { API, handler } from '../dist/api.js';
import { extract } from '../dist/extract.js';
import { Wiki } from '../dist/wiki.js';

test('用 Web 请求导入、去重、整理和追溯原件', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = new Wiki(root);
  await wiki.initialize();
  const request = handler(wiki);
  const url = 'http://localhost' + API + '?';
  const body = '# 接入说明\n\n验证标记 edge-proof\n';
  const upload = name => request(new Request(url + new URLSearchParams({ op: 'import', name }), { method: 'POST', body }));
  const first = await (await upload('接入说明.md')).json();
  assert.match(first.record.id, /^s-[a-f0-9]{16}$/);
  assert.equal(first.record.status, 'pending');
  assert.equal(first.duplicate, false);
  const second = await (await upload('副本.md')).json();
  assert.equal(second.duplicate, true);
  assert.equal(second.record.id, first.record.id);
  assert.equal((await upload('../逃逸.md')).status, 400);
  assert.equal((await wiki.search('edge-proof', 'sources'))[0].line, 3);
  const review = await wiki.review({ id: first.record.id, status: 'processed', title: '接入说明', body: '## 核验\n\n验证标记 edge-proof 位于第 3 行。' });
  assert.equal((await wiki.search('edge-proof'))[0].id, review.pageId);
  assert.match((await wiki.page(review.pageId)).body, /\[原文\]\(\.\.\/\.\.\/raw/);
  const response = await request(new Request(url + 'op=original&id=' + first.record.id));
  assert.equal(await response.text(), body);
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.deepEqual((await wiki.check()).errors, []);
  await writeFile(join(root, first.record.original), 'changed');
  await assert.rejects(wiki.import('接入说明.md', Buffer.from(body)), /校验失败|未登记改动/);
  assert.match((await wiki.check()).errors[0], /哈希/);
  await symlink(join(root, 'index.md'), join(root, 'wiki/topics/outside.md'));
  await assert.rejects(wiki.page('wiki/topics/outside.md'), /符号链接/);
  const log = await readFile(join(root, 'log.md'), 'utf8');
  assert.match(log, new RegExp(first.record.id));
});

function makePdf() {
  const stream = 'BT /F1 12 Tf 40 100 Td (pdf proof) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((obj, i) => {
    const offset = pdf.length;
    pdf += (i + 1) + ' 0 obj\n' + obj + '\nendobj\n';
    return offset;
  });
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return new TextEncoder().encode(pdf);
}
test('用 npm 依赖抽取 PDF、DOCX 和 HTML', async () => {
  const pdf = await extract('demo.pdf', makePdf());
  assert.equal(pdf.extraction, 'partial', JSON.stringify(pdf));
  assert.match(pdf.text, /第 1 页[\s\S]*pdf proof/);
  const zip = zipSync({ 'word/document.xml': Buffer.from('<w:document><w:body><w:p><w:r><w:t>文档正文</w:t></w:r></w:p></w:body></w:document>') });
  assert.match((await extract('demo.docx', zip)).text, /文档正文/);
  const html = await extract('demo.html', Buffer.from('<p>可见正文</p><script>untrusted()</script>'));
  assert.equal(html.text, '可见正文');
  assert.equal((await extract('scan.png', new Uint8Array([0, 1]))).extraction, 'unavailable');
});

test('DSH 0.2.2 原生执行器自动整理、保留会话并按阅读范围登记', async t => {
  const { apply } = await import('../dist/dsh.js');
  const root = await mkdtemp(join(tmpdir(), 'wiki-auto-test-'));
  const tools = new Map();
  const routes = new Map();
  const cleanups = [];
  let attempts = 0;
  let assigned;
  const agents = new Map();
  const titles = new Map();
  let released = 0;
  const host = {
    skills: { register() { return()=>{}; } },
    agentPresets: { async register(definition) { assert.equal(definition.id,'dsh-wiki-curation');assert.deepEqual(definition.plugins,[{name:'@deepseek-ai/dsh-tool-executor-native'}]);return async()=>{}; } },
    workspaceRegistry: { async create(path) { return { id: 'wiki-workspace', path }; } },
    effect: setup => cleanups.push(setup()),
    connection: { fetch: { register(route) {
      routes.set(route.path, route.fetch);
      return () => routes.delete(route.path);
    } } },
    tools: { register(tool) {
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }) },
    sessionController: { async create(options) {
      assert.equal(options.workspaceId, 'wiki-workspace');
      assert.equal(options.agentPreset,'dsh-wiki-curation');
      attempts++;
      let request;
      const scoped = new Map();
      const execute = (name,args,caller) => (scoped.get(name) ?? tools.get(name)).execute(args,caller);
      agents.set(options.sessionId, {
          ctx: { tools: {
            register: tool => { scoped.set(tool.name,tool);return()=>{scoped.delete(tool.name);released++;}; },
            guard: check => { assert.ok(check({name:'subagent'}));assert.equal(check({name:'wiki_write_page'}),undefined);return()=>released++; },
            restrict: filter => { assert.deepEqual(filter.allow, ['wiki_get_source', 'wiki_read_source', 'wiki_read_image', 'wiki_search', 'wiki_read_page']); return () => released++; },
          } },
          followup(message) { request = message.content[0].text; },
          cancel() {},
          async whenIdle() {
            const id = request.match(/s-[a-f0-9]{16}/)[0];
            assigned = id;
            await assert.rejects(execute('wiki_record_review',{id,title:'越权',body:'越权',status:'processed'},{agent:{id:'ordinary-agent'}}),/仅供插件内部/);
            if (attempts === 1) return;
            const caller = { agent: { id: options.sessionId } };
            await assert.rejects(execute('wiki_get_source',{ id: 's-0000000000000000' }, caller), /分配的来源/);
            await assert.rejects(execute('wiki_write_page',{type:'answer',title:'不应写',body:'不应写'},caller), /先完整读取/);
            let chunk = await execute('wiki_get_source',{ id }, caller);
            if (attempts >= 4) while (chunk.more) chunk = await execute('wiki_read_source',{ id, start_line: chunk.nextLine, start_column: chunk.nextColumn }, caller);
            await execute('wiki_record_review',{ id, title: '自动整理', body: '## 证据\n\n核对文本。', status: 'processed' }, caller);
            assert.equal((await execute('wiki_get_source',{id},caller)).status,attempts===3?'partial':attempts===2?'partial':'processed');
            if(attempts===2){
              await assert.rejects(execute('wiki_write_page',{type:'answer',title:'缺依据',body:'不应写'},caller),/source_ids/);
              await execute('wiki_write_page',{type:'answer',title:'如何核验？',body:'## 问题\n\n如何核验？\n\n## 回答\n\n核对正文。',source_ids:[id]},caller);
            }
          },
      });
      return { sessionId: options.sessionId };
    }, async resolveAgent(id) { return { agent: agents.get(id) }; }, async rename({sessionId,title}) { titles.set(sessionId,title); } },
  };
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  await apply(host, { root });
  const request = (op, params = {}, body) => {
    const route = op === 'import' ? API + '-upload' : API;
    const method = op === 'import' || op === 'retry-review' ? 'POST' : 'GET';
    return routes.get(route)(new Request('http://localhost' + route + '?' + new URLSearchParams({ op, ...params }), { method, body }));
  };
  async function waitFor(id, matches) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const source = await (await request('source', { id })).json();
      if (matches(source)) return source;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('整理状态未更新');
  }
  const body = '<p>带缺口的 HTML 示例</p>';
  const { record } = await (await request('import', { name: '样例.html' }, body)).json();
  const failed = await waitFor(record.id, source => source.review_job === 'failed');
  assert.ok(agents.has(failed.review_session_id));
  assert.equal(titles.get(failed.review_session_id),'整理 · 样例.html');
  assert.equal(released,5);
  for(const name of ['wiki_record_review','wiki_save_qa','wiki_extract_source']) assert.equal(tools.has(name),false,name);
  assert.equal(assigned, record.id);
  assert.equal((await (await request('import', { name: '副本.html' }, body)).json()).duplicate, true);
  assert.equal(attempts, 1);
  assert.equal((await request('retry-review', { id: record.id })).status, 202);
  await waitFor(record.id, source => source.status === 'partial' && !source.review_job);
  assert.equal(attempts, 2);
  const { record: image } = await (await request('import', { name: '图.png' }, new Uint8Array([0, 1]))).json();
  assert.equal(image.review_job, 'manual');
  assert.equal(attempts, 2);
  const { record: long } = await (await request('import', { name: '长材料.md' }, Array.from({length:100},(_,i)=>'第 '+i+' 行正文').join('\n'))).json();
  await waitFor(long.id, source => source.status === 'partial' && !source.review_job);
  assert.equal((await request('retry-review', { id: long.id })).status, 202);
  await waitFor(long.id, source => source.status === 'processed' && !source.review_job);
  assert.equal(agents.size,4,'整理完成后普通会话仍由 DSH 持有');
  for (let i=0;i<50&&released<20;i++) await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(released,20,'任务结束释放全部临时写入工具及限制');
});

test('删除当前原件及派生物，保留版本、其他证据并移除失效引用', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-delete-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wiki = new Wiki(root);
  await wiki.initialize();
  const { record: old } = await wiki.import('旧版 (v1).md', Buffer.from('过期内容'));
  const { record: active } = await wiki.import('新版.md', Buffer.from('仍然有效'));
  const summary = await wiki.review({ id: old.id, title: '旧版', body: '过期结论', status: 'processed' });
  const theme = 'wiki/topics/部署.md';
  const body = '# 部署\n\n结论 [旧版](../sources/' + old.id + '.md) [新证据](../../' + active.original + ')。\n\n另见 [原件][old-ref]。\n\n[old-ref]: <../../' + old.original + '>\n\n[读本](../../extracted/' + old.id + '-reader.md#P0001)\n';
  const head = '---\ntype: topic\ntitle: 部署\ncreated: "2026-11-05"\nupdated: "2026-11-05"\ntags: []\n---\n';
  await writeFile(join(root, theme), head + body);
  await writeFile(join(root, 'extracted', old.id + '-reader.md'), '图文版');
  const index = join(root, 'index.md');
  await writeFile(index, (await readFile(index, 'utf8')) + '\n- [部署](wiki/topics/部署.md)\n');
  await wiki.historyRecordExternal((await wiki.historyExternalPreview()).token);
  let wakes = 0;
  const request = handler(wiki, { wake() { wakes++; } });
  const target = 'http://localhost' + API + '?id=' + old.id;
  const preview = await (await request(new Request(target + '&op=delete-preview'))).json();
  assert.deepEqual(preview.affected, [theme]);
  await writeFile(join(root, theme), head + body + '\n添加核对说明\n');
  const confirm = token => request(new Request(target + '&op=delete-source&token=' + token, { method: 'POST' }));
  assert.equal((await confirm(preview.token)).status, 409);
  assert.equal((await wiki.original(old.id)).record.id, old.id);
  await wiki.historyRecordExternal((await wiki.historyExternalPreview()).token);
  const latest = await (await request(new Request(target + '&op=delete-preview'))).json();
  assert.equal((await confirm(latest.token)).status, 200);
  for (const path of [old.original, old.text, summary.pageId, 'extracted/' + old.id + '-reader.md']) {
    await assert.rejects(readFile(join(root, path)), { code: 'ENOENT' });
  }
  assert.deepEqual((await wiki.listSources()).map(source => source.id), [active.id]);
  await assert.rejects(wiki.page(theme), /不存在/);
  assert.deepEqual((await wiki.listRebuilds()).map(job => ({ id: job.id, sourceIds: job.sourceIds, state: job.state })), [{ id: theme, sourceIds: [active.id], state: 'queued' }]);
  assert.equal(wakes, 1);
  assert.doesNotMatch(await readFile(index, 'utf8'), new RegExp(old.id));
  assert.deepEqual((await wiki.check()).errors, []);
});
