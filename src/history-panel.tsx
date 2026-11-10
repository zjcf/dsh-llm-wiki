import * as React from 'react';
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives';
import { diffComm } from 'node-diff3';
import type { FileChange, Version } from './history.js';
import type { Source } from './wiki.js';

type Request = (op: string, params?: Record<string, string>, init?: RequestInit) => Promise<any>;
type SyncStatus = { url: string; branch: string; configured: boolean; revision: string; head: string; pending: number; pendingMore?: boolean; syncedAt: string | null; inspectedAt: string | null; syncing: boolean; error: string | null; dirty: string[]; state: string };
const kinds: Record<string, string> = { baseline: '初始版本', import: '导入来源', extract: '重新抽取', 'review-start': '开始整理', 'source-review': '保存来源页', knowledge: '保存知识页', 'review-complete': '整理完成', 'delete-source': '删除来源', 'delete-page': '删除知识页', revert: '撤销提交', 'external-unverified': '未核实的外部改动', maintenance: '维护登记' };
const stateNames: Record<string, string> = { local: '仅本地保存', pending: '等待同步', syncing: '正在同步', synced: '已同步', error: '同步异常' };
const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败';
const time = (s?: string | null) => s ? new Date(s).toLocaleString('zh-CN') : '暂无';

function ChangeRow({ file, load }: { file: FileChange; load?: (path: string) => Promise<FileChange> }) {
  const [opened, setOpened] = React.useState(false), [loading, setLoading] = React.useState(false), [error, setError] = React.useState('');
  const [content, setContent] = React.useState<FileChange | null>(file.loaded === false ? null : file);
  const parts = React.useMemo(() => opened && content && !content.binary ? diffComm((content.before ?? '').split('\n'), (content.after ?? '').split('\n')) : [], [opened, content]);
  async function expand(event: React.SyntheticEvent<HTMLDetailsElement>) {
    const open = event.currentTarget.open; setOpened(open);
    if (!open || content || !load || loading) return;
    setLoading(true); setError('');
    try { setContent(await load(file.path)); } catch (e) { setError(errorText(e)); } finally { setLoading(false); }
  }
  return <details onToggle={event => { void expand(event); }}>
    <summary>{file.path}{file.change ? ' · ' + file.change : ''}</summary>
    {opened && <>{loading ? <p>正在读取此文件差异…</p> : error ? <p role="alert">{error}</p> : content?.binary ? <p>原件、二进制或大文件：只记录文件变更，正文未在此展开。</p>
      : content && <pre aria-label={'差异 ' + file.path}>{parts.map((part, i) => part.common
        ? <span key={i}>{part.common.join('\n') + '\n'}</span>
        : <React.Fragment key={i}><span className="dsh-wiki-diff-remove">{part.buffer1.map(line => '− ' + line).join('\n') + '\n'}</span><span className="dsh-wiki-diff-add">{part.buffer2.map(line => '+ ' + line).join('\n') + '\n'}</span></React.Fragment>)}</pre>}</>}
  </details>;
}
function Changes({ files, load }: { files: FileChange[]; load?: (path: string) => Promise<FileChange> }) {
  return <div className="dsh-wiki-diffs">{files.slice(0, 50).map(file => <ChangeRow key={file.path} file={file} load={load}/>)}</div>;
}

