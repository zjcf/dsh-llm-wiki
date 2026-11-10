import * as React from 'react';
import { Button, Input, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './client.css';
import type { Page, Source } from './wiki.js';
import type { CatalogList } from './catalog.js';
import { HistoryPanel } from './history-panel.js';

const ID = 'dsh.llm-wiki';
const API = '/api/dsh-llm-wiki';
const states = { pending: '待整理', partial: '部分整理', processed: '已整理' };
const jobs = { queued: '等待自动整理', running: '正在整理', failed: '整理失败', manual: '待人工处理' };
const extracts = { text: '已抽取', partial: '部分抽取', unavailable: '需人工阅读' };
const types = { source: '来源页', topic: '主题', entity: '实体', answer: '问答' };
const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' };

function apiUrl(op: string, params: Record<string, string> = {}) {
  return (op === 'import' ? API + '-upload' : API) + '?' + new URLSearchParams({ op, ...params });
}
function imagePaths(context: string) {
  return { resolve: (path: string) => new URL(apiUrl('image', { id: context, path }), window.location.origin).href };
}
async function api(op: string, params?: Record<string, string>, init?: RequestInit) {
  const response = await fetch(apiUrl(op, params), { ...init, credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? (response.status === 401 ? '请重新登录 DSH' : '请求失败（' + response.status + '）'));
  }
  return response.json();
}
const displayDate = (value: string) => value ? value.slice(0, 10) : '—';
const extension = (name: string) => name.slice(name.lastIndexOf('.')).toLowerCase();
const fileSize = (size?: number) => size === undefined ? '' : size >= 1024 ** 2 ? (size / 1024 ** 2).toFixed(1) + ' MB' : Math.ceil(size / 1024) + ' KB';
const failure = (e: unknown) => e instanceof Error ? e.message : '操作失败';
const maxUpload = 25 * 1024 * 1024;
type Destination = { kind: 'source' | 'page'; id: string; evidence?: string };
type Snapshot = CatalogList & { autoReview: boolean; readOnly: boolean; workspace?: { id: string; path: string } };
type Original = Source & { excerpt: string; originalUrl: string; previewUrl: string; related?: CatalogList };
type Deletion = { id: string; name: string; kind: 'source' | 'page'; affected: string[]; removed?: string[]; rebuilds?: { id: string; title: string; sourceIds: string[] }[]; token: string };

function BookIcon() {
  return <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 1 0-4h13M4 5v13m5-10h6m-6 4h4"/></svg>;
}
function Status({ source }: { source: Source }) {
  return <span className={'dsh-wiki-state ' + source.status}><i aria-hidden="true"/>{source.review_job ? jobs[source.review_job] : states[source.status]}</span>;
}

function OriginalView({ source, evidence }: { source: Original; evidence?: string }) {
  const [content, setContent] = React.useState<string | null>(null);
  const [error, setError] = React.useState('');
  const suffix = extension(source.name);
  const pdf = suffix === '.pdf';
  const image = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(suffix);
  const docx = suffix === '.docx';
  const inlineText = !pdf && !image && !docx && source.extraction !== 'unavailable';
  const page = /^(?:page=)?([1-9]\d*)$/.exec(evidence ?? '')?.[1];
  React.useEffect(() => {
    if (!inlineText) return;
    const abort = new AbortController();
    fetch(source.originalUrl, { signal: abort.signal, credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('无法加载原文');
      return response.text();
    }).then(setContent).catch(e => { if (!abort.signal.aborted) setError(failure(e)); });
    return () => abort.abort();
  }, [source.originalUrl, inlineText]);
  return <section aria-label="原文">
    <h2>原文</h2>
    {evidence && <p className="dsh-wiki-evidence">引用位置 · {page ? '第 ' + page + ' 页' : evidence}</p>}
    <div className="dsh-wiki-original">
      {pdf ? <iframe title={source.name} src={source.originalUrl + (page ? '#page=' + page : '')}/>
        : docx ? <iframe title={source.name} src={source.previewUrl} sandbox="allow-scripts"/>
        : image ? <img src={source.originalUrl} alt={source.name} onError={() => setError('无法加载原图')}/>
        : inlineText ? content === null ? error ? null : <p>正在读取原文…</p>
          : ['.md', '.markdown'].includes(suffix)
            ? <MarkdownText text={content} labels={labels}/>
            : <pre>{content}</pre>
        : <p>这个文件格式暂时无法在页面内预览。</p>}
      {error && <p role="alert">{error}</p>}
    </div>
    {(pdf || docx || error || (!image && !inlineText)) && <p className="dsh-wiki-preview-note">{docx && '在线预览的字体和分页可能与 Word 略有差异。'} <a className="dsh-wiki-link" href={source.originalUrl + '&download=1'}>下载原件</a></p>}
  </section>;
}

function localReference(url: string, pageId: string, snapshot: Snapshot): Destination | undefined {
  try {
    const root = 'https://wiki.invalid/';
    const target = new URL(url, root + pageId);
    if (target.origin !== new URL(root).origin) return;
    const path = decodeURIComponent(target.pathname).slice(1);
    const source = snapshot.sources.find(record => record.original === path);
    if (source) return { kind: 'source', id: source.id, evidence: target.hash.slice(1) || undefined };
    const rawId = /^raw\/(s-[0-9a-f]{16})\//.exec(path)?.[1];
    if (rawId) return { kind: 'source', id: rawId, evidence: target.hash.slice(1) || undefined };
    if (/^wiki\/(sources|topics|entities|answers)\/.+\.md$/.test(path)) return { kind: 'page', id: path };
  } catch { /* Ignore invalid or external links. */ }
}
function references(page: Page, snapshot: Snapshot) {
  const unique = new Map<string, { label: string; target: Destination }>();
  for (const match of page.body.matchAll(/\[([^\]\n]+)\]\(<?([^\s)>]+)>?\)/g)) {
    const target = localReference(match[2], page.id, snapshot);
    if (target) unique.set(target.id + '#' + (target.evidence ?? ''), { label: match[1], target });
  }
  return [...unique.values()];
}

