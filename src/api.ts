import { extname } from 'node:path';
import { MAX_UPLOAD, Wiki, WikiError } from './wiki.js';
import { textExtensions } from './extract.js';
import { wordPreview } from './preview.js';
import { unzipSync } from 'fflate';

export const API = '/api/dsh-llm-wiki';
export const UPLOAD_API = API + '-upload';
const originalTypes: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
const commonHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export const originalUrl = (id: string) => API + '?op=original&id=' + encodeURIComponent(id);
export const previewUrl = (id: string) => API + '?op=preview&id=' + encodeURIComponent(id);

async function uploadBytes(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length')) > MAX_UPLOAD) throw new WikiError('文件超过 25 MiB', 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD) {
        await reader.cancel();
        throw new WikiError('文件超过 25 MiB', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export function handler(wiki: Wiki, autoReview?: { wake(): void }, workspace?: { id: string; path: string }) {
  return async (request: Request) => {
    const { searchParams: params } = new URL(request.url);
    const id = params.get('id') ?? '';
    const op = params.get('op') ?? '';
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: commonHeaders });
    try {
      if (wiki.readOnly && (request.method === 'POST' || ['delete-preview', 'delete-page-preview', 'history-revert-preview', 'history-external-preview'].includes(op))) wiki.assertWritable();
      if (request.method === 'POST' && op === 'history-settings') {
        const input = JSON.parse(Buffer.from(await uploadBytes(request)).toString('utf8'));
        if (!input || typeof input.url !== 'string' || typeof input.branch !== 'string' || typeof input.revision !== 'string') throw new WikiError('同步配置格式无效');
        return json(await wiki.historySettings(input));
      }
      if (request.method === 'POST' && op === 'history-sync') return json(wiki.historySync(), 202);
      if (request.method === 'POST' && op === 'history-revert') return json(await wiki.historyRevert(id, params.get('token') ?? ''));
      if (request.method === 'POST' && op === 'history-external') return json(await wiki.historyRecordExternal(params.get('token') ?? ''));
      if (request.method === 'POST' && op === 'import') {
        const name = params.get('name') ?? '';
        const result = await wiki.import(name, await uploadBytes(request), !!autoReview);
        if (!result.duplicate && result.record.review_job === 'queued') autoReview?.wake();
        return json(result);
      }
      if (request.method === 'POST' && op === 'retry-review') {
        if (!autoReview) throw new WikiError('自动整理未启用', 409);
        await wiki.retryReview(id);
        autoReview.wake();
        return json({ queued: true }, 202);
      }
      if (request.method === 'POST' && op === 'retry-rebuild') {
        if (!autoReview) throw new WikiError('请先启用自动整理，再重试知识重整', 409);
        await wiki.retryRebuild(id); autoReview.wake();
        return json({ queued: true }, 202);
      }
      if (request.method === 'POST' && op === 'delete-source') {
        if (!autoReview && (await wiki.previewDeletion(id)).rebuilds.length) throw new WikiError('存在多来源知识页，请先启用自动整理再删除，插件会按剩余来源重建知识', 409);
        const result = await wiki.deleteSource(id, params.get('token') ?? '');
        if (result.rebuilds.length) autoReview?.wake();
        return json(result);
      }
      if (request.method === 'POST' && op === 'delete-page') {
        const token = params.get('token');
        if (!token) throw new WikiError('请先查看删除影响并确认', 400);
        return json(await wiki.deletePage(id, token));
      }
      if (request.method === 'POST' && op === 'extract-source') return json(await wiki.reextract(id));
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: '方法不支持' }, 405);
      switch (op) {
        case 'catalog-status': return json(wiki.catalogProgress());
        case 'history-status': return json(await wiki.historyStatus(params.get('inspect') === '1'));
        case 'history-list': {
          const items = await wiki.historyList(params.get('before') || undefined, 51);
          return json({ items: items.slice(0, 50), more: items.length > 50 });
        }
        case 'history-diff': return json(await wiki.historyDiff(id, { offset: Number(params.get('offset') ?? 0), limit: Number(params.get('limit') ?? 50) }));
        case 'history-file': {
          const path = params.get('path'); if (!path) throw new WikiError('请指定要读取的变更文件');
          return json(await wiki.historyDiff(id, { path }));
        }
        case 'history-revert-preview': return json(await wiki.historyRevertPreview(id));
        case 'history-external-preview': return json(await wiki.historyExternalPreview());
        case 'preview': {
          const { record, bytes } = await wiki.original(id);
          if (extname(record.name).toLowerCase() !== '.docx') throw new WikiError('此格式请使用原件预览', 415);
          let unpacked = 0;
          unzipSync(bytes, { filter(entry) {
            unpacked += entry.originalSize;
            if (unpacked > 72 * 1024 * 1024) throw new WikiError('Word 文档解压后超过预览大小上限，请下载原件查看', 413);
            return false;
          } });
          const preview = await wordPreview(bytes);
          return new Response(request.method === 'HEAD' ? null : preview.html, { headers: {
            ...commonHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': preview.policy,
          } });
        }
        case 'image': {
          const { bytes, mime } = await wiki.image(id, params.get('path') ?? '');
          return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), { headers: {
            ...commonHeaders, 'content-type': mime, 'content-length': String(bytes.length),
            'content-security-policy': "default-src 'none'; sandbox",
          } });
        }
        case 'list': return json({ ...await wiki.listCatalog({ view: params.get('view') === 'pages' ? 'pages' : 'sources', offset: Number(params.get('offset') ?? 0), limit: Number(params.get('limit') ?? 50), query: params.get('q') ?? '', filter: params.get('filter') ?? '', jobOffset: Number(params.get('jobOffset') ?? 0) }), autoReview: !!autoReview, readOnly: wiki.readOnly, workspace });
        case 'related': return json(await wiki.listCatalog({ view: 'pages', sourceId: id, offset: Number(params.get('offset') ?? 0), limit: 50 }));
        case 'source-status': await wiki.idle(); return json(await wiki.sourceStatus(id));
        case 'delete-preview': return json(await wiki.previewDeletion(id));
        case 'delete-page-preview': return json(await wiki.deletePage(id));
        case 'source': await wiki.idle(); return json({ ...await wiki.source(id), originalUrl: originalUrl(id), previewUrl: previewUrl(id) });
        case 'page': await wiki.idle(); return json(await wiki.page(id));
        case 'check': return json(await wiki.check());
        case 'search': {
          const scope = params.get('scope') === 'sources' ? 'sources' : 'wiki';
          return json(await wiki.search(params.get('q') ?? '', scope, 30));
        }
        case 'original': {
          const { record, bytes } = await wiki.original(id);
          const suffix = extname(record.name).toLowerCase();
          const contentType = originalTypes[suffix] ?? (textExtensions.has(suffix) || ['.html', '.htm'].includes(suffix) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
          const disposition = params.get('download') === '1' || contentType === 'application/octet-stream' ? 'attachment' : 'inline';
          return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
            headers: {
              ...commonHeaders,
              'content-type': contentType,
              'content-length': String(bytes.length),
              'content-disposition': disposition + "; filename*=UTF-8''" + encodeURIComponent(record.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16)),
              ...(contentType === 'application/pdf' ? {} : { 'content-security-policy': "default-src 'none'; sandbox" }),
            },
          });
        }
        default: return json({ error: '操作不存在' }, 404);
      }
    } catch (e) {
      if (e instanceof WikiError) return json({ error: e.message }, e.status);
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return json({ error: '知识库文件缺失' }, 404);
      return json({ error: '无法读取或写入知识库，请检查库目录和权限' }, 500);
    }
  };
}
