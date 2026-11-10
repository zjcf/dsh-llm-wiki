import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

let script: Promise<string> | undefined;
export async function wordPreview(bytes: Uint8Array) {
  const nonce = randomBytes(18).toString('base64');
  const code = await (script ??= readFile(new URL('./word-preview.browser.js', import.meta.url), 'utf8'));
  return {
    policy: "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
    html: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Word 预览</title>'
      + '<style>html,body{margin:0;background:#eee;color:#222;font:14px/1.5 system-ui,sans-serif}#status{padding:24px;text-align:center}.docx-wrapper{padding:16px!important}section.docx{margin:0 auto 16px!important}img{max-width:100%}</style>'
      + '<body><p id="status" role="status">正在预览 Word 文档…</p><div id="pages"></div>'
      + '<script id="document-bytes" type="application/octet-stream">' + Buffer.from(bytes).toString('base64') + '</script>'
      + '<script nonce="' + nonce + '">' + code.replace(/<\/script/gi, '<\\/script') + '</script></body></html>',
  };
}
