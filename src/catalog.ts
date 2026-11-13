import { Worker } from 'node:worker_threads';
import type { Page, Source, Rebuild } from './wiki.js';

export type Slice<T> = { items: T[]; total: number; offset: number; limit: number };
export type CatalogOptions = { view?: 'sources' | 'pages'; offset?: number; limit?: number; query?: string; filter?: string; sourceId?: string; jobOffset?: number };
export type CatalogList = { sources: Source[]; pages: Omit<Page, 'body'>[]; rebuilds: Rebuild[]; total: number; offset: number; limit: number;
  counts: { sources: number; pages: number; pending: number; partial: number; active: number; rebuilds: number }; revision: string; rebuildOffset: number };
export type SearchHit = { id: string; title: string; line: number; snippet: string; score: number; readTool: string; readArgs: { id: string }; sourceId?: string; sourceHeading?: string; needsReview?: boolean };

/** SQLite 与全库索引均在独立 Worker 中执行；只把一页元数据/命中项传回宿主。 */
export class Catalog {
  progress = { indexing: false, scanned: 0, total: 0 };
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  constructor(private root: string, private cacheDir?: string) {}
  private request<T>(op: string, options: unknown = {}): Promise<T> {
    if (!this.worker) {
      const spawn = (execArgv: string[]) => new Worker(new URL('./catalog-worker.js', import.meta.url), { workerData: { root: this.root, cacheDir: this.cacheDir }, execArgv });
      let created: Worker;
      try { created = spawn(process.execArgv.filter(arg => !arg.startsWith('--input-type'))); }
      catch (error) {
        // Node 26 测试运行器等场景会在 execArgv 中放入 Worker 不接受的进程级参数；索引 Worker 不依赖这些参数。
        if ((error as NodeJS.ErrnoException).code !== 'ERR_WORKER_INVALID_EXEC_ARGV') throw error;
        created = spawn([]);
      }
      const worker = this.worker = created;
      worker.on('message', ({ id, value, error, progress }) => {
        if (progress) { this.progress = progress; return; }
        const pending = this.pending.get(id); this.pending.delete(id);
        if (error) pending?.reject(new Error(error)); else pending?.resolve(value);
        if (!this.pending.size) worker.unref();
      });
      worker.on('error', error => { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.worker = undefined; });
      worker.on('exit', code => { if (this.worker === worker) this.worker = undefined; if (code) { for (const p of this.pending.values()) p.reject(new Error('知识索引进程退出，请重试')); this.pending.clear(); } });
    }
    this.worker.ref(); const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker!.postMessage({ id, op, options }); });
  }
  list(options: CatalogOptions = {}) { return this.request<CatalogList>('list', options); }
  deletion(id: string, targets: string[], prefixes: string[], allowTransaction = false) { return this.request<{ removed: { id: string; title: string; type: string; sourceIds: string[] }[]; references: string[]; revision: string }>('deletion', { id, targets, prefixes, allowTransaction }); }
  search(query: string, scope: string, limit: number, overlay?: Map<string, string>) { return this.request<Slice<SearchHit>>('search', { query, scope, limit, overlay: overlay ? [...overlay] : [] }); }
  lint(limit?: number) { return this.request<Record<'orphans' | 'unindexed' | 'brokenLinks' | 'unreviewed', { total: number; items: Record<string, string>[] }>>('lint', { limit }); }
  refresh() { return this.request<void>('refresh'); }
  metrics() { return this.request<{ scans: number; reads: number }>('metrics'); }
  async dispose() { const worker = this.worker; this.worker = undefined; if (worker) await worker.terminate(); }
}
