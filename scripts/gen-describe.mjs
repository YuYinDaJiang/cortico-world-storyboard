/**
 * 生成 describe.json：`describe.json` 与运行时 `def.describe` 必须是同一份，手写两份迟早漂移。
 * 跑法：node scripts/gen-describe.mjs（改了工具 schema 之后跑一次）
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const { default: def } = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);

const document = {
  tools: def.describe?.tools ?? [],
  events: def.describe?.events ?? [],
};
writeFileSync(join(pkgDir, 'describe.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`describe.json: ${document.tools.length} 个工具，${document.events.length} 个事件`);
