import { extname } from 'node:path';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { png, type ExtractedImage } from './images.js';
import { extractDocx } from './docx.js';

export const textExtensions = new Set('.md .markdown .txt .csv .tsv .json .jsonl .log .yaml .yml .xml .rst .tex .py .js .ts .sh .ini .cfg .conf .sql'.split(' '));
export type Extraction = { extraction: 'text' | 'partial' | 'unavailable'; text?: string; limitations: string[]; images?: ExtractedImage[] };
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_IMAGES = 200;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

function visible(node: DefaultTreeAdapterMap['node']): string {
  if ('tagName' in node && ['script', 'style', 'template', 'noscript', 'head'].includes(node.tagName)) return '';
  if ('value' in node) return node.value;
  if (!('childNodes' in node)) return '';
  const text = node.childNodes.map(visible).join('');
  return 'tagName' in node && /^(p|h[1-6]|li|tr|br|div|section|article)$/.test(node.tagName) ? text + '\n' : text;
}

export async function extract(name: string, bytes: Uint8Array): Promise<Extraction> {
  const suffix = extname(name).toLowerCase();
  let content = '';
  const limitations: string[] = [];
  const images: ExtractedImage[] = [];
  try {
    if (suffix === '.pdf') {
      const { extractTextItems, getDocumentProxy, getResolvedPDFJS } = await import('unpdf');
      const { OPS } = await getResolvedPDFJS();
      const pdf = await getDocumentProxy(new Uint8Array(bytes), { maxImageSize: 16_000_000, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
      try {
        if (pdf.numPages > 500) throw new Error('PDF 超过 500 页，需人工阅读');
        const { items } = await extractTextItems(pdf);
        const text = items.map(page => page.map(item => item.str).join(' '));
        const pages: string[] = [];
        let imageBytes = 0;
        for (let number = 1; number <= pdf.numPages; number++) {
          const page = await pdf.getPage(number);
          const links: string[] = [];
          const viewport = page.getViewport({ scale: 1 });
          const layout: { x: number; y: number; text: string; image?: boolean }[] = [];
          for (const item of items[number - 1]) {
            if (!item.str.trim()) continue;
            const [x, y] = viewport.convertToViewportPoint(item.x, item.y + item.fontSize);
            const previous = layout.find(line => !line.image && Math.abs(line.y - y) < 2);
            if (previous) { previous.text += ' ' + item.str; previous.x = Math.min(previous.x, x); }
            else layout.push({ x, y, text: item.str });
          }
          try {
            const ops = await page.getOperatorList();
            let matrix = [1, 0, 0, 1, 0, 0];
            const stack: number[][] = [];
            const multiply = (a: number[], b: number[]) => [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
            for (let i = 0; i < ops.fnArray.length; i++) {
              const op = ops.fnArray[i];
              if (op === OPS.save) { stack.push([...matrix]); continue; }
              if (op === OPS.restore) { matrix = stack.pop() ?? [1,0,0,1,0,0]; continue; }
              if (op === OPS.transform) { matrix = multiply(matrix, ops.argsArray[i]); continue; }
              if (op === OPS.paintImageMaskXObject || op === OPS.paintImageMaskXObjectGroup || op === OPS.paintImageMaskXObjectRepeat) { limitations.push('第 ' + number + ' 页包含未还原的图像蒙版'); continue; }
              if (![OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObject].includes(op)) continue;
              if (images.length >= MAX_IMAGES || imageBytes >= MAX_IMAGE_BYTES) { limitations.push('图片超过 200 张或 64 MiB 上限，后续图片未抽取'); break; }
              const key = ops.argsArray[i][0];
              try {
                const image = typeof key !== 'string' ? key : await new Promise<any>((resolve, reject) => {
                  const timer = setTimeout(() => reject(new Error('图片解码超时')), 5000);
                  (key.startsWith('g_') ? page.commonObjs : page.objs).get(key, (value: unknown) => { clearTimeout(timer); resolve(value); });
                });
                const encoded = png(image.width, image.height, image.data, image.kind);
                if (imageBytes + encoded.length > MAX_IMAGE_BYTES) throw new Error('图片总大小超过 64 MiB 上限');
                imageBytes += encoded.length;
                const asset = { name: 'page-' + number + '-image-' + (links.length + 1) + '.png', bytes: encoded, mime: 'image/png', label: '第 ' + number + ' 页 · 图片 ' + (links.length + 1) };
                images.push(asset); links.push('![' + asset.label + '](assets/' + asset.name + ')');
                const corners = [[0,0],[1,0],[0,1],[1,1]].map(([x,y]) => viewport.convertToViewportPoint(matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]));
                layout.push({ x: Math.min(...corners.map(p=>p[0])), y: Math.min(...corners.map(p=>p[1])), text: links.at(-1)!, image: true });
                if (op === OPS.paintImageXObjectRepeat) limitations.push('第 ' + number + ' 页的重复图像仅保留一次，精确位置需核对原件');
              } catch (error) { limitations.push('第 ' + number + ' 页图片未完整抽取：' + (error instanceof Error ? error.message : '未知错误')); }
            }
          } catch { limitations.push('第 ' + number + ' 页图片解析失败'); }
          pages.push('## 第 ' + number + ' 页\n\n' + layout.sort((a,b)=>Math.abs(a.y-b.y)>2 ? a.y-b.y : a.x-b.x).map(block=>block.text).join('\n\n'));
          page.cleanup();
        }
        content = text.some(page => page.trim()) || images.length ? pages.join('\n\n') : '';
        const missing = text.flatMap((page, i) => page.trim() ? [] : [i + 1]);
        if (missing.length) limitations.push('未抽取到文本的页：' + missing.join('、'));
        limitations.push('PDF 根据文字和图片坐标恢复图文阅读顺序；多栏、表格、裁剪、蒙版及矢量图形需核对预览，未进行 OCR 或图像语义核对');
      } finally {
        await pdf.loadingTask.destroy();
      }
    } else if (suffix === '.docx') {
      content = extractDocx(bytes, images, limitations);
      limitations.push('DOCX 保留标题层级、列表、表格行列和图片段落位置；自动编号、合并单元格、浮动布局、公式及分页需核对预览，外链图片不下载');
    } else if (suffix === '.html' || suffix === '.htm') {
      if (bytes.length > MAX_TEXT) throw new Error('HTML 超过抽取大小上限');
      content = visible(parse(decoder.decode(bytes))).trim();
      limitations.push('HTML 仅抽取静态可见文本');
    } else if (textExtensions.has(suffix)) {
      if (bytes.length > MAX_TEXT) throw new Error('文件超过文本抽取大小上限');
      content = decoder.decode(bytes);
      if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(content)) throw new Error('文件含二进制控制字符');
    }
    if (content.trim() && Buffer.byteLength(content) <= MAX_TEXT) {
      return { extraction: limitations.length ? 'partial' : 'text', text: content, limitations: [...new Set(limitations)], images };
    }
    limitations.push(content.trim() ? '抽取文本超过大小上限' : '没有可搜索的正文，需阅读原件或使用 OCR');
  } catch (error) {
    limitations.push('抽取失败：' + (error instanceof Error ? error.message.slice(0, 260) : '未知错误'));
  }
  return { extraction: 'unavailable', limitations: [...new Set(limitations)], images };
}
