import { posix } from 'node:path';

export const reviewNotice = '> **待复核**：此页引用过已删除的来源。使用受影响的结论前，请核对剩余证据。';

function targetPath(page: string, target: string) {
  if (/^(?:[a-z][a-z\d+.-]*:|[/#])/i.test(target)) return undefined;
  try {
    return posix.normalize(posix.join(posix.dirname(page), decodeURIComponent(target.split(/[?#]/, 1)[0])));
  } catch { return undefined; }
}

export function referenceTargets(page: string, text: string) {
  const urls: string[] = [];
  for (const match of text.matchAll(/!?\[(?:\\.|[^\]\\\n])*\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]+|\([^()\n]*\))+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/g)) urls.push(match[1] ?? match[2]);
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]+)>?/gm)) urls.push(match[1]);
  return [...new Set(urls.map(url => targetPath(page, url)).filter((value): value is string => !!value))];
}

export function pruneReferences(page: string, text: string, targets: ReadonlySet<string>, prefixes: string[], sourceId: string) {
  const matches = (url: string) => {
    if (url.startsWith('/api/dsh-llm-wiki?')) {
      const query = new URLSearchParams(url.slice(url.indexOf('?') + 1).split('#', 1)[0]);
      return ['source', 'original'].includes(query.get('op') ?? '') && query.get('id') === sourceId;
    }
    const path = targetPath(page, url);
    return !!path && (targets.has(path) || prefixes.some(prefix => path.startsWith(prefix)));
  };
  const names = new Set<string>();
  const normalize = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  const definition = /^ {0,3}\[([^\]\n]+)\]:[ \t]*<?([^\s>]+)>?[^\r\n]*(?:\r?\n|$)/gm;
  for (const item of text.matchAll(definition)) {
    if (matches(item[2])) names.add(normalize(item[1]));
  }
  const remove = (line: string) => {
    let next = line.replace(/!?\[(?:\\.|[^\]\\\n])*\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]+|\([^()\n]*\))+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\)))?\s*\)/g,
      (link, angle, plain) => matches(angle ?? plain) ? '' : link);
    if (names.size) {
      next = next.replace(/!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g,
        (link, label, ref) => names.has(normalize(ref || label)) ? '' : link);
    }
    return next;
  };
  const withoutDefinitions = text.replace(definition, (line, _label, url) => matches(url) ? '' : line);
  return withoutDefinitions.split(/(?<=\n)/).map(line => {
    const next = remove(line);
    if (page === 'index.md' && next !== line && /^\s*[-*+]\s/.test(line)) return '';
    return next;
  }).join('');
}

export function flagForReview(text: string) {
  if (text.includes(reviewNotice)) return text;
  const front = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
  const header = front?.[0] ?? '';
  return header + '\n' + reviewNotice + '\n\n' + text.slice(header.length).trimStart();
}
