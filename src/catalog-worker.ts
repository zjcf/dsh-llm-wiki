import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, chmodSync, renameSync } from 'node:fs';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { parse as yaml } from 'yaml';
import { withoutGallery } from './reading.js';
import { reviewNotice, referenceTargets } from './references.js';

const root: string = workerData.root;
function safe(rel: string) {
  if (rel.includes('\\') || rel.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('索引路径无效');
  let file = root;
  for (const part of rel.split('/')) {
    file = join(file, part);
    try { if (lstatSync(file).isSymbolicLink()) throw new Error('索引路径不能包含符号链接'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return file;
}
const cacheDir: string = workerData.cacheDir ?? safe('.wiki');
mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
function cachePath(name: string) {
  const file = join(cacheDir, name);
  try { if (lstatSync(file).isSymbolicLink()) throw new Error('索引缓存不能包含符号链接'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return file;
}
const schema = `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,name TEXT,status TEXT,job TEXT,json TEXT);
CREATE TABLE IF NOT EXISTS rebuilds(id TEXT PRIMARY KEY,state TEXT,json TEXT);
CREATE TABLE IF NOT EXISTS docs(id TEXT PRIMARY KEY,kind TEXT,type TEXT,title TEXT,updated TEXT,source_id TEXT,signature TEXT,json TEXT,body TEXT,alias TEXT,line_offset INTEGER,folded TEXT);
CREATE INDEX IF NOT EXISTS docs_listing ON docs(kind,updated DESC,id);
CREATE INDEX IF NOT EXISTS docs_sources ON docs(source_id,kind);
CREATE INDEX IF NOT EXISTS sources_listing ON sources(status,id);
CREATE TABLE IF NOT EXISTS links(page_id TEXT,source_id TEXT,PRIMARY KEY(page_id,source_id));
CREATE INDEX IF NOT EXISTS links_source ON links(source_id,page_id);
CREATE TABLE IF NOT EXISTS refs(page_id TEXT,target TEXT,PRIMARY KEY(page_id,target));
CREATE INDEX IF NOT EXISTS refs_target ON refs(target,page_id);
CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(id UNINDEXED,folded,tokenize='trigram');`;
function openDatabase() {
  const file = cachePath('catalog.sqlite');
  for (const suffix of ['-wal', '-shm']) cachePath('catalog.sqlite' + suffix);
  const connection = new DatabaseSync(file);
  try { chmodSync(file, 0o600); connection.exec(schema); return connection; }
  catch (error) { connection.close(); throw error; }
}
let db: DatabaseSync;
try { db = openDatabase(); }
catch (error) {
  if (!/not a database|database disk image is malformed/i.test(String(error))) throw error;
  // 仅隔离可重建的派生缓存；来源、知识文件和 Git 历史不参与此恢复。
  const suffix = '.corrupt-' + Date.now();
  for (const name of ['catalog.sqlite', 'catalog.sqlite-wal', 'catalog.sqlite-shm']) {
    const file = cachePath(name); if (existsSync(file)) renameSync(file, file + suffix);
  }
  db = openDatabase();
}
const getMeta = (key: string) => String(db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? '');
const setMeta = (key: string, value: string) => db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key, value);
if (getMeta('schema') !== '3') { db.exec('DELETE FROM docs; DELETE FROM terms; DELETE FROM links; DELETE FROM refs; DELETE FROM meta;'); setMeta('schema', '3'); }
const stamp = (rel: string) => { const stat = lstatSync(safe(rel)); return [stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'); };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
let revision = getMeta('revision');
let scans = 0, reads = 0;
const progress = (indexing: boolean, scanned = 0, total = 0) => parentPort!.postMessage({ progress: { indexing, scanned, total } });
function document(id: string, raw: string, kind: string, source?: any, alias = '') {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  const parsed = front ? yaml(front[1], { maxAliasCount: 0 }) : {};
  const meta = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const rawBody = front ? raw.slice(front[0].length) : raw, body = withoutGallery(rawBody);
  const sourceId = kind === 'source' ? source.id : typeof meta.source_id === 'string' ? meta.source_id : undefined;
  const title = String(meta.title ?? source?.name ?? posix.basename(id, '.md'));
  const page = { id, title, type: String(meta.type ?? id.split('/')[1]), updated: String(meta.updated ?? ''), needsReview: body.includes(reviewNotice), revision: sha(raw),
    sourceIds: Array.isArray(meta.source_ids) ? meta.source_ids.map(String) : [], ...(typeof meta.basis === 'string' ? { basis: meta.basis } : {}) };
  return { id, kind, type: page.type, title, updated: page.updated, source_id: sourceId ?? '', json: JSON.stringify(page), body, alias,
    line_offset: raw.slice(0, raw.length - rawBody.length).split('\n').length, folded: (title + '\n' + body + '\n' + alias).toLowerCase() };
}
function walk(folder: string, result: string[]) {
  if (!existsSync(safe(folder))) return;
  for (const entry of readdirSync(safe(folder), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = folder + '/' + entry.name;
    if (entry.isSymbolicLink()) throw new Error('知识页包含符号链接，请先检查知识库');
    if (entry.isDirectory()) walk(rel, result); else if (entry.isFile() && entry.name.endsWith('.md')) result.push(rel);
  }
}
async function refresh(force = false, allowTransaction = false, metadataOnly = false) {
  // 不把尚未提交/可能回滚的业务事务写入查询索引。
  if (!allowTransaction && existsSync(safe('.wiki/history-transaction.json'))) {
    if (revision || getMeta('sourceRevision')) return;
    throw new Error('知识库正在保存，请稍后重试');
  }
  const head = existsSync(safe('.wiki/history-state.json')) ? JSON.parse(readFileSync(safe('.wiki/history-state.json'), 'utf8')).head : 'unversioned';
  const nextRevision = head + ':' + stamp('.wiki/manifest.json');
  const docsRevision = head === 'unversioned' ? nextRevision : head;
  const buildDocs = !metadataOnly && (force || revision !== docsRevision);
  if (!buildDocs && !force && getMeta('sourceRevision') === nextRevision) return;
  progress(true);
  const manifest = JSON.parse(readFileSync(safe('.wiki/manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !manifest.sources || Array.isArray(manifest.sources)) throw new Error('来源登记格式不受支持');
  const sources: any[] = Object.values(manifest.sources);
  const sourceForPath = new Map(sources.flatMap(s => [[s.text, s], [s.summary ?? 'wiki/sources/' + s.id + '.md', s]]));
  const sourceTargets = new Map(sources.flatMap(s => [s.original, s.text, s.summary ?? 'wiki/sources/' + s.id + '.md'].filter(Boolean).map(path => [path, s.id])));
  const existing = new Map(buildDocs ? db.prepare('SELECT rowid,id,signature,alias FROM docs').all().map(row => [String(row.id), row]) : []);
  const paths: string[] = [];
  if (buildDocs || getMeta('pageCountHead') !== docsRevision) for (const folder of ['sources', 'topics', 'entities', 'answers']) walk('wiki/' + folder, paths);
  const pageCount = paths.length;
  const extracted: string[] = []; if (buildDocs) walk('extracted', extracted);
  paths.push(...extracted.filter(path => path.endsWith('-reader.md')));
  if (buildDocs) for (const path of ['index.md', 'README.md']) if (existsSync(safe(path))) paths.push(path);
  if (buildDocs) for (const source of sources) if (source.text && existsSync(safe(source.text))) paths.push(source.text);
  const seen = new Set(paths); const aliases = new Map<string, string>();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM rebuilds;');
    const previousSources = new Map(db.prepare('SELECT id,json FROM sources').all().map(row => [String(row.id), row.json]));
    const insertSource = db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?)');
    for (const s of sources) {
      const { images, limitations, review_job_session_id, ...compact } = s;
      if (review_job_session_id) compact.review_session_id = review_job_session_id;
      const json = JSON.stringify(compact);
      if (previousSources.get(s.id) !== json) insertSource.run(s.id, s.name, s.status, s.review_job ?? '', json);
      previousSources.delete(s.id);
    }
    for (const id of previousSources.keys()) db.prepare('DELETE FROM sources WHERE id=?').run(id);
    const insertJob = db.prepare('INSERT INTO rebuilds VALUES(?,?,?)');
    for (const job of Object.values(manifest.rebuilds ?? {}) as any[]) insertJob.run(job.id, job.state ?? 'failed', JSON.stringify({ ...job, state: job.state ?? 'failed', sessionId: job.activeSessionId ?? job.sessionId }));
    setMeta('sourceRevision', nextRevision);
    if (buildDocs || getMeta('pageCountHead') !== docsRevision) { setMeta('pageCount', String(pageCount)); setMeta('pageCountHead', docsRevision); }
    if (!buildDocs) { db.exec('COMMIT'); progress(false); return; }
    let processed = 0; const tick = () => { processed++; if (processed % 50 === 0) progress(true, processed, paths.length); };
    progress(true, 0, paths.length);
    const upsert = db.prepare('INSERT OR REPLACE INTO docs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    const docRow = db.prepare('SELECT rowid FROM docs WHERE id=?');
    const removeTerms = db.prepare('DELETE FROM terms WHERE rowid=?'), insertTerms = db.prepare('INSERT INTO terms(rowid,id,folded) VALUES(?,?,?)');
    const removeLinks = db.prepare('DELETE FROM links WHERE page_id=?'), insertLink = db.prepare('INSERT OR IGNORE INTO links VALUES(?,?)');
    const removeRefs = db.prepare('DELETE FROM refs WHERE page_id=?'), insertRef = db.prepare('INSERT OR IGNORE INTO refs VALUES(?,?)');
    function save(id: string, raw: string, kind: string, source: any, alias: string, signature: string) {
      const doc = document(id, raw, kind, source, alias);
      const oldRow = docRow.get(id); if (oldRow) removeTerms.run(oldRow.rowid!);
      upsert.run(id, kind, doc.type, doc.title, doc.updated, doc.source_id, signature, doc.json, kind === 'aux' ? '' : doc.body, doc.alias, doc.line_offset, kind === 'aux' ? '' : doc.folded);
      if (kind !== 'aux') insertTerms.run(docRow.get(id)!.rowid!, id, doc.folded); removeLinks.run(id); removeRefs.run(id);
      const page = JSON.parse(doc.json);
      const refs = referenceTargets(id, raw);
      for (const target of refs) insertRef.run(id, target);
      for (const sourceId of [...page.sourceIds, ...(doc.source_id ? [doc.source_id] : []), ...raw.match(/s-[a-f0-9]{16}/g) ?? [], ...refs.map(target => sourceTargets.get(target)).filter(Boolean)]) if (/^s-[a-f0-9]{16}$/.test(sourceId)) insertLink.run(id, sourceId);
    }
    // 原文正文只索引一份，不重复纳入 reader；原始标题可用于检索 AI 改写的来源页。
    for (const source of sources) {
      if (!source.text || !seen.has(source.text)) { aliases.set(source.id, source.name); continue; }
      tick(); scans++; const signature = stamp(source.text), previous = existing.get(source.text);
      let alias: string;
      if (previous?.signature === signature && String(previous.alias).startsWith(source.name + '\n')) alias = String(previous.alias);
      else { reads++; const raw = readFileSync(safe(source.text), 'utf8'); alias = source.name + '\n' + raw.split('\n').filter(line => /^#{1,6}\s/.test(line)).slice(0, 60).join('\n'); save(source.text, raw, 'source', source, alias, signature); }
      aliases.set(source.id, alias);
    }
    for (const id of paths) {
      if (sourceForPath.get(id)?.text === id) continue;
      tick(); scans++; const signature = stamp(id), source = sourceForPath.get(id), alias = source ? aliases.get(source.id) ?? source.name : '';
      const previous = existing.get(id);
      if (previous?.signature === signature && previous.alias === alias) continue;
      reads++; save(id, readFileSync(safe(id), 'utf8'), id.startsWith('wiki/') ? 'page' : 'aux', source, alias, signature);
    }
    for (const [id, row] of existing) if (!seen.has(id)) { removeTerms.run(row.rowid!); db.prepare('DELETE FROM docs WHERE id=?').run(id); removeLinks.run(id); removeRefs.run(id); }
    setMeta('revision', docsRevision); db.exec('COMMIT'); revision = docsRevision; progress(false, processed, paths.length);
  } catch (e) { db.exec('ROLLBACK'); progress(false); throw e; }
}
const bounded = (value: unknown, fallback: number, max: number) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(0, Math.floor(Number(value)))) : fallback;
const termsOf = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean);
function matches(query: string, prefix = '') {
  if (query.length > 400) throw new Error('搜索词最多 400 字');
  const terms = termsOf(query), values: string[] = [], clauses: string[] = [];
  const indexed = terms.filter(term => [...term].length >= 3);
  if (indexed.length) { clauses.push(prefix + 'id IN (SELECT id FROM terms WHERE terms MATCH ?)'); values.push(indexed.map(term => '"' + term.replace(/"/g, '""') + '"').join(' AND ')); }
  for (const term of terms) { clauses.push('instr(' + prefix + 'folded,?)>0'); values.push(term); }
  return { where: clauses.length ? clauses.join(' AND ') : '1', values, terms };
}
function counts() {
  return { sources: Number(db.prepare('SELECT count(*) n FROM sources').get()!.n), pages: Number(getMeta('pageCount') || db.prepare("SELECT count(*) n FROM docs WHERE kind='page'").get()!.n),
    pending: Number(db.prepare("SELECT count(*) n FROM sources WHERE status='pending'").get()!.n), partial: Number(db.prepare("SELECT count(*) n FROM sources WHERE status='partial'").get()!.n),
    active: Number(db.prepare("SELECT count(*) n FROM sources WHERE job IN ('queued','running')").get()!.n) + Number(db.prepare("SELECT count(*) n FROM rebuilds WHERE state IN ('queued','running')").get()!.n),
    rebuilds: Number(db.prepare('SELECT count(*) n FROM rebuilds').get()!.n) };
}
function list(options: any) {
  const limit = Math.max(1, bounded(options.limit, 50, 100)), requestedOffset = bounded(options.offset, 0, Number.MAX_SAFE_INTEGER), query = String(options.query ?? ''), filter = String(options.filter ?? '');
  const pages = options.view === 'pages', values: string[] = [], clauses: string[] = [];
  if (pages) {
    clauses.push("kind='page'");
    if (query) { const match = matches(query); clauses.push(match.where); values.push(...match.values); }
    if (filter) { clauses.push('type=?'); values.push(filter); }
    if (options.sourceId) { clauses.push('id IN (SELECT page_id FROM links WHERE source_id=?)'); values.push(options.sourceId); }
  } else {
    if (filter) { clauses.push('status=?'); values.push(filter); }
    if (query) {
      const match = matches(query), name = termsOf(query).map(() => 'instr(lower(name),?)>0').join(' AND ');
      clauses.push('((' + name + ') OR id IN (SELECT source_id FROM docs WHERE ' + match.where + '))'); values.push(...termsOf(query), ...match.values);
    }
  }
  const table = pages ? 'docs' : 'sources', where = clauses.length ? clauses.join(' AND ') : '1';
  const total = Number(db.prepare('SELECT count(*) n FROM ' + table + ' WHERE ' + where).get(...values)!.n);
  const offset = Math.min(requestedOffset, Math.max(0, Math.floor((total - 1) / limit) * limit));
  const rows = db.prepare('SELECT json FROM ' + table + ' WHERE ' + where + (pages ? ' ORDER BY updated DESC,id' : " ORDER BY json_extract(json,'$.imported_at') DESC,id") + ' LIMIT ? OFFSET ?').all(...values, limit, offset);
  const items = rows.map(row => JSON.parse(String(row.json)));
  const totals = counts(), rebuildOffset = Math.min(bounded(options.jobOffset, 0, Number.MAX_SAFE_INTEGER), Math.max(0, Math.floor((totals.rebuilds - 1) / 20) * 20));
  return { sources: pages ? [] : items, pages: pages ? items : [], total, offset, limit, revision: pages ? revision : getMeta('sourceRevision'), counts: totals, rebuildOffset,
    rebuilds: db.prepare('SELECT json FROM rebuilds ORDER BY id LIMIT 20 OFFSET ?').all(rebuildOffset).map(row => JSON.parse(String(row.json))) };
}
function search(options: any) {
  const query = String(options.query ?? ''), scope = options.scope ?? 'wiki', match = matches(query);
  if (!match.terms.length) throw new Error('请输入有效的搜索词');
  const overlay: [string, string][] = options.overlay ?? [];
  // 草稿仅在本次查询的临时事务中覆盖，其他对话和持久索引不可见。
  db.exec('SAVEPOINT draft');
  try {
    for (const [id, raw] of overlay) {
      const source = /^wiki\/sources\/(s-[a-f0-9]{16})\.md$/.exec(id)?.[1], row = source ? db.prepare('SELECT json FROM sources WHERE id=?').get(source) : undefined;
      const alias = source ? String(db.prepare("SELECT alias FROM docs WHERE source_id=? AND kind='source' LIMIT 1").get(source)?.alias ?? '') : '';
      const doc = document(id, raw, 'page', row ? JSON.parse(String(row.json)) : undefined, alias);
      const old = db.prepare('SELECT rowid FROM docs WHERE id=?').get(id); if (old) db.prepare('DELETE FROM terms WHERE rowid=?').run(old.rowid!);
      db.prepare('INSERT OR REPLACE INTO docs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'page', doc.type, doc.title, doc.updated, doc.source_id, '', doc.json, doc.body, doc.alias, doc.line_offset, doc.folded);
      const next = db.prepare('SELECT rowid FROM docs WHERE id=?').get(id)!;
      db.prepare('INSERT INTO terms(rowid,id,folded) VALUES(?,?,?)').run(next.rowid!, id, doc.folded);
    }
    const kind = scope === 'sources' ? "kind='source'" : scope === 'wiki' ? "kind='page'" : "kind IN ('page','source')";
    const score = match.terms.map(() => '(CASE WHEN instr(lower(title),?)>0 THEN 10 ELSE 0 END)').join('+');
    const sql = 'WITH ranked AS (SELECT *,(' + score + ') score FROM docs WHERE ' + kind + ' AND ' + match.where + '), dedup AS (SELECT *,row_number() OVER(PARTITION BY coalesce(nullif(source_id,\'\'),id) ORDER BY (kind=\'source\'),score DESC,id) rn FROM ranked) SELECT * FROM dedup WHERE rn=1';
    const values = [...match.terms, ...match.values];
    const limit = Math.max(1, bounded(options.limit, 5, 100)), offset = bounded(options.offset, 0, Number.MAX_SAFE_INTEGER);
    const total = Number(db.prepare('SELECT count(*) n FROM (' + sql + ')').get(...values)!.n);
    const rows = db.prepare(sql + ' ORDER BY (kind=\'source\'),score DESC,id LIMIT ? OFFSET ?').all(...values, limit, offset);
    const items = rows.map(row => {
      const body = String(row.body), lines = body.split(/\r?\n/), count = (line: string) => match.terms.filter(term => line.toLowerCase().includes(term)).length;
      let number = 0; for (let i = 1; i < lines.length; i++) if (count(lines[i]) > count(lines[number])) number = i;
      const positions = match.terms.map(term => lines[number].toLowerCase().indexOf(term)).filter(i => i >= 0), start = Math.max(0, Math.min(...positions, lines[number].length) - 60);
      const source = String(row.source_id), alias = String(row.alias);
      const heading = alias.split('\n').filter(line => /^#{1,6}\s/.test(line)).sort((a,b) => count(b) - count(a))[0]?.replace(/^#+\s*/, '') ?? alias.split('\n')[0];
      return { id: row.id, title: row.title, line: Number(row.line_offset) + number, snippet: lines.slice(number, number + 8).join('\n').slice(start, start + 400).trim(), score: Number(row.score),
        readTool: 'wiki_read_page', readArgs: { id: row.id }, ...(source ? { sourceId: source, sourceHeading: heading } : {}), ...(body.includes(reviewNotice) ? { needsReview: true } : {}) };
    });
    return { items, total, offset, limit };
  } finally { db.exec('ROLLBACK TO draft; RELEASE draft'); }
}
let queue = Promise.resolve();
function deletion(options: any) {
  const affected = db.prepare(`WITH RECURSIVE affected(id) AS (
    SELECT page_id FROM links WHERE source_id=?
    UNION SELECT refs.page_id FROM refs JOIN affected ON refs.target=affected.id WHERE refs.page_id LIKE 'wiki/%' AND refs.page_id NOT LIKE 'wiki/sources/%'
  ) SELECT docs.id,docs.json FROM docs JOIN affected ON docs.id=affected.id WHERE docs.kind='page' AND docs.id NOT LIKE 'wiki/sources/%'`).all(options.id);
  const dependencies = db.prepare(`WITH RECURSIVE dependencies(id) AS (
    SELECT ? UNION SELECT refs.target FROM refs JOIN dependencies ON refs.page_id=dependencies.id JOIN docs ON docs.id=refs.target
    WHERE dependencies.id NOT LIKE 'wiki/sources/%' AND docs.kind='page'
  ) SELECT DISTINCT links.source_id FROM links JOIN dependencies ON links.page_id=dependencies.id JOIN sources ON sources.id=links.source_id WHERE links.source_id<>? ORDER BY links.source_id`);
  const removed = affected.map(row => ({ ...JSON.parse(String(row.json)), sourceIds: dependencies.all(row.id!, options.id).map(row => String(row.source_id)) }));
  const targets = [...options.targets, ...removed.map(page => page.id)];
  db.exec('CREATE TEMP TABLE IF NOT EXISTS delete_targets(target TEXT PRIMARY KEY); DELETE FROM delete_targets;');
  const addTarget = db.prepare('INSERT OR IGNORE INTO delete_targets VALUES(?)'); for (const target of targets) addTarget.run(target);
  const references = db.prepare("SELECT DISTINCT page_id FROM refs JOIN docs ON refs.page_id=docs.id WHERE docs.kind<>'source' AND (target IN (SELECT target FROM delete_targets) OR " + options.prefixes.map(() => 'substr(target,1,length(?))=?').join(' OR ') + ')')
    .all(...options.prefixes.flatMap((prefix: string) => [prefix, prefix])).map(row => String(row.page_id));
  return { removed, references, revision };
}
/** 结构体检：基于已索引的引用图，不在主线程扫描正文。目录链接不计入孤立页判断。 */
function lint(options: any) {
  const limit = bounded(options.limit, 50, 200);
  const slice = <T>(rows: T[]) => ({ total: rows.length, items: rows.slice(0, limit) });
  const knowledge = "docs.kind='page' AND docs.id NOT LIKE 'wiki/sources/%'";
  const orphans = db.prepare(`SELECT id,title,type FROM docs WHERE ${knowledge} AND NOT EXISTS (SELECT 1 FROM refs JOIN docs AS other ON other.id=refs.page_id WHERE refs.target=docs.id AND refs.page_id<>docs.id AND other.kind='page') ORDER BY id`).all();
  const unindexed = db.prepare("SELECT id,title,type FROM docs WHERE kind='page' AND NOT EXISTS (SELECT 1 FROM refs WHERE refs.page_id='index.md' AND refs.target=docs.id) ORDER BY id").all();
  const broken = db.prepare("SELECT refs.page_id AS page,refs.target AS target FROM refs JOIN docs ON docs.id=refs.page_id WHERE docs.kind='page' AND refs.target NOT IN (SELECT id FROM docs) ORDER BY refs.page_id,refs.target").all()
    .filter(row => { try { return !existsSync(safe(String(row.target))); } catch { return true; } });
  const unreviewed = db.prepare("SELECT id,name,status FROM sources WHERE status<>'processed' ORDER BY id").all();
  return { orphans: slice(orphans), unindexed: slice(unindexed), brokenLinks: slice(broken), unreviewed: slice(unreviewed) };
}
parentPort!.on('message', message => {
  queue = queue.then(async () => {
    try {
      if (message.op !== 'metrics') await refresh(message.op === 'refresh', message.op === 'deletion' && message.options.allowTransaction, message.op === 'list' && message.options.view !== 'pages' && !message.options.query);
      const value = message.op === 'search' ? search(message.options) : message.op === 'list' ? list(message.options) : message.op === 'deletion' ? deletion(message.options) : message.op === 'lint' ? lint(message.options) : message.op === 'metrics' ? { scans, reads } : undefined;
      parentPort!.postMessage({ id: message.id, value });
    } catch (error) { progress(false); parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : '知识索引失败' }); }
  });
});
