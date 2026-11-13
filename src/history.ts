import fs from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as git from 'isomorphic-git';
import { merge } from 'node-diff3';

export class HistoryError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
export interface ChangeMeta { kind: string; subject?: string; title?: string; session?: string; single?: boolean; reverts?: string; revertedCommits?: string[]; transaction?: string }
type Files = Map<string, string>;
type Journal = { head: string; id: string; manifest: string | null };
export interface Version { oid: string; parent?: string; message: string; date: string; meta: ChangeMeta }
export interface FileChange { path: string; before: string | null; after: string | null; binary: boolean; conflict?: boolean; loaded?: boolean; change?: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';
const allowed = (path: string) => /^(?:wiki\/|raw\/|extracted\/)/.test(path) || ['.wiki/manifest.json', 'index.md', 'log.md', 'README.md', 'AGENTS.md'].includes(path);
const text = (bytes: Uint8Array) => { try { const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return s.includes('\0') ? null : s; } catch { return null; } };

// 队列与错误状态属于运行时，不从历史中重新派发任务。
function canonical(path: string, bytes: Uint8Array): Uint8Array {
  if (path !== '.wiki/manifest.json') return bytes;
  try {
    const data = JSON.parse(Buffer.from(bytes).toString('utf8'));
    for (const source of Object.values(data.sources ?? {}) as Record<string, unknown>[]) {
      delete source.review_job; delete source.review_error; delete source.review_job_session_id;
    }
    for (const job of Object.values(data.rebuilds ?? {}) as Record<string, unknown>[]) {
      delete job.state; delete job.error; delete job.activeSessionId;
    }
    return Buffer.from(JSON.stringify(data, null, 2) + '\n');
  } catch { return bytes; } // 未登记的损坏内容仍能被记录和撤销。
}
function mergeJson(ours: any, base: any, theirs: any): any {
  if (same(ours, base)) return theirs;
  if (same(theirs, base) || same(ours, theirs)) return ours;
  if ([ours, base, theirs].every(v => v && typeof v === 'object' && !Array.isArray(v))) {
    const result = Object.create(null);
    for (const key of new Set([...Object.keys(ours), ...Object.keys(base), ...Object.keys(theirs)])) {
      const value = mergeJson(ours[key], base[key], theirs[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  throw new HistoryError('登记内容存在后续修改，不能自动撤销');
}

/** 私有数据仓库；不使用、接管或改写工作区已有的 .git。所有写方法由 Wiki 的跨进程锁保护。 */
export class History {
  readonly gitdir: string;
  private readonly statePath = '.wiki/history-state.json';
  private readonly journalPath = '.wiki/history-transaction.json';
  onCommit?: () => void;
  onInspection?: () => void;
  lastDirty: string[] = [];
  private readonly fileCache = new Map<string, { signature: string; oid: string; persisted: boolean }>();
  private readonly treeCache = new Map<string, Files>();
  private readonly knownVersions = new Set<string>();
  constructor(readonly root: string) { this.gitdir = join(root, '.wiki/history.git'); }
  private get args() { return { fs, gitdir: this.gitdir }; }

  async safePath(path: string) {
    if (path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) throw new HistoryError('版本路径无效');
    let target = this.root;
    for (const part of path.split('/')) {
      target = join(target, part);
      try { if ((await lstat(target)).isSymbolicLink()) throw new HistoryError('版本路径不能包含符号链接'); }
      catch (e) { if (!absent(e)) throw e; }
    }
    return target;
  }
  async atomic(path: string, content: string | Uint8Array) {
    const target = await this.safePath(path), temporary = target + '.' + randomUUID() + '.tmp';
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
  }
  private async optional(path: string) {
    try { return await readFile(await this.safePath(path), 'utf8'); } catch (e) { if (absent(e)) return null; throw e; }
  }
  async initialize(readOnly = false) {
    await this.safePath('.wiki/history.git');
    if (readOnly) { await this.assertHead(); return; }
    const state = await this.optional(this.statePath);
    if (!state) {
      if (await this.optional('.wiki/history.git/HEAD')) throw new HistoryError('发现未登记的版本仓库，请先核实，未自动接管');
      await git.init({ ...this.args, defaultBranch: 'main', bare: true });
      await this.commit({ kind: 'baseline' }, true);
    }
    await this.recover();
    await this.assertHead();
    await git.setConfig({ ...this.args, path: 'remote.origin.fetch', value: 'refs/heads/*:refs/remotes/origin/*' });
  }
  async head() { return git.resolveRef({ ...this.args, ref: 'refs/heads/main' }); }
  private async assertHead() {
    const state = JSON.parse((await this.optional(this.statePath)) ?? '{}');
    if (state.head !== await this.head()) throw new HistoryError('版本分支与已登记记录不一致，已停止写入和同步');
  }
  async filesAt(oid: string): Promise<Files> {
    const cached = this.treeCache.get(oid); if (cached) return cached;
    const { commit } = await git.readCommit({ ...this.args, oid });
    const files: Files = new Map();
    const walk = async (tree: string, prefix: string) => {
      for (const entry of (await git.readTree({ ...this.args, oid: tree })).tree) {
        const path = prefix + entry.path;
        if (entry.type === 'tree') { if (!['wiki', 'raw', 'extracted', '.wiki'].includes(path.split('/')[0])) throw new HistoryError('版本包含非知识库路径'); await walk(entry.oid, path + '/'); }
        else { if (entry.mode !== '100644' || !allowed(path)) throw new HistoryError('版本包含不支持的文件'); await this.safePath(path); files.set(path, entry.oid); }
      }
    };
    await walk(commit.tree, '');
    if (this.treeCache.size >= 4) this.treeCache.delete(this.treeCache.keys().next().value!);
    this.treeCache.set(oid, files); return files;
  }
  private async current(persist = false): Promise<Files> {
    const files: Files = new Map();
    const visit = async (path: string) => {
      const target = await this.safePath(path);
      let stat; try { stat = await lstat(target, { bigint: true }); } catch (e) { if (absent(e)) return; throw e; }
      if (stat.isDirectory()) {
        for (const entry of await readdir(target)) if (!/^\.wiki-.*\.tmp$/.test(entry)) await visit(path + '/' + entry);
      } else {
        if (!stat.isFile() || !allowed(path)) throw new HistoryError('知识库包含不支持的文件');
        const signature = [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
        const cached = this.fileCache.get(path);
        if (cached?.signature === signature && (!persist || cached.persisted)) { files.set(path, cached.oid); return; }
        const bytes = canonical(path, await readFile(target));
        const oid = persist ? await git.writeBlob({ ...this.args, blob: bytes }) : (await git.hashBlob({ object: bytes })).oid;
        this.fileCache.set(path, { signature, oid, persisted: persist });
        files.set(path, oid);
      }
    };
    for (const path of ['wiki', 'raw', 'extracted', '.wiki/manifest.json', 'index.md', 'log.md', 'README.md', 'AGENTS.md']) await visit(path);
    for (const path of this.fileCache.keys()) if (!files.has(path)) this.fileCache.delete(path);
    return files;
  }
  private changed(before: Files, after: Files) { return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p)).sort(); }
  async dirty() { await this.assertHead(); this.lastDirty = this.changed(await this.filesAt(await this.head()), await this.current()); this.onInspection?.(); return this.lastDirty; }
  async assertClean() {
    const dirty = await this.dirty();
    if (dirty.length) throw new HistoryError('发现未登记改动，已停止写入。请在版本历史中核对并登记：' + dirty.slice(0, 5).join('、'));
  }
  private async tree(files: Files, prefix = ''): Promise<string> {
    const entries: git.TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, oid] of files) {
      if (!path.startsWith(prefix)) continue;
      const tail = path.slice(prefix.length), slash = tail.indexOf('/');
      if (slash < 0) entries.push({ path: tail, mode: '100644', type: 'blob', oid });
      else dirs.add(tail.slice(0, slash));
    }
    for (const dir of dirs) entries.push({ path: dir, mode: '040000', type: 'tree', oid: await this.tree(files, prefix + dir + '/') });
    return git.writeTree({ ...this.args, tree: entries });
  }
  private async commit(meta: ChangeMeta, forceEmpty = false) {
    let parent: string | undefined;
    try { parent = await this.head(); } catch (e) { if (meta.kind !== 'baseline') throw e; }
    const files = await this.current(true);
    if (parent && !forceEmpty && !this.changed(await this.filesAt(parent), files).length) return parent;
    const title = meta.kind === 'revert' && meta.reverts ? 'Revert "' + (await this.version(meta.reverts)).message.replace(/[\r\n"]/g, ' ').slice(0, 200) + '"' : meta.kind + (meta.subject ? ' · ' + meta.subject.replace(/[\r\n]/g, ' ').slice(0, 200) : '');
    const oid = await git.commit({ ...this.args, ref: 'refs/heads/main', parent: parent ? [parent] : [], tree: await this.tree(files),
      message: title + (meta.reverts ? '\n\nThis reverts ' + (meta.revertedCommits ?? [meta.reverts]).map(oid => 'commit ' + oid).join(', ') + '.' : '') + '\n\nWiki-Meta: ' + JSON.stringify(meta) + '\n',
      author: { name: 'LLM Wiki', email: 'llm-wiki@dsh.local' } });
    await this.atomic(this.statePath, JSON.stringify({ head: oid }) + '\n');
    return oid;
  }
  async transaction<T>(fn: () => Promise<T>, meta: ChangeMeta) {
    await this.assertClean();
    const journal: Journal = { head: await this.head(), id: randomUUID(), manifest: await this.optional('.wiki/manifest.json') };
    await this.atomic(this.journalPath, JSON.stringify(journal));
    try {
      const result = await fn();
      await this.commit({ ...meta, transaction: journal.id }, meta.kind === 'review-complete');
      await rm(await this.safePath(this.journalPath));
      this.onCommit?.();
      return result;
    } catch (e) {
      // 分支已经前进时保留日志，由恢复流程完成登记，绝不倒退分支。
      if (await this.head() === journal.head) { await this.restore(journal); await rm(await this.safePath(this.journalPath)); }
      throw e;
    }
  }
  private async restore(journal: Journal) {
    const before = await this.filesAt(journal.head), current = await this.current();
    for (const path of this.changed(current, before)) {
      const oid = before.get(path);
      if (oid) await this.atomic(path, (await git.readBlob({ ...this.args, oid })).blob);
      else await rm(await this.safePath(path));
    }
    if (journal.manifest !== null) await this.atomic('.wiki/manifest.json', journal.manifest);
  }
  private async recover() {
    const value = await this.optional(this.journalPath); if (!value) return;
    const journal: Journal = JSON.parse(value), head = await this.head();
    if (head === journal.head) await this.restore(journal);
    else {
      const version = await this.version(head);
      if (version.parent !== journal.head || version.meta.transaction !== journal.id) throw new HistoryError('版本事务记录不一致，请核查');
      await this.atomic(this.statePath, JSON.stringify({ head }) + '\n');
    }
    await rm(await this.safePath(this.journalPath));
  }
  private async version(oid: string): Promise<Version> {
    const { commit } = await git.readCommit({ ...this.args, oid });
    const marker = /^Wiki-Meta: (.*)$/m.exec(commit.message);
    return { oid, parent: commit.parent[0], message: commit.message.split('\n')[0], date: new Date(commit.committer.timestamp * 1000).toISOString(), meta: marker ? JSON.parse(marker[1]) : { kind: 'unknown' } };
  }
  async list(before?: string, limit = 50) {
    await this.assertHead();
    if (before) await this.requireVersion(before);
    const items = await git.log({ ...this.args, ref: before || 'refs/heads/main', depth: Math.min(51, Math.max(1, limit)) + Number(!!before) });
    const selected = before ? items.slice(1) : items;
    for (const item of selected) this.knownVersions.add(item.oid);
    while (this.knownVersions.size > 500) this.knownVersions.delete(this.knownVersions.values().next().value!);
    return Promise.all(selected.map(item => this.version(item.oid)));
  }
  private async requireVersion(oid: string) {
    await this.assertHead();
    if (!/^[a-f0-9]{40}$/.test(oid)) throw new HistoryError('版本号无效', 400);
    const head = await this.head();
    if (oid !== head && !this.knownVersions.has(oid) && !await git.isDescendent({ ...this.args, oid: head, ancestor: oid })) throw new HistoryError('版本不在当前历史中');
    return this.version(oid);
  }
  private async blob(oid?: string) { return oid ? Buffer.from((await git.readBlob({ ...this.args, oid })).blob) : undefined; }
  async diff(oid: string, options?: { offset?: number; limit?: number; path?: string }) {
    const version = await this.requireVersion(oid), after = await this.filesAt(oid), before = version.parent ? await this.filesAt(version.parent) : new Map();
    const paths = this.changed(before, after);
    const offset = Math.max(0, Number.isFinite(options?.offset) ? Math.floor(options!.offset!) : 0), limit = Math.min(100, Math.max(1, Number.isFinite(options?.limit) ? Math.floor(options!.limit!) : 50));
    if (options && !options.path) return { version, total: paths.length, offset, limit,
      files: paths.slice(offset, offset + limit).map(path => ({ path, before: null, after: null, binary: path.startsWith('raw/'), loaded: false,
        change: !before.has(path) ? '新增' : !after.has(path) ? '删除' : '修改' })) };
    if (options?.path && !paths.includes(options.path)) throw new HistoryError('该文件不属于此版本变更', 404);
    const files: FileChange[] = [];
    let displayed = 0;
    for (const path of options?.path ? [options.path] : paths) {
      if (path.startsWith('raw/')) { files.push({ path, before: null, after: null, binary: true, loaded: true }); continue; }
      const a = await this.blob(before.get(path)), b = await this.blob(after.get(path));
      // 原件只显示文件变更，不把二进制或大文件正文送入管理页。
      const small = (a?.length ?? 0) + (b?.length ?? 0) <= 60_000 && displayed < 500_000;
      const left = a && small ? text(a) : null, right = b && small ? text(b) : null;
      const tooManyLines = (left?.split('\n').length ?? 0) + (right?.split('\n').length ?? 0) > 2000;
      displayed += (left?.length ?? 0) + (right?.length ?? 0);
      files.push({ path, before: tooManyLines ? null : left ?? null, after: tooManyLines ? null : right ?? null, binary: tooManyLines || !small || !!a && left === null || !!b && right === null, loaded: true });
    }
    return { version, files };
  }
  async revertPlan(oid: string) {
    await this.assertClean();
    const version = await this.requireVersion(oid);
    if (!version.parent) throw new HistoryError('初始版本不能撤销');
    const versions = [version];
    // 完成标记代表一次完整整理；只反向应用本会话的提交，保留穿插的其他导入。
    if (version.meta.kind === 'review-complete' && version.meta.session && !version.meta.single) {
      let cursor: string | undefined = version.parent, found = false;
      for (let i = 0; cursor && i < 2000; i++) {
        const item = await this.version(cursor); cursor = item.parent;
        if (item.meta.session !== version.meta.session) continue;
        versions.push(item);
        if (item.meta.kind === 'review-start') { found = true; break; }
      }
      if (!found) throw new HistoryError('整理记录不完整，无法整组撤销，请按具体提交核对');
    }
    const original = await this.filesAt(await this.head()), ours = new Map(original), conflicts: string[] = [];
    for (const selected of versions) {
      if (!selected.parent) throw new HistoryError('初始版本不能撤销');
      const before = await this.filesAt(selected.parent), base = await this.filesAt(selected.oid);
      const changes: { path: string; bytes?: Buffer }[] = [];
      for (const path of this.changed(before, base).filter(path => path !== 'log.md')) {
      const a = ours.get(path), b = base.get(path), c = before.get(path);
      if (a === c) continue;
      if (a === b) { changes.push({ path, bytes: await this.blob(c) }); continue; }
      if (!a || !b || !c || /^(raw\/|extracted\/assets\/)/.test(path)) { conflicts.push(path); continue; }
      const [ab, bb, cb] = await Promise.all([this.blob(a), this.blob(b), this.blob(c)]);
      const [at, bt, ct] = [ab, bb, cb].map(v => v && v.length <= 1_000_000 ? text(v) : null);
      if (at == null || bt == null || ct == null) { conflicts.push(path); continue; }
      try {
        if (path === '.wiki/manifest.json') changes.push({ path, bytes: Buffer.from(JSON.stringify(mergeJson(JSON.parse(at), JSON.parse(bt), JSON.parse(ct)), null, 2) + '\n') });
        else {
          const result = merge(at.split('\n'), bt.split('\n'), ct.split('\n'));
          if (result.conflict) conflicts.push(path); else changes.push({ path, bytes: Buffer.from(result.result.join('\n')) });
        }
      } catch { conflicts.push(path); }
      }
      for (const change of changes) {
        if (change.bytes) ours.set(change.path, await git.writeBlob({ ...this.args, blob: change.bytes }));
        else ours.delete(change.path);
      }
    }
    const changes: { path: string; bytes?: Buffer }[] = [];
    for (const path of this.changed(original, ours)) changes.push({ path, bytes: await this.blob(ours.get(path)) });
    const commits = versions.map(item => item.oid);
    return { oid, commits, head: await this.head(), files: changes.map(c => c.path), conflicts: [...new Set(conflicts)], token: hash(JSON.stringify([await this.head(), oid, commits, changes.map(c => [c.path, c.bytes ? hash(c.bytes.toString('base64')) : null]), conflicts])), changes };
  }
  async applyRevert(oid: string, token: string) {
    const plan = await this.revertPlan(oid);
    if (!token || token !== plan.token) throw new HistoryError('当前版本已变化，请重新预览');
    if (plan.conflicts.length) throw new HistoryError('撤销与后续改动冲突：' + plan.conflicts.join('、'));
    if (!plan.files.length) throw new HistoryError('这个提交的改动已经被撤销');
    for (const change of plan.changes) {
      if (change.bytes) await this.atomic(change.path, change.bytes);
      else await rm(await this.safePath(change.path));
    }
    const log = (await this.optional('log.md')) ?? '# 整理日志\n';
    await this.atomic('log.md', log.trimEnd() + '\n\n## [' + new Date().toISOString() + '] revert | ' + oid + '\n\n管理页 revert；保留此前历史\n');
    return { reverted: oid, commits: plan.commits, files: plan.files };
  }
  async externalPreview() {
    const head = await this.head(), files = await this.dirty(), current = await this.current(true), before = await this.filesAt(head);
    const details: FileChange[] = [];
    let size = 0;
    for (const path of files.slice(0, 50)) {
      if (path.startsWith('raw/')) { details.push({ path, before: null, after: null, binary: true }); continue; }
      const a = await this.blob(before.get(path)), b = await this.blob(current.get(path));
      const small = (a?.length ?? 0) + (b?.length ?? 0) < 60_000 && size < 100_000;
      const left = small && a ? text(a) : null, right = small && b ? text(b) : null;
      const tooManyLines = (left?.split('\n').length ?? 0) + (right?.split('\n').length ?? 0) > 2000;
      size += (left?.length ?? 0) + (right?.length ?? 0);
      details.push({ path, before: tooManyLines ? null : left ?? null, after: tooManyLines ? null : right ?? null, binary: tooManyLines || !small || !!a && left === null || !!b && right === null });
    }
    return { files, details, token: hash(JSON.stringify([head, [...current].sort()])) };
  }
  async recordExternal(token: string) {
    const preview = await this.externalPreview();
    if (!token || preview.token !== token || !preview.files.length) throw new HistoryError('改动已变化，请重新核对');
    await this.commit({ kind: 'external-unverified' }); this.onCommit?.();
    return { recorded: true };
  }
}
