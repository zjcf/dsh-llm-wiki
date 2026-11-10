export const withoutGallery = (text: string) => text.replace(/\n*<!-- wiki-source-images -->[\s\S]*?<!-- \/wiki-source-images -->\n*/g, '\n').trim();
export const contentLength = (text: string) => text.replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1').replace(/<!--[^]*?-->/g, '').trim().length;

export function reviewGuide(text: string) {
  const length = contentLength(text);
  return {
    mode: length <= 2000 ? 'compact' : 'structured',
    sourceCharacters: length,
    maxBodyCharacters: length <= 2000 ? Math.max(200, Math.ceil(length * 1.3)) : Math.min(24000, Math.max(1500, Math.ceil(length * 0.8))),
    instructions: length <= 2000
      ? '短材料保留原有要点、步骤或命令即可；不要套材料概况、审计报告、证据索引、缺失项清单等模板。原文没有的背景、原理和操作不要补写。'
      : '按材料实际章节和步骤归纳；保留表格、命令与适用条件。图片只放在所解释的章节或步骤旁，不汇集到末尾。不生成与本次材料无关的主题页。',
  };
}

export function readLines(text: string, startLine = 1, lineCount = 80, query?: string, startColumn = 0) {
  const lines = text.split(/\r?\n/);
  if (query?.trim()) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let best = -1, score = 0;
    for (let i = 0; i < lines.length; i++) {
      const count = terms.filter(term => lines[i].toLowerCase().includes(term)).length;
      if (count > score) { score = count; best = i; }
    }
    if (best >= 0) {
      let start = best;
      while (start > 0 && !/^#{1,6}\s/.test(lines[start]) && best - start < 12) start--;
      startLine = start + 1;
      let end = best + 1;
      while (end < lines.length && !/^#{1,6}\s/.test(lines[end]) && end - start < 60) end++;
      lineCount = Math.min(lineCount, end - start);
    }
  }
  const start = Math.min(Math.max(Math.floor(startLine) || 1, 1) - 1, lines.length);
  const count = Math.min(Math.max(Math.floor(lineCount) || 80, 1), 200);
  const selected: string[] = [];
  let characters = 0;
  let nextColumn = 0;
  for (const [index, line] of lines.slice(start, start + count).entries()) {
    const column = index === 0 ? Math.max(0, Math.floor(startColumn) || 0) : 0;
    const value = line.slice(column, column + 8000 - characters);
    selected.push(value); characters += value.length + 1;
    if (column + value.length < line.length) { nextColumn = column + value.length; break; }
    if (characters >= 8000) break;
  }
  const end = start + selected.length;
  const startOffset = lines.slice(0, start).reduce((size, line) => size + line.length + 1, 0) + Math.max(0, Math.floor(startColumn) || 0);
  const totalCharacters = lines.join('\n').length;
  return { text: selected.join('\n'), startLine: start + 1, endLine: end, totalLines: lines.length,
    startOffset, endOffset: Math.min(totalCharacters, startOffset + selected.join('\n').length + (!nextColumn && end < lines.length ? 1 : 0)), totalCharacters,
    more: !!nextColumn || end < lines.length,
    ...(nextColumn ? { nextLine: end, nextColumn } : end < lines.length ? { nextLine: end + 1 } : {}) };
}
