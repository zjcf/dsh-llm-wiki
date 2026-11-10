import * as git from 'isomorphic-git';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { History, HistoryError } from './history.js';

export interface CredentialStore {
  resolve(ref: string): Promise<{ value: string } | undefined>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}
interface RemoteConfig { url: string; branch: string; tokenRef?: string }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const empty = (): RemoteConfig => ({ url: '', branch: 'main' });
class SyncBusy extends Error {}
const knownErrors = new Set([...Object.keys(git.Errors), 'ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_ARG_TYPE', 'AbortError', 'TimeoutError', 'TypeError']);
function diagnostic(error: unknown) {
  const e = error as { code?: string; name?: string; cause?: { code?: string }; data?: { statusCode?: number } };
  const status = e.data?.statusCode;
  if (typeof status === 'number' && status >= 100 && status <= 599) return 'HTTP ' + status;
  return [...new Set([e.code, e.cause?.code, e.name].filter((v): v is string => !!v && knownErrors.has(v)))].join(' / ') || 'UnknownFailure';
}
export function validateRemote(url: string, branch: string) {
  if (!url) return;
  let parsed: URL; try { parsed = new URL(url); } catch { throw new HistoryError('请输入有效的 HTTP(S) 仓库地址', 400); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname === '/') throw new HistoryError('仓库地址须使用 HTTP(S)，不能包含凭据、查询参数或片段', 400);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || /\.\.|\/\/|\.lock(?:\/|$)/.test(branch) || /[/.]$/.test(branch)) throw new HistoryError('分支名称无效', 400);
}

/** Token 仅在认证回调中读取；拒绝跳转，避免跨地址传递凭据。 */
export const gitHttp: git.HttpClient = {
  async request(request) {
    const body = request.body && new ReadableStream<Uint8Array>({ async start(controller) {
      try { for await (const chunk of request.body!) controller.enqueue(chunk); controller.close(); }
      catch (e) { controller.error(e); }
    } });
    const response = await fetch(request.url, Object.assign({ method: request.method, headers: request.headers, body, redirect: 'manual' as const, signal: request.signal }, body ? { duplex: 'half' } : {}));
    if (response.status >= 300 && response.status < 400) throw new HistoryError('远端发生重定向，请配置最终仓库地址');
    return { url: response.url, method: request.method, statusCode: response.status, statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers), body: (async function* () {
        if (!response.body) return; const reader = response.body.getReader();
        try { while (true) { const part = await reader.read(); if (part.done) break; yield part.value; } } finally { reader.releaseLock(); }
      })() };
  },
};