export function HistoryPanel({ request, sources, onChanged, readOnly }: { readOnly: boolean; request: Request; sources: Source[]; onChanged(): Promise<void> }) {
  const [status, setStatus] = React.useState<SyncStatus | null>(null);
  const [versions, setVersions] = React.useState<Version[]>([]);
  const [selected, setSelected] = React.useState<{ version: Version; files: FileChange[]; total: number; offset: number; limit: number } | null>(null);
  const [cursor, setCursor] = React.useState<string | undefined>();
  const [previousCursors, setPreviousCursors] = React.useState<(string | undefined)[]>([]);
  const [url, setUrl] = React.useState(''), [branch, setBranch] = React.useState('main'), [token, setToken] = React.useState('');
  const [error, setError] = React.useState(''), [notice, setNotice] = React.useState('');
  const [busy, setBusy] = React.useState(false), [settings, setSettings] = React.useState(false), [more, setMore] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState<{ kind: 'revert' | 'external'; oid?: string; files: string[]; conflicts?: string[]; token: string; details?: FileChange[] } | null>(null);
  const [dialogError, setDialogError] = React.useState('');
  const dialog = React.useRef<HTMLDialogElement>(null);
  const selectionRequest = React.useRef(0);
  const refresh = async () => { const [s, list] = await Promise.all([request('history-status'), request('history-list')]); setStatus(s); setVersions(list.items); setMore(list.more); setCursor(undefined); setPreviousCursors([]); return s as SyncStatus; };
  React.useEffect(() => {
    let closed = false;
    void refresh().catch(e => { if (!closed) setError(errorText(e)); });
    const timer = setInterval(() => { void request('history-status').then(s => { if (!closed) setStatus(s); }).catch(e => { if (!closed) setError(errorText(e)); }); }, 5000);
    return () => { closed = true; clearInterval(timer); };
  }, []);
  function openSettings() { if (!status) return; setUrl(status.url); setBranch(status.branch); setToken(''); setSettings(true); setError(''); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!status || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await request('history-settings', {}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, branch, token, revision: status.revision }) });
      setToken(''); setSettings(false); await refresh(); setNotice('同步配置已保存。配置远端后会自动推送本地版本。');
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function action(fn: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function select(oid: string, offset = 0) {
    const attempt = ++selectionRequest.current; setError(''); setSelected(null);
    try { const result = await request('history-diff', { id: oid, offset: String(offset) }); if (selectionRequest.current === attempt) setSelected(result); }
    catch (e) { if (selectionRequest.current === attempt) setError(errorText(e)); }
  }
  async function preview(kind: 'revert' | 'external', oid?: string) {
    setConfirmation(null); setDialogError(''); dialog.current?.showModal();
    try { setConfirmation({ ...await request(kind === 'revert' ? 'history-revert-preview' : 'history-external-preview', oid ? { id: oid } : {}), kind }); }
    catch (e) { setDialogError(errorText(e)); }
  }
  async function confirm() {
    if (!confirmation || busy) return; setBusy(true); setDialogError('');
    try {
      await request(confirmation.kind === 'revert' ? 'history-revert' : 'history-external', { id: confirmation.oid ?? '', token: confirmation.token }, { method: 'POST' });
      dialog.current?.close(); setSelected(null); await refresh(); await onChanged();
      setNotice(confirmation.kind === 'revert' ? '已生成新的 revert 提交，此前历史保持完整。' : '外部改动已登记为未核实版本，可在历史中核对和撤销。');
    } catch (e) { setDialogError(errorText(e)); } finally { setBusy(false); }
  }
  const groups = new Map<string, Version[]>();
  for (const version of versions) {
    const key = version.meta.session ?? version.oid;
    groups.set(key, [...(groups.get(key) ?? []), version]);
  }
  const label = (version: Version) => (kinds[version.meta.kind] ?? version.meta.kind) + (version.meta.subject ? ' · ' + (version.meta.title ?? sources.find(s => s.id === version.meta.subject)?.name ?? version.meta.subject.slice(0, 100)) : '');
  const row = (version: Version) => <button key={version.oid} className="dsh-wiki-history-row" onClick={() => { void select(version.oid); }}><span><strong>{label(version)}</strong><small>{time(version.date)}</small></span><code>{version.oid.slice(0, 10)}</code><span aria-hidden="true">›</span></button>;
  const dirtySettings = !!status && (url !== status.url || branch !== status.branch || !!token);
  return <section aria-label="版本历史">
    {error && <p className="dsh-wiki-message dsh-wiki-error" role="alert">{error}</p>}
    {notice && <p className="dsh-wiki-message" role="status">{notice}</p>}
    <div className="dsh-wiki-message dsh-wiki-history-status">
      <div>{readOnly && <strong>只读实例 · </strong>}<strong>{status ? stateNames[status.state] : '正在读取版本状态…'}</strong>{status && <p>待同步 {status.pending}{status.pendingMore ? '+' : ''} 个版本 · 最近同步 {time(status.syncedAt)}<br/>最近巡检 {time(status.inspectedAt)}</p>}</div>
      <div className="dsh-wiki-actions">{!readOnly && <><Button variant="outline" disabled={busy || !status?.url} onClick={() => { void action(async () => { await request('history-sync', {}, { method: 'POST' }); await refresh(); }); }}>立即同步</Button><Button variant="outline" disabled={busy || !status} onClick={openSettings}>同步设置</Button></>}<Button variant="ghost" disabled={busy} onClick={() => { void action(async () => { await request('history-status', { inspect: '1' }).then(setStatus); await refresh(); }); }}>刷新</Button></div>
    </div>
    {status?.error && <p className="dsh-wiki-message dsh-wiki-error" role="alert">{status.error}</p>}
    {!readOnly && status?.dirty.length ? <div className="dsh-wiki-message dsh-wiki-error"><strong>发现 {status.dirty.length} 个未登记改动，业务写入和同步已暂停。</strong><p>核对后可登记为未核实版本，再通过 revert 撤销。不会自动覆盖或接受这些改动。</p><Button variant="outline" disabled={busy} onClick={() => { void preview('external'); }}>核对外部改动</Button></div> : null}
    {!readOnly && settings && status && <form className="dsh-wiki-sync-form" onSubmit={event => { void save(event); }}>
      <h2>同步设置</h2><p>支持 HTTP(S) Git 仓库。留空仓库地址可关闭远端同步，本地历史继续保留。</p>
      {url.trim().startsWith('http:') && <p role="note">当前使用 HTTP，Token 经网络明文传输，请仅用于你信任的内网。</p>}
      <label>仓库地址<Input aria-label="仓库地址" type="url" placeholder="https://gitlab.example.com/group/wiki.git" value={url} disabled={busy} onChange={event => { setUrl(event.currentTarget.value); setToken(''); }}/></label>
      <label>分支<Input aria-label="同步分支" value={branch} disabled={busy} onChange={event => { setBranch(event.currentTarget.value); setToken(''); }}/></label>
      <label>Token<Input aria-label="Git Token" type="password" autoComplete="new-password" value={token} disabled={busy} onChange={event => setToken(event.currentTarget.value)} placeholder={status.configured && url === status.url && branch === status.branch ? '已配置，留空保留' : '填写有仓库推送权限的 Token'}/></label>
      <p>用户名由插件填写。Token 存入 DSH 凭据存储；更换仓库或分支后需重新填写。目标分支也须允许该 Token 推送。远端应关闭 force push。</p>
      <div className="dsh-wiki-actions"><Button type="button" variant="ghost" disabled={busy} onClick={() => { setSettings(false); setToken(''); }}>取消</Button><Button type="submit" variant="primary" disabled={busy || !dirtySettings || !!url && (!branch || (!status.configured || url !== status.url || branch !== status.branch) && !token)}>{busy ? '保存中…' : '保存同步设置'}</Button></div>
    </form>}
    {selected ? <div className="dsh-wiki-history-detail">
      <Button variant="ghost" onClick={() => { selectionRequest.current++; setSelected(null); }}>‹ 返回版本列表</Button>
      <header className="dsh-wiki-header"><div><h2>{label(selected.version)}</h2><p>{time(selected.version.date)} · {selected.version.oid}</p></div>{!readOnly && <Button variant="outline" disabled={busy || !selected.version.parent} onClick={() => { void preview('revert', selected.version.oid); }}>{selected.version.meta.kind === 'review-complete' ? '撤销本次整理' : '撤销此提交'}</Button>}</header>
      {selected.version.meta.reverts && <p>此版本通过 revert 撤销了 {selected.version.meta.reverts}。</p>}
      {selected.version.meta.session && <p>整理会话：{selected.version.meta.session}</p>}
      {selected.files.length ? <Changes key={selected.version.oid + ':' + selected.offset} files={selected.files} load={async path => (await request('history-file', { id: selected.version.oid, path })).files[0]}/> : <p className="dsh-wiki-empty">此提交标记了整理完成。具体差异在该组记录中；撤销本次整理会反向应用该会话的全部提交。</p>}
      {selected.total > 50 && <nav className="dsh-wiki-actions" aria-label="变更文件分页"><span>共 {selected.total} 个文件 · 当前 {selected.offset + 1}–{Math.min(selected.offset + 50, selected.total)}</span><Button variant="outline" disabled={busy || selected.offset === 0} onClick={() => { void select(selected.version.oid, Math.max(0, selected.offset - 50)); }}>上一页文件</Button><Button variant="outline" disabled={busy || selected.offset + 50 >= selected.total} onClick={() => { void select(selected.version.oid, selected.offset + 50); }}>下一页文件</Button></nav>}
    </div> : <><div className="dsh-wiki-history-list">{[...groups].map(([key, items]) => items.length > 1
      ? <details key={key}><summary>整理记录 · {sources.find(s => s.id === items.find(v => v.meta.subject?.startsWith('s-'))?.meta.subject)?.name ?? key} · 本页 {items.length} 条记录</summary>{items.map(row)}</details>
      : row(items[0]))}</div><nav className="dsh-wiki-actions" aria-label="历史分页">
      <span>每页最多 50 个版本</span>
      <Button variant="outline" disabled={busy || !previousCursors.length} onClick={() => { void action(async () => { const previous = previousCursors.at(-1); const page = await request('history-list', previous ? { before: previous } : {}); setVersions(page.items); setMore(page.more); setCursor(previous); setPreviousCursors(previousCursors.slice(0, -1)); }); }}>较新版本</Button>
      <Button variant="outline" disabled={busy || !more} onClick={() => { void action(async () => { const nextCursor = versions.at(-1)!.oid; const page = await request('history-list', { before: nextCursor }); setVersions(page.items); setMore(page.more); setPreviousCursors([...previousCursors, cursor]); setCursor(nextCursor); }); }}>更早版本</Button>
    </nav></>}

    <dialog ref={dialog} className="dsh-wiki-dialog dsh-wiki-version-dialog" aria-label="确认版本操作" onCancel={event => { if (busy) event.preventDefault(); }}>
      <h2>{confirmation?.kind === 'external' ? '核对外部改动' : '撤销提交'}</h2>
      {confirmation ? <><p>{confirmation.kind === 'external' ? '以下内容将登记为未核实版本，历史副本会保留，并按同步配置推送。' : '将反向应用此提交的改动，生成新的 revert 提交，保留此前历史。后续修改发生冲突时停止。'}</p>
        <p>共 {confirmation.files.length} 个受影响文件，最多预览前 50 个。</p><ul className="dsh-wiki-files">{confirmation.files.slice(0, 50).map(path => <li key={path}>{path}</li>)}</ul>
        {!!confirmation.conflicts?.length && <p role="alert">与后续修改冲突，未执行：{confirmation.conflicts.join('、')}</p>}
        {confirmation.details && <Changes files={confirmation.details}/>}
      </> : !dialogError && <p>正在检查变更和引用…</p>}
      {dialogError && <p className="dsh-wiki-error" role="alert">{dialogError}</p>}
      <div className="dsh-wiki-actions"><Button variant="outline" disabled={busy} onClick={() => dialog.current?.close()}>取消</Button><Button variant="primary" disabled={busy || !confirmation?.files.length || !!confirmation?.conflicts?.length || !!dialogError} onClick={() => { void confirm(); }}>{busy ? '处理中…' : confirmation?.kind === 'external' ? '登记为未核实版本' : '确认生成 revert'}</Button></div>
    </dialog>
  </section>;
}
