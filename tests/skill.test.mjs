import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../dist/dsh.js';
import { knowledgeAnswerGuide, knowledgeIntakeGuide } from '../dist/skill.js';

test('关闭自动整理仍注册可手动/自动调用的查询技能，插件停用同步移除', async t => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skills = new Map(), tools = new Map(), cleanups = [];
  const host = {
    skills: { register(skill) {
      assert.equal(skills.has(skill.name), false);
      skills.set(skill.name, skill);
      return () => skills.delete(skill.name);
    } },
    workspaceRegistry: { async create(path) { return { id: 'workspace-proof', path }; } },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    connection: { fetch: { register() { return () => {}; } } },
    effect(setup) { cleanups.push(setup()); },
  };
  await apply(host, { root, autoReview: false });
  assert.equal(skills.size, 1);
  const skill = skills.get('llm-wiki');
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(skill.source, 'runtime');
  assert.ok(skill.content.length > 0);
  assert.ok(skill.content.includes(knowledgeAnswerGuide));
  assert.ok(skill.content.includes(knowledgeIntakeGuide));
  for (const name of ['wiki_write_page', 'wiki_update_page']) assert.ok(tools.get(name).description.includes(knowledgeIntakeGuide));
  assert.ok((await readFile(join(root, 'AGENTS.md'), 'utf8')).includes(knowledgeIntakeGuide));
  // 查询不加载录入问卷，仍采用简洁回答规则。
  for (const name of ['wiki_search', 'wiki_read_page']) assert.equal(tools.get(name).description.includes(knowledgeIntakeGuide), false);
  for (const dispose of cleanups.reverse()) await dispose();
  assert.equal(skills.size, 0);
});
