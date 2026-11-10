#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Wiki } from './wiki.js';

try {
  const args = process.argv.slice(2);
  const root = args[0] === '--root' ? args.splice(0, 2)[1] : process.cwd();
  const [command, ...params] = args;
  if (!root || !['status', 'import', 'search', 'check', 'extract'].includes(command) || (['import', 'search', 'extract'].includes(command) && !params.length)) {
    throw new Error('用法：dsh-llm-wiki [--root <库目录>] status | import <文件…> | extract <source_id> | search <关键词> | check');
  }
  const wiki = new Wiki(resolve(root));
  await wiki.initialize();
  switch (command) {
    case 'status': console.log(JSON.stringify(await wiki.listSources(), null, 2)); break;
    case 'extract': await wiki.reextract(params[0]); console.log(JSON.stringify(await wiki.source(params[0]), null, 2)); break;
    case 'import':
      for (const path of params) console.log(JSON.stringify(await wiki.import(basename(path), await readFile(path))));
      break;
    case 'search': console.log(JSON.stringify(await wiki.search(params.join(' '), 'all'), null, 2)); break;
    case 'check': {
      const result = await wiki.check();
      console.log(JSON.stringify(result, null, 2));
      if (result.errors.length) process.exitCode = 1;
      break;
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
