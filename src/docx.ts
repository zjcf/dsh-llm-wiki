import { posix } from 'node:path';
import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { imageType, type ExtractedImage } from './images.js';

type Node = Record<string, any>;
const decoder = new TextDecoder('utf-8', { fatal: true });
const children = (nodes: Node[], key: string): Node[] => nodes.flatMap(node => node[key] ?? []);
const find = (nodes: Node[], key: string): Node | undefined => {
  for (const node of nodes) {
    if (key in node) return node;
    for (const value of Object.values(node)) if (Array.isArray(value)) { const match = find(value, key); if (match) return match; }
  }
};
const attr = (node: Node | undefined, key: string) => node?.[':@']?.['@_' + key];
const value = (nodes: Node[], key: string) => attr(find(nodes, key), 'w:val');

export function extractDocx(bytes: Uint8Array, images: ExtractedImage[], limitations: string[]): string {
  const parts = /^word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml$/;
  let total = 0;
  const files = unzipSync(bytes, { filter(file) {
    if (!parts.test(file.name) && !/^word\/(?:styles\.xml|numbering\.xml|_rels\/[^/]+\.xml\.rels|media\/[^/]+)$/.test(file.name)) return false;
    total += file.originalSize;
    if (total > 72 * 1024 * 1024 || file.originalSize > (file.name.startsWith('word/media/') ? 16 : 8) * 1024 * 1024) throw new Error('DOCX 解压内容超过抽取大小上限');
    return true;
  } });
  const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, trimValues: false, parseTagValue: false });
  function xml(data?: Uint8Array): Node[] {
    if (!data) return [];
    const text = decoder.decode(data);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DOCX 包含不受支持的 XML 声明');
    return parser.parse(text);
  }
  const styles = new Map<string, Node[]>();
  for (const style of children(xml(files['word/styles.xml']), 'w:styles')) if (style['w:style']) styles.set(attr(style, 'w:styleId'), style['w:style']);
  function headingLevel(style: string, depth = 0): number | undefined {
    if (depth > 10) return;
    const definition = styles.get(style) ?? [];
    const outline = value(definition, 'w:outlineLvl');
    if (outline !== undefined && Number(outline) < 6) return Number(outline) + 1;
    const match = /^(?:heading|标题)\s*([1-6])$/i.exec(value(definition, 'w:name') ?? style);
    if (match) return Number(match[1]);
    const parent = value(definition, 'w:basedOn');
    if (parent) return headingLevel(parent, depth + 1);
  }
  const abstract = new Map<string, Node[]>(), numbers = new Map<string, string>();
  for (const node of children(xml(files['word/numbering.xml']), 'w:numbering')) {
    if (node['w:abstractNum']) abstract.set(attr(node, 'w:abstractNumId'), node['w:abstractNum']);
    if (node['w:num']) numbers.set(attr(node, 'w:numId'), value(node['w:num'], 'w:abstractNumId'));
  }
  const assets = new Map<string, ExtractedImage>();
  return Object.entries(files).filter(([name]) => parts.test(name)).sort(([a], [b]) => a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)).map(([name, data]) => {
    const role = name.includes('/header') ? 'header' : name.includes('/footer') ? 'footer' : /notes\.xml$/.test(name) ? 'note' : 'body';
    const relationships = new Map<string, string>();
    for (const node of children(xml(files['word/_rels/' + posix.basename(name) + '.rels']), 'Relationships')) {
      if (node.Relationship && attr(node, 'TargetMode') !== 'External') {
        const target = attr(node, 'Target') ?? '';
        relationships.set(attr(node, 'Id'), posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('word', target)));
      }
    }
    let paragraph = 0;
    function inline(nodes: Node[], location: string): string {
      let text = '';
      for (const node of nodes) {
        if (node['w:t']) text += node['w:t'].map((v: Node) => v['#text'] ?? '').join('');
        else if (node['w:tab']) text += '\t';
        else if (node['w:br'] || node['w:cr']) text += '\n';
        else if (node['w:sym']) text += attr(node, 'w:char') === 'F0E0' ? '➢' : '[符号 ' + attr(node, 'w:char') + ']';
        else if (node['a:blip'] || node['v:imagedata']) {
          const target = relationships.get(attr(node, 'r:embed') ?? attr(node, 'r:id'));
          if (!target || !/^word\/media\/[^/]+$/.test(target) || !files[target]) { limitations.push(location + '：外链或缺失图片未下载'); continue; }
          let image = assets.get(target);
          if (!image) {
            const type = imageType(files[target]);
            if (!type || images.length >= 200) { limitations.push(location + '：图片格式不受支持或数量超过 200 张'); continue; }
            image = { name: 'image-' + (images.length + 1) + '.' + type.extension, bytes: files[target], mime: type.mime, label: location, role };
            assets.set(target, image); images.push(image);
          }
          text += '\n\n![' + location + '](assets/' + image.name + ')\n\n';
        } else for (const entry of Object.values(node)) if (Array.isArray(entry)) text += inline(entry, location);
      }
      return text;
    }
    function blocks(nodes: Node[]): string[] {
      const output: string[] = [];
      for (const node of nodes) {
        if (node['w:p']) {
          paragraph++;
          const p = node['w:p'];
          const location = name + ' · 段落 ' + paragraph;
          const text = inline(p, location).trim();
          if (!text) continue;
          const properties = children(p, 'w:pPr');
          const style = value(properties, 'w:pStyle') ?? '';
          const outline = value(properties, 'w:outlineLvl');
          const heading = outline !== undefined && Number(outline) < 6 ? Number(outline) + 1 : headingLevel(style);
          const numPr = find(properties, 'w:numPr')?.['w:numPr'] ?? find(styles.get(style) ?? [], 'w:numPr')?.['w:numPr'];
          let prefix = '';
          if (heading) prefix = '#'.repeat(heading) + ' ';
          else if (numPr && value(numPr, 'w:numId') !== '0') {
            const level = value(numPr, 'w:ilvl') ?? '0';
            const levels = abstract.get(numbers.get(value(numPr, 'w:numId')) ?? '') ?? [];
            const definition = levels.find(node => node['w:lvl'] && String(attr(node, 'w:ilvl')) === String(level));
            prefix = '  '.repeat(Math.min(Number(level) || 0, 8)) + (value(definition?.['w:lvl'] ?? [], 'w:numFmt') === 'bullet' ? '- ' : '1. ');
          }
          output.push('<!-- ' + location + ' -->\n' + prefix + text);
        } else if (node['w:tbl']) {
          const rows = node['w:tbl'].filter((row: Node) => row['w:tr']).map((row: Node) => row['w:tr'].filter((cell: Node) => cell['w:tc']).map((cell: Node) => blocks(cell['w:tc']).join(' ').replace(/<!--[^]*?-->/g, '').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim())) as string[][];
          const width = Math.max(0, ...rows.map(row => row.length));
          if (width) {
            const render = (row: string[]) => '| ' + Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ') + ' |';
            output.push([render(rows[0]), render(Array(width).fill('---')), ...rows.slice(1).map(render)].join('\n'));
          }
        } else for (const entry of Object.values(node)) if (Array.isArray(entry)) output.push(...blocks(entry));
      }
      return output;
    }
    const content = blocks(xml(data)).join('\n\n');
    return content ? '## 部件：' + name + (role !== 'body' ? '（' + ({ header: '页眉', footer: '页脚', note: '附注' }[role]) + '）' : '') + '\n\n' + content : '';
  }).filter(Boolean).join('\n\n');
}
