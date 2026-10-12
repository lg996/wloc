import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generatedFiles } from './configure.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { config, files } = await generatedFiles();
const errors = [];
for (const [name, expected] of files) {
  const actual = await readFile(path.join(root, name), 'utf8').catch(() => '');
  if (actual.replaceAll('\r\n', '\n') !== expected) errors.push(`${name} 与配置不一致，请运行 npm run configure`);
}
if (/YOUR_GITHUB_OWNER/.test(config.repository)) {
  if (process.argv.includes('--release')) errors.push('尚未填写你的 GitHub 仓库地址');
  else console.warn('待发布配置：GitHub 仓库地址尚未填写。');
}
const manifest = JSON.parse(await readFile(path.join(root, 'docs/upstream-integrity.json'), 'utf8'));
for (const [name, expected] of Object.entries(manifest.files)) {
  // Git normalizes text line endings; hash the canonical LF representation.
  const content = (await readFile(path.join(root, name), 'utf8')).replaceAll('\r\n', '\n');
  if (createHash('sha256').update(content).digest('hex') !== expected) errors.push(`${name} 与上游完整性记录不同，请审核修改并更新记录`);
}
for (const name of await readdir(path.join(root, 'modules'))) {
  const content = await readFile(path.join(root, 'modules', name), 'utf8');
  if (/Yu9191\/wloc|wloc-pages\.pages\.dev|wloc-spoofer\.wloc\.workers\.dev|icloud\.com\/shortcuts/.test(content)) errors.push(`${name} 仍含旧运行链接`);
  for (const target of ['dist/wloc.js', 'dist/wloc-settings.js']) if (!content.includes(target)) errors.push(`${name} 缺少 ${target}`);
}

// 文档中不得残留外部公共实例地址（来源声明与历史记录除外）。
// 教训：此前该检查只覆盖 modules/，导致 README 与 docs/ 中的上游实例地址长期未被发现。
const EXTERNAL_HOST = /wloc\.xepesw\.workers\.dev|wloc-pages\.pages\.dev/;
const HOST_EXEMPT = new Set(['docs/PROVENANCE.md', 'CHANGELOG.md']);
const docNames = ['README.md', ...(await readdir(path.join(root, 'docs')))
  .filter((x) => x.endsWith('.md')).map((x) => `docs/${x}`)];
for (const name of docNames) {
  if (HOST_EXEMPT.has(name)) continue;
  const content = await readFile(path.join(root, name), 'utf8');
  if (EXTERNAL_HOST.test(content)) errors.push(`${name} 含外部公共实例地址，请改为本项目自建地址`);
}

for (const name of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', 'NOTICE.md', ...['DEPLOYMENT.md', 'PROVENANCE.md', 'MAINTENANCE.md', 'shortcut-guide.md'].map(x => `docs/${x}`)]) {
  const content = await readFile(path.join(root, name), 'utf8');
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    try { await readFile(path.resolve(root, path.dirname(name), target)); }
    catch { errors.push(`${name} 的本地链接不存在: ${target}`); }
  }
}
// ---------------------------------------------------------------- 敏感信息
// 本仓库是公开仓库：一旦提交个人身份信息或凭据，即永久泄露且无法真正撤回。
// 注意：**不得把具体的个人标识值（邮箱、账号 ID、机器名等）写进本文件**，
// 否则这个检查脚本自身就成了泄露源。只能使用通用模式。
const SENSITIVE = [
  [/gh[pous]_[A-Za-z0-9]{20,}/, 'GitHub 令牌'],
  [/github_pat_[A-Za-z0-9_]{20,}/, 'GitHub 细粒度令牌'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY/, '私钥内容'],
  [/AKIA[0-9A-Z]{16}/, 'AWS Access Key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack 令牌'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '邮箱地址'],
  [/[A-Za-z]:[\\/]{1,2}Users[\\/]/, '本机用户目录路径'],
];

// 用纯 Node 遍历而非调用 git：不依赖外部进程（某些受限环境会阻止 spawn），
// 且每个文件只读一次。注意**不能吞掉读取错误**，否则检查会在失败时静默通过。
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', '.wrangler', '.npm-cache']);
const TEXT_EXT = /\.(md|markdown|js|mjs|cjs|json|jsonc|toml|yml|yaml|txt|conf|sgmodule|lpx|module|stoverride|html|css|ts|tsx|py|sh)$/i;

async function collectTextFiles(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await collectTextFiles(path.join(dir, e.name), out);
    } else if (e.isFile() && TEXT_EXT.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const scanFiles = await collectTextFiles(root);
const found = SENSITIVE.map(([, label]) => [label, []]);
for (const file of scanFiles) {
  const content = await readFile(file, 'utf8').catch(() => null);
  if (content === null) errors.push(`敏感信息检查无法读取文件：${path.relative(root, file)}`);
  else for (const [re, label] of SENSITIVE) {
    if (re.test(content)) found.find(([l]) => l === label)[1].push(path.relative(root, file));
  }
}
for (const [label, hits] of found) {
  if (hits.length) errors.push(`检测到疑似${label}，涉及：${hits.join('、')}`);
}

if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('仓库配置、模块链接、文档链接、上游文件完整性及敏感信息检查通过。');