export class GitSync {
  private config = empty();
  private revision = '';
  private acknowledged = '';
  private syncedAt = '';
  private error = '';
  private blocked = false;
  private requested = false;
  private current?: Promise<void>;
  private active?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private retryDelay = 5_000;
  private pendingCache?: { key: string; count: number; more: boolean };
  private readonly configPath = '.wiki/history-remote.json';
  private readonly syncPath = '.wiki/history-sync.json';
  constructor(private history: History, private credentials?: CredentialStore, private http: git.HttpClient = gitHttp) {}
  async initialize() {
    try { this.config = JSON.parse(await readFile(await this.history.safePath(this.configPath), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new HistoryError('同步配置损坏，请核查'); }
    validateRemote(this.config.url, this.config.branch);
    this.revision = digest(JSON.stringify(this.config));
    try {
      const saved = JSON.parse(await readFile(await this.history.safePath(this.syncPath), 'utf8'));
      if (saved.revision === this.revision) { this.acknowledged = saved.head; this.syncedAt = saved.date; }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new HistoryError('同步记录损坏，请核查'); }
  }
  async status() {
    const head = await this.history.head();
    let pending = 0, cursor: string | undefined = head;
    const key = head + ':' + this.acknowledged + ':' + this.revision;
    if (this.config.url && this.pendingCache?.key !== key) while (cursor && cursor !== this.acknowledged && pending < 1000) {
      pending++; cursor = (await git.readCommit({ fs, gitdir: this.history.gitdir, oid: cursor })).commit.parent[0];
    }
    if (this.pendingCache?.key !== key) this.pendingCache = { key, count: pending, more: !!this.config.url && !!cursor && cursor !== this.acknowledged };
    pending = this.pendingCache.count;
    return { url: this.config.url, branch: this.config.branch, configured: !!this.config.tokenRef && !!(await this.credentials?.resolve(this.config.tokenRef)),
      revision: this.revision, head, pending, pendingMore: this.pendingCache.more, syncedAt: this.syncedAt || null, syncing: !!this.current, error: this.error || null,
      state: !this.config.url ? 'local' : this.error ? 'error' : this.current ? 'syncing' : pending ? 'pending' : 'synced' };
  }
  async save(input: { url: string; branch: string; token?: string; revision: string }) {
    if (input.revision !== this.revision) throw new HistoryError('同步配置已变化，请刷新后重新填写');
    const url = input.url.trim(), branch = input.branch.trim(); validateRemote(url, branch);
    if (typeof input.token !== 'undefined' && (typeof input.token !== 'string' || /[\r\n]/.test(input.token) || input.token.length > 16_384)) throw new HistoryError('Token 格式无效', 400);
    const token = input.token?.trim();
    const sameTarget = url === this.config.url && branch === this.config.branch;
    if (url && (!sameTarget || !this.config.tokenRef) && !token) throw new HistoryError('更换仓库或分支时请重新填写 Token，避免复用到其他目标', 400);
    if (url && !this.credentials) throw new HistoryError('DSH 凭据服务不可用，未保存配置');
    this.active?.abort(); await this.current;
    if (input.revision !== this.revision) throw new HistoryError('同步配置已变化，请刷新后重试');
    const next: RemoteConfig = { url, branch: url ? branch : 'main' };
    const previousRef = this.config.tokenRef;
    if (url) next.tokenRef = token ? 'DSH_LLM_WIKI_GIT_' + randomUUID().replace(/-/g, '').toUpperCase() : previousRef;
    if (token && next.tokenRef) await this.credentials!.set(next.tokenRef, token);
    try { await this.history.atomic(this.configPath, JSON.stringify(next, null, 2) + '\n'); }
    catch { if (token && next.tokenRef) await this.credentials!.unset(next.tokenRef).catch(() => {}); throw new HistoryError('无法保存同步配置，原配置保留', 500); }
    this.config = next; this.revision = digest(JSON.stringify(next));
    this.acknowledged = ''; this.syncedAt = ''; this.error = ''; this.blocked = false;
    if (previousRef && previousRef !== next.tokenRef) await this.credentials?.unset(previousRef).catch(() => {});
    this.wake(); return this.status();
  }
  wake(manual = false) {
    if (this.stopped || !this.config.url || this.blocked && !manual) return;
    if (manual) { this.blocked = false; this.error = ''; }
    this.requested = true;
    if (this.current) return;
    if (this.timer) clearTimeout(this.timer);
    this.current = Promise.resolve().then(async () => {
      while (this.requested && !this.stopped) {
        this.requested = false;
        try { await this.push(); this.error = ''; this.retryDelay = 5_000; }
        catch (e) {
          if (this.stopped) break;
          if (e instanceof SyncBusy) {
            this.requested = false; this.error = '';
            this.timer = setTimeout(() => this.wake(), 200); this.timer.unref?.();
            break;
          }
          const code = (e as { code?: string; data?: { statusCode?: number } }).data?.statusCode;
          if (code === 401 || code === 403) e = new HistoryError('远端认证或授权失败，请更新 Token 并检查分支推送权限');
          this.error = e instanceof HistoryError ? e.message : '同步失败（' + diagnostic(e) + '），请检查网络、Token、仓库及分支权限；本地版本已保留';
          this.blocked = e instanceof HistoryError;
          this.requested = false;
          if (!this.blocked) {
            this.timer = setTimeout(() => this.wake(), this.retryDelay); this.timer.unref?.();
            this.retryDelay = Math.min(300_000, this.retryDelay * 2);
          }
          break;
        }
      }
    }).finally(() => { this.current = undefined; if (this.requested && !this.stopped) this.wake(); });
  }
  private async push() {
    const busy = async () => fs.existsSync(await this.history.safePath('.wiki/write.lock')) || fs.existsSync(await this.history.safePath('.wiki/history-transaction.json'));
    if (await busy()) throw new SyncBusy();
    const initialHead = await this.history.head();
    try { await this.history.assertClean(); }
    catch (error) { if (await busy() || await this.history.head() !== initialHead) throw new SyncBusy(); throw error; }
    const target = { ...this.config }, revision = this.revision, head = await this.history.head();
    if (head === this.acknowledged) return;
    const secret = target.tokenRef && await this.credentials?.resolve(target.tokenRef);
    if (!secret) throw new HistoryError('Token 未配置或不可用，请在版本历史中配置');
    this.active = new AbortController();
    const signal = AbortSignal.any([this.active.signal, AbortSignal.timeout(45_000)]);
    const http: git.HttpClient = { request: request => this.http.request({ ...request, signal }) };
    const auth = () => ({ username: 'oauth2', password: secret.value });
    const refs = await git.listServerRefs({ http, url: target.url, onAuth: auth, forPush: true });
    const remoteHead = refs.find(ref => ref.ref === 'refs/heads/' + target.branch)?.oid;
    if (remoteHead) {
      await git.fetch({ fs, gitdir: this.history.gitdir, http, url: target.url, ref: target.branch, singleBranch: true, tags: false, onAuth: auth });
      if (remoteHead !== head && !await git.isDescendent({ fs, gitdir: this.history.gitdir, oid: head, ancestor: remoteHead })) throw new HistoryError('远端历史与本地不一致，已停止同步；不会自动拉取、重置或 force push');
    }
    // 唯一的推送入口，force 永远为 false；远端再次变化时由服务端拒绝。
    let rejected = '';
    const onMessage = (message: string) => {
      if (/default branch[\s\S]*does not yet exist/i.test(message)) rejected = 'GitLab 尚无默认分支：首次创建 main 需要项目 Maintainer/Owner 权限，请调整 Token 所属账户或项目 Token 的角色后重试';
      else if (/not allowed[\s\S]*protected branch/i.test(message)) rejected = 'GitLab 保护分支拒绝推送，请在分支规则中允许 Token 所属角色推送；不需要开放 force push';
      else if (/not allowed[\s\S]*push[\s\S]*project/i.test(message)) rejected = 'GitLab 拒绝项目写入，请检查 Token 的 write_repository 范围及项目角色';
      else if (/verified email|committer email|commit.*email.*not allowed/i.test(message)) rejected = 'GitLab 提交邮箱规则拒绝插件服务作者，请检查项目的提交规则';
      else if (/signed commits|unsigned commits/i.test(message)) rejected = 'GitLab 要求签名提交，当前插件生成的提交未签名，请核对项目提交规则';
    };
    let result: git.PushResult;
    try { result = await git.push({ fs, gitdir: this.history.gitdir, http, url: target.url, ref: 'main', remoteRef: target.branch, force: false, onAuth: auth, onMessage }); }
    catch (e) {
      if (rejected) throw new HistoryError(rejected);
      const pushError = e as { code?: string; data?: { result?: git.PushResult } };
      if (pushError.code === 'GitPushError') {
        const errors = Object.values(pushError.data?.result?.refs ?? {}).map(v => v.error).join('\n');
        if (/pre-receive hook declined/.test(errors)) throw new HistoryError('GitLab 接收钩子拒绝推送，请检查默认分支权限和项目提交规则；本地历史保留');
      }
      throw e;
    }
    if (!result.ok || result.error) throw new HistoryError('远端拒绝推送，请检查 Token、分支权限或远端历史');
    if (revision !== this.revision) return;
    this.acknowledged = head; this.syncedAt = new Date().toISOString();
    await this.history.atomic(this.syncPath, JSON.stringify({ revision, head, date: this.syncedAt }) + '\n');
    if (await this.history.head() !== head) this.requested = true;
  }
  async dispose() { this.stopped = true; this.active?.abort(); if (this.timer) clearTimeout(this.timer); await this.current; }
}