function WikiPanel({ openSession }: { openSession(id: string): void }) {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [tab, setTab] = React.useState<'sources' | 'pages' | 'history'>('sources');
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [jobOffset, setJobOffset] = React.useState(0);
  const [deletionOffset, setDeletionOffset] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [indexProgress, setIndexProgress] = React.useState<{ indexing: boolean; scanned: number; total: number } | null>(null);
  const [stack, setStack] = React.useState<Destination[]>([]);
  const [detail, setDetail] = React.useState<Original | Page | null>(null);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<{ errors: string[]; warnings: string[] } | null>(null);
  const [files, setFiles] = React.useState<File[]>([]);
  const [deletion, setDeletion] = React.useState<Deletion | null>(null);
  const [deletionError, setDeletionError] = React.useState('');
  const scroll = React.useRef<HTMLDivElement>(null);
  const title = React.useRef<HTMLHeadingElement>(null);
  const picker = React.useRef<HTMLInputElement>(null);
  const upload = React.useRef<HTMLDialogElement>(null);
  const deleteDialog = React.useRef<HTMLDialogElement>(null);
  const deletionRequest = React.useRef(0);
  const listTop = React.useRef(0);
  const opener = React.useRef<HTMLElement | null>(null);
  const dest = stack.at(-1);
  const tracked = snapshot?.sources.find(source => dest?.kind === 'source' && source.id === dest.id);
  const tracking = !!snapshot?.counts.active || !!(detail && 'originalUrl' in detail && ['queued', 'running'].includes(detail.review_job ?? ''));
  const listParams = React.useMemo(() => ({ view: tab === 'pages' ? 'pages' : 'sources', offset: String(offset), limit: '50', q: query, filter, jobOffset: String(jobOffset) }), [tab, offset, query, filter, jobOffset]);
  const reload = React.useCallback(() => api('list', listParams).then(setSnapshot), [listParams]);
  React.useEffect(() => {
    if (!loading) { setIndexProgress(null); return; }
    const abort = new AbortController();
    const timer = setInterval(() => { void api('catalog-status', undefined, { signal: abort.signal }).then(setIndexProgress).catch(() => {}); }, 500);
    return () => { clearInterval(timer); abort.abort(); };
  }, [loading]);
  React.useEffect(() => {
    if (tab === 'history') return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void api('list', listParams, { signal: abort.signal }).then(setSnapshot)
        .catch(e => { if (!abort.signal.aborted) setError(failure(e)); })
        .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, query.trim() ? 250 : 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [listParams, tab]);
  React.useEffect(() => {
    if (!tracking || tab === 'history') return;
    const abort = new AbortController(); let fetching = false;
    const timer = setInterval(() => {
      if (fetching) return; fetching = true;
      void api('list', listParams, { signal: abort.signal }).then(setSnapshot).catch(() => {}).finally(() => { fetching = false; });
      if (dest?.kind === 'source') void api('source-status', { id: dest.id }, { signal: abort.signal }).then(status => {
        setDetail(previous => previous && 'originalUrl' in previous && previous.id === status.id ? { ...previous, ...status } : previous);
        if (!status.review_job) void api('related', { id: dest.id }, { signal: abort.signal }).then(related => setDetail(previous => previous && 'originalUrl' in previous && previous.id === dest.id ? { ...previous, related } : previous)).catch(() => {});
      }).catch(() => {});
    }, 2000);
    return () => { clearInterval(timer); abort.abort(); };
  }, [tracking, listParams, dest, tab]);
  React.useEffect(() => {
    setDetail(null);
    if (!dest) return;
    const abort = new AbortController();
    api(dest.kind, { id: dest.id }, { signal: abort.signal })
      .then(result => {
        setDetail(result);
        if (dest.kind === 'source') void api('related', { id: dest.id }, { signal: abort.signal }).then(related => setDetail(previous => previous && 'originalUrl' in previous && previous.id === dest.id ? { ...previous, related } : previous)).catch(e => { if (!abort.signal.aborted) setError(failure(e)); });
      }).catch(e => { if (!abort.signal.aborted) setError(failure(e)); });
    return () => abort.abort();
  }, [dest]);
  React.useEffect(() => {
    if (!tracked || !detail || !('originalUrl' in detail) || detail.id !== tracked.id) return;
    setDetail(previous => previous && 'originalUrl' in previous && previous.id === tracked.id
      ? { ...previous, ...tracked, review_job: tracked.review_job, review_error: tracked.review_error }
      : previous);
  }, [tracked]);
  React.useEffect(() => {
    if (dest && detail) {
      scroll.current?.scrollTo(0, 0);
      title.current?.focus({ preventScroll: true });
    } else if (!dest) {
      scroll.current?.scrollTo(0, listTop.current);
      opener.current?.focus({ preventScroll: true });
    }
  }, [dest, detail]);

  function navigate(target: Destination, trigger?: HTMLElement) {
    if (!dest && trigger) { opener.current = trigger; listTop.current = scroll.current?.scrollTop ?? 0; }
    setError('');
    setDetail(null);
    setStack(previous => [...previous, target]);
  }
  function changeTab(next: 'sources' | 'pages' | 'history') {
    setTab(next); setOffset(0); setQuery(''); setFilter(''); setError('');
  }
  async function importFiles() {
    if (busy || !files.length) return;
    setBusy(true); setError(''); setNotice('');
    const errors: string[] = [];
    let imported = 0;
    let duplicate = 0;
    try {
      for (const file of files) {
        try {
          if (file.size > maxUpload) throw new Error('文件超过 25 MiB');
          const result = await api('import', { name: file.name }, {
            method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
          });
          if (result.duplicate) duplicate++;
          else imported++;
        } catch (e) { errors.push(file.name + '：' + failure(e)); }
      }
      await reload();
      changeTab('sources');
      setNotice('已导入 ' + imported + ' 份材料' + (duplicate ? '，' + duplicate + ' 份重复' : '')
        + (imported && snapshot?.autoReview ? '。可读取的材料已加入自动整理队列。' : ''));
      upload.current?.close();
      if (errors.length) setError(errors.join('\n'));
    } catch (e) { setError(failure(e)); }
    finally { setBusy(false); }
  }
  function check() {
    setBusy(true); setError('');
    void api('check').then(setReport).catch(e => setError(failure(e))).finally(() => setBusy(false));
  }
  function openUpload() {
    setFiles([]);
    if (picker.current) picker.current.value = '';
    upload.current?.showModal();
  }
  async function previewDeletion(id: string, kind: 'source' | 'page' = 'source') {
    setDeletionOffset(0);
    const request = ++deletionRequest.current;
    setDeletion(null);
    setDeletionError('');
    deleteDialog.current?.showModal();
    try {
      const preview = await api(kind === 'page' ? 'delete-page-preview' : 'delete-preview', { id });
      if (request === deletionRequest.current) setDeletion({ ...preview, name: preview.name ?? preview.title, kind });
    } catch (e) {
      if (request === deletionRequest.current) setDeletionError(failure(e));
    }
  }
  async function confirmDeletion() {
    if (!deletion || busy) return;
    setBusy(true);
    setDeletionError('');
    try {
      const result = await api(deletion.kind === 'page' ? 'delete-page' : 'delete-source', { id: deletion.id, token: deletion.token }, { method: 'POST' });
      deleteDialog.current?.close();
      setStack([]);
      setNotice('已删除当前「' + deletion.name + '」，版本历史保留。' + (deletion.kind === 'source'
        ? '关联删除 ' + result.removed.length + ' 个知识页' + (result.rebuilds.length ? '，其中 ' + result.rebuilds.length + ' 个已按剩余来源排队重整。' : '。')
        : result.affected.length ? result.affected.length + ' 份关联文档待复核。' : ''));
      await reload();
    } catch (e) { setDeletionError(failure(e)); }
    finally { setBusy(false); }
  }
  async function retryReview(id: string) {
    setBusy(true);
    setError('');
    try {
      await api('retry-review', { id }, { method: 'POST' });
      await reload();
    } catch (e) { setError(failure(e)); }
    finally { setBusy(false); }
  }
  async function retryRebuild(id: string) {
    setBusy(true); setError('');
    try { await api('retry-rebuild', { id }, { method: 'POST' }); await reload(); }
    catch (e) { setError(failure(e)); }
    finally { setBusy(false); }
  }
  const source = detail && 'originalUrl' in detail && detail.id === dest?.id ? detail : null;
  const page = detail && 'body' in detail && detail.id === dest?.id ? detail : null;
  const foundSources = snapshot?.sources ?? [];
  const foundPages = snapshot?.pages ?? [];
  const pending = snapshot?.counts.pending ?? 0;
  const partial = snapshot?.counts.partial ?? 0;
  async function relatedPage(id: string, offset: number) {
    setBusy(true); setError('');
    try { const related = await api('related', { id, offset: String(offset) }); setDetail(previous => previous && 'originalUrl' in previous && previous.id === id ? { ...previous, related } : previous); }
    catch (e) { setError(failure(e)); } finally { setBusy(false); }
  }
  const deletionReferences = deletion?.affected.filter(path => !deletion.removed?.includes(path)) ?? [];
  const requiresAutoReview = !!deletion?.rebuilds?.length && !snapshot?.autoReview;

  return <div className="dsh-wiki-scroll" ref={scroll}>
    <div className="dsh-wiki">
      {error && <p className="dsh-wiki-message dsh-wiki-error" role="alert">{error}</p>}
      <div hidden={!!dest}>
        <header className="dsh-wiki-header">
          <div><h1>知识库{snapshot?.readOnly ? " · 只读" : ""}</h1><p>{snapshot?.readOnly ? "查询知识、预览原文。内容变更请使用管理实例。" : "投递材料、跟踪整理进度，并从知识页回看原文。"}</p></div>
          <div className="dsh-wiki-actions">
            <Button variant="outline" disabled={busy} onClick={check}>检查知识库</Button>
            {snapshot && !snapshot.readOnly && <Button variant="primary" disabled={busy} onClick={openUpload}>导入文件</Button>}
          </div>
        </header>
        {notice && <p className="dsh-wiki-message" role="status">{notice}</p>}
        {report && <section className="dsh-wiki-message" aria-label="检查结果">
          <strong>{report.errors.length ? '检查发现 ' + report.errors.length + ' 个问题' : '原件与知识页检查通过'}</strong>
          {[...report.errors, ...report.warnings].map((line, i) => <p key={i}>{line}</p>)}
          <Button variant="ghost" onClick={() => setReport(null)}>关闭检查结果</Button>
        </section>}
        <nav className="dsh-wiki-tabs" aria-label="知识库视图">
          <Button variant={tab === 'sources' ? 'outline' : 'ghost'} aria-pressed={tab === 'sources'} onClick={() => changeTab('sources')}>来源材料</Button>
          <Button variant={tab === 'pages' ? 'outline' : 'ghost'} aria-pressed={tab === 'pages'} onClick={() => changeTab('pages')}>知识页</Button>
          <Button variant={tab === 'history' ? 'outline' : 'ghost'} aria-pressed={tab === 'history'} onClick={() => changeTab('history')}>版本历史</Button>
        </nav>
        {tab === 'history' && <HistoryPanel readOnly={snapshot?.readOnly ?? true} request={api} sources={snapshot?.sources ?? []} onChanged={reload}/>}
        {tab !== 'history' && <>
        {!!snapshot?.rebuilds?.length && <section className="dsh-wiki-message" aria-label="删除后的知识重整">
          <strong>按剩余来源重新整理（共 {snapshot.counts.rebuilds} 项，每页 20 项）</strong>
          <p>旧知识已移除，重整完成后重新出现在知识页和查询结果中。</p>
          {snapshot.rebuilds.map(job => <div key={job.id}>
            <p>{job.title} · {job.state === 'failed' ? '重整失败' : job.state === 'running' ? '正在重整' : '等待重整'}{job.error && '：' + job.error}</p>
            {!snapshot.readOnly && job.sessionId && <Button variant="ghost" onClick={() => openSession(job.sessionId!)}>查看重整对话</Button>}
            {!snapshot.readOnly && job.state === 'failed' && <Button variant="outline" disabled={busy || !snapshot.autoReview} onClick={() => { void retryRebuild(job.id); }}>重试重整</Button>}
          </div>)}
          {snapshot.counts.rebuilds > 20 && <div className="dsh-wiki-actions"><Button variant="ghost" disabled={loading || !snapshot.rebuildOffset} onClick={() => setJobOffset(Math.max(0, snapshot.rebuildOffset - 20))}>上一页任务</Button><Button variant="ghost" disabled={loading || snapshot.rebuildOffset + 20 >= snapshot.counts.rebuilds} onClick={() => setJobOffset(snapshot.rebuildOffset + 20)}>下一页任务</Button></div>}
        </section>}
        {tab === 'sources' && (pending > 0 || partial > 0) && <div className="dsh-wiki-message dsh-wiki-work">
          <span>{[pending && pending + ' 份待整理', partial && partial + ' 份部分整理'].filter(Boolean).join('，')}</span>
          <button className="dsh-wiki-link" onClick={() => { setOffset(0); setFilter(pending ? 'pending' : 'partial'); setQuery(''); }}>{pending ? '查看待整理' : '查看部分整理'}</button>
        </div>}
        <div className="dsh-wiki-toolbar">
          <Input type="search" value={query} onChange={(e) => { setOffset(0); setQuery(e.currentTarget.value); }} aria-label="搜索知识库" placeholder={tab === 'sources' ? '搜索文件名或关键词' : '搜索标题或关键词'}/>
          <select aria-label="筛选" value={filter} onChange={e => { setOffset(0); setFilter(e.currentTarget.value); }}>
            <option value="">{tab === 'sources' ? '全部状态' : '全部类型'}</option>
            {Object.entries(tab === 'sources' ? states : types).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        {!snapshot || loading ? <p className="dsh-wiki-empty" role="status">{error ? '知识库加载失败' : indexProgress?.indexing ? '正在建立本地索引' + (indexProgress.total ? '（' + indexProgress.scanned + '/' + indexProgress.total + '）' : '') + '，完成后加载列表。' : '正在读取知识索引…'}</p>
          : tab === 'sources' ? <div className="dsh-wiki-table">
            <div className="dsh-wiki-row dsh-wiki-columns dsh-wiki-source-columns" aria-hidden="true"><span>文件名</span><span>整理状态</span><span className="dsh-wiki-extra">文本抽取</span><span className="dsh-wiki-extra">导入日期</span><span/></div>
            {foundSources.map(item => <div key={item.id} className="dsh-wiki-source-row"><button className="dsh-wiki-row dsh-wiki-entry" onClick={e => navigate({ kind: 'source', id: item.id }, e.currentTarget)}>
              <span className="dsh-wiki-name"><BookIcon/><span><strong>{item.name}</strong><small>{extension(item.name).slice(1).toUpperCase()} {fileSize(item.size)}</small></span></span>
              <Status source={item}/><small className="dsh-wiki-extra">{extracts[item.extraction]}</small><small className="dsh-wiki-extra">{displayDate(item.imported_at)}</small><span aria-hidden="true">›</span>
            </button>{!snapshot.readOnly && <button type="button" className="dsh-wiki-link dsh-wiki-remove" aria-label={'删除 ' + item.name} disabled={busy} onClick={() => { void previewDeletion(item.id); }}>删除</button>}</div>)}
            {!foundSources.length && <p className="dsh-wiki-empty">{snapshot.counts.sources ? '没有匹配的材料' : '还没有来源材料。导入文件即可开始整理。'}</p>}
          </div> : <div className="dsh-wiki-table dsh-wiki-pages">
            <div className="dsh-wiki-row dsh-wiki-columns" aria-hidden="true"><span>标题</span><span>类型</span><span className="dsh-wiki-extra">更新日期</span><span/></div>
            {foundPages.map(item => <button className="dsh-wiki-row dsh-wiki-entry" key={item.id} onClick={e => navigate({ kind: 'page', id: item.id }, e.currentTarget)}>
              <span className="dsh-wiki-name"><BookIcon/><strong>{item.title}</strong></span>
              <small>{item.needsReview ? '待复核' : types[item.type] ?? item.type}</small><small className="dsh-wiki-extra">{displayDate(item.updated)}</small><span aria-hidden="true">›</span>
            </button>)}
            {!foundPages.length && <p className="dsh-wiki-empty">{snapshot.counts.pages ? '没有匹配的知识页' : '材料整理后，知识页会显示在这里。'}</p>}
          </div>}
        {snapshot && <nav className="dsh-wiki-actions" aria-label="知识列表分页">
          <span>共 {snapshot.total} 条 · 每页 50 条 · 第 {Math.floor(snapshot.offset / 50) + 1} 页</span>
          <Button variant="outline" disabled={loading || busy || snapshot.offset === 0} onClick={() => setOffset(Math.max(0, snapshot.offset - 50))}>上一页</Button>
          <Button variant="outline" disabled={loading || busy || snapshot.offset + snapshot.limit >= snapshot.total} onClick={() => setOffset(snapshot.offset + 50)}>下一页</Button>
        </nav>}
        </>}
      </div>

      {dest && <>
        <button className="dsh-wiki-link dsh-wiki-back" onClick={() => { setError(''); setStack([]); }}>‹ 返回列表</button>
        {stack.length > 1 && <button className="dsh-wiki-link dsh-wiki-back" onClick={() => { setError(''); setStack(previous => previous.slice(0, -1)); }}>‹ 返回上一页</button>}
        {source && <>
          <header className="dsh-wiki-header"><div><h1 ref={title} tabIndex={-1}>{source.name}</h1><p>{fileSize(source.size)}</p></div>
            <div className="dsh-wiki-actions">
              {!snapshot?.readOnly && source.review_session_id && <Button variant="outline" onClick={() => openSession(source.review_session_id!)}>查看整理对话</Button>}
              {snapshot?.autoReview && source.text && !['queued', 'running'].includes(source.review_job ?? '')
                && <Button variant="primary" disabled={busy} onClick={() => { void retryReview(source.id); }}>{source.review_job === 'failed' ? '重试自动整理' : source.status === 'pending' ? '开始自动整理' : '重新整理'}</Button>}
              {snapshot && !snapshot.readOnly && <Button variant="outline" disabled={busy} onClick={() => { void previewDeletion(source.id); }}>删除来源</Button>}
            </div>
          </header>
          {source.review_error && <p className="dsh-wiki-message" role="status">{source.review_error}</p>}
          <div className="dsh-wiki-reader">
            <div>
              <OriginalView key={source.id} source={source} evidence={dest.evidence}/>
              {!source.related && <p role="status">正在加载关联知识，原文可先查看。</p>}
              {!!source.related?.total && <section><h2>关联知识页（{source.related.total}）</h2>{source.related.pages.map(page => <p key={page.id}><button className="dsh-wiki-link" onClick={() => navigate({ kind: 'page', id: page.id })}>{types[page.type] ?? page.type} · {page.title}</button></p>)}
                <div className="dsh-wiki-actions"><Button variant="ghost" disabled={busy || !source.related.offset} onClick={() => { void relatedPage(source.id, Math.max(0, source.related!.offset - 50)); }}>上一页关联</Button><Button variant="ghost" disabled={busy || source.related.offset + 50 >= source.related.total} onClick={() => { void relatedPage(source.id, source.related!.offset + 50); }}>下一页关联</Button></div>
              </section>}
            </div>
            <aside className="dsh-wiki-meta"><h2>来源信息</h2><dl>
              <dt>整理状态</dt><dd><Status source={source}/></dd><dt>文本抽取</dt><dd>{extracts[source.extraction]}</dd>
              <dt>导入日期</dt><dd>{displayDate(source.imported_at)}</dd><dt>来源 ID</dt><dd>{source.id}</dd>
            </dl>{source.limitations?.length ? <><h2>整理说明</h2><ul>{source.limitations.map((note, i) => <li key={i}>{note}</li>)}</ul></> : null}</aside>
          </div>
        </>}
        {page && <>
          <header className="dsh-wiki-header"><div><h1 ref={title} tabIndex={-1}>{page.title}</h1><p>知识页 · {types[page.type] ?? page.type}</p></div>
            {snapshot && !snapshot.readOnly && page.type !== 'source' && <Button variant="outline" disabled={busy} onClick={() => { void previewDeletion(page.id, 'page'); }}>删除知识页</Button>}
          </header>
          <div className="dsh-wiki-reader"><div>
            {page.basis === 'conversation' && <p className="dsh-wiki-message">对话记录 · 尚未核对独立来源</p>}
            <MarkdownText text={page.body.replace(/^\s*#\s+[^\n]+\r?\n/, '').replace(/<!-- \/?wiki-source-images -->/g, '')} labels={labels} pathImages={imagePaths(page.id)}/>
            <section><h2>证据与来源</h2>
              {snapshot && references(page, snapshot).map(({ label, target }) => <div className="dsh-wiki-message" key={target.id + '#' + target.evidence}><button className="dsh-wiki-link" onClick={() => navigate(target)}>{target.kind === 'source' ? snapshot.sources.find(item => item.id === target.id)?.name ?? label : label}</button>{target.evidence && <p>{target.evidence.startsWith('page=') ? '第 ' + target.evidence.slice(5) + ' 页' : target.evidence}</p>}</div>)}
            </section>
          </div><aside className="dsh-wiki-meta"><h2>页面信息</h2><dl><dt>类型</dt><dd>{types[page.type] ?? page.type}</dd><dt>更新日期</dt><dd>{displayDate(page.updated)}</dd></dl></aside></div>
        </>}
        {!source && !page && !error && <p>正在加载详情…</p>}
      </>}

      <dialog ref={upload} className="dsh-wiki-dialog" aria-label="导入文件" onCancel={event => { if (busy) event.preventDefault(); }}>
        <h2>导入文件</h2><p>{snapshot?.autoReview ? '导入会保留原件，并用 DSH 默认模型整理可读取的新材料。' : '导入会保留原件。新材料会进入待整理列表。'}</p>
        <div className="dsh-wiki-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!busy) setFiles(Array.from(e.dataTransfer.files)); }}>
          <Button variant="outline" disabled={busy} onClick={() => picker.current?.click()}>选择文件</Button><p>也可以把文件拖到这里</p>
        </div>
        <input hidden ref={picker} type="file" multiple onChange={e => setFiles(Array.from(e.currentTarget.files ?? []))}/>
        {files.length > 0 && <ul className="dsh-wiki-files">{files.map((file, i) => <li key={i}>{file.name}</li>)}</ul>}
        <div className="dsh-wiki-actions">
          <Button variant="ghost" disabled={busy} onClick={() => upload.current?.close()}>取消</Button>
          <Button variant="primary" disabled={busy || !files.length} onClick={() => { void importFiles(); }}>{busy ? '正在导入…' : '确认导入'}</Button>
        </div>
      </dialog>
      <dialog ref={deleteDialog} className="dsh-wiki-dialog" aria-label="删除当前内容"
        onClose={() => { deletionRequest.current++; }}
        onCancel={event => { if (busy) event.preventDefault(); }}>
        <h2>删除当前{deletion?.kind === 'page' ? '知识页' : '来源'}</h2>
        {deletion ? <>
          <p>{deletion.kind === 'page' ? '将删除当前知识页「' + deletion.name + '」，保留来源原件。' : '将删除当前库中「' + deletion.name + '」的原件、抽取内容、专属来源页及关联知识。仅依赖该来源的知识直接删除；多来源知识按剩余原件重新整理，完成前不用于查询。'}</p>
          <p>历史版本仍保留副本，可通过管理页 revert 恢复；此次操作不会清除历史或远端副本。</p>
          {deletion.kind === 'source' && !!deletion.removed?.length && <>
            <p>关联删除 {deletion.removed.length} 个知识页（每页预览 50 个）：</p>
            <ul className="dsh-wiki-files">{deletion.removed.slice(deletionOffset, deletionOffset + 50).map(path => <li key={path}>{snapshot?.pages.find(page => page.id === path)?.title ?? path}{deletion.rebuilds?.some(job => job.id === path) && '（按剩余来源重整）'}</li>)}</ul>
          </>}
          {requiresAutoReview && <p role="alert">存在多来源知识页，请先在插件配置中启用自动整理再删除。</p>}
          {deletionReferences.length > 0 && <>
            <p>{deletion.kind === 'page' ? '将移除以下文档中的相关引用，并标为待复核：' : '同步清理以下文档中的失效引用：'}</p>
            <ul className="dsh-wiki-files">{deletionReferences.slice(deletionOffset, deletionOffset + 50).map(path => <li key={path}>{snapshot?.pages.find(page => page.id === path)?.title ?? path}</li>)}</ul>
          </>}
          {Math.max(deletion.removed?.length ?? 0, deletionReferences.length) > 50 && <div className="dsh-wiki-actions"><Button variant="ghost" disabled={!deletionOffset || busy} onClick={() => setDeletionOffset(Math.max(0, deletionOffset - 50))}>上一页影响</Button><Button variant="ghost" disabled={busy || deletionOffset + 50 >= Math.max(deletion.removed?.length ?? 0, deletionReferences.length)} onClick={() => setDeletionOffset(deletionOffset + 50)}>下一页影响</Button></div>}
        </> : !deletionError && <p>正在检查关联引用…</p>}
        {deletionError && <p role="alert">{deletionError}</p>}
        <div className="dsh-wiki-actions">
          <Button variant="outline" disabled={busy} onClick={() => deleteDialog.current?.close()}>取消</Button>
          <Button variant="primary" disabled={busy || !deletion || !!deletionError || requiresAutoReview} onClick={() => { void confirmDeletion(); }}>确认删除</Button>
        </div>
      </dialog>
    </div>
  </div>;
}

export const inject = ['slots', 'layout', 'uiWorkspace'];
export function apply(ctx: any) {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: ID, order: 10, label: () => '知识库',
  }, BookIcon));
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: ID }, () => <WikiPanel openSession={id => ctx.uiWorkspace.openSession(id)}/>));
}
