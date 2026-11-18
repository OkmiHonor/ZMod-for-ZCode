#!/usr/bin/env node
/**
 * ZMod 发版前隐私/敏感信息扫描工具 (Preflight Secret Scan)
 *
 * 用途：在发版流水线（tools/release.cjs）与日常提交前，对即将进入 Git 历史 /
 * GitHub Release 的内容做敏感信息审计，拦截疑似密钥、令牌、个人用户路径、
 * 内网地址与敏感命名文件，避免随发版外泄。
 *
 * 用法：
 *   node tools/preflight-secret-scan.cjs                    # 默认 --worktree：扫描已跟踪的改动文件
 *   node tools/preflight-secret-scan.cjs --worktree         # git diff --name-only HEAD（staged+unstaged 并集）
 *   node tools/preflight-secret-scan.cjs --staged           # 仅扫描已暂存：git diff --cached --name-only
 *   node tools/preflight-secret-scan.cjs --all              # 全仓存量审计：git ls-files
 *   node tools/preflight-secret-scan.cjs --files <路径...>   # 显式路径，支持目录递归（跳过 node_modules 与 .git）
 *   node tools/preflight-secret-scan.cjs --files <zip路径>    # .zip 解包扫描其中的文本条目
 *   node tools/preflight-secret-scan.cjs --worktree --strict # WARN 级命中也判定失败
 *
 * 约定：
 *  - 只扫描存在的普通文件；内容前 8KB 含 \0 判定为二进制并跳过；
 *  - .zip 走 PowerShell/.NET 解包，仅扫文本类条目，命中路径显示为「外层路径!条目名」；
 *  - ERROR 级命中文本脱敏显示（保留前 6 与后 3 字符，中间以 … 代替）；
 *  - 退出码：0 = 干净 / 仅 WARN（--strict 时 WARN 也失败）；1 = 存在 ERROR 级命中；2 = 用法或 IO 错误。
 *
 * 零第三方依赖，Node >= 18。zip 解包调用系统 PowerShell（Windows 基座自带）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BINARY_SNIFF_BYTES = 8 * 1024;

// zip 内条目：仅这些扩展名按文本扫描，其余（图片、音频、字体等）跳过
const ZIP_TEXT_EXT = /\.(js|cjs|mjs|json|jsonc|md|ts|tsx|jsx|yml|yaml|txt|html|css|xml|svg|sh|bat|ps1|backup\d*|bak|orig|old)$/i;
// 单条目解压上限：超过则跳过，避免被 zip bomb 拖垮
const ZIP_ENTRY_MAX_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 规则定义（逐行独立测试；g 标志供 matchAll 使用）
// ---------------------------------------------------------------------------

// ERROR 级：命中即阻断发版
const ERROR_RULES = [
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { id: 'aliyun-access-key', re: /\bLTAI[A-Za-z0-9]{12,}\b/g },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'personal-user-path', re: /[Cc]:[\/\\]Users[\/\\][^"'\/\\\s:]+/g }
];

// WARN 级：提示人工复核
const WARN_RULES = [
  { id: 'credential-assign', re: /(?:api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|cookie)\s*[:=]\s*["'][^"'\s]{16,}["']/gi },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9_\-.=]{24,}\b/g }
];

// sensitive-filename：按 basename 判定的敏感命名文件（ERROR 级）
const FILENAME_RULES = [
  /^\.env($|\.)/,
  /\.(pem|pfx|p12|keystore)$/,
  /(^|_)id_rsa/,
  /^credentials?\.json$/i,
  /^service[-_]?account/i,
  /^secrets?\.(json|txt|env)$/i
];

// 邮箱（宽松匹配，含 localhost 这类单段域名；白名单逻辑见 isAllowlistedEmail）
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\b/g;

// 私网 IPv4（10/8、172.16/12、192.168/16）；127.0.0.1 与 0.0.0.0 在匹配结果中再排除
const PRIVATE_IPV4_RE = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;

// ---------------------------------------------------------------------------

function printUsage() {
  console.log(`用法: node tools/preflight-secret-scan.cjs [--worktree|--staged|--all|--files <路径...>] [--strict]

  --worktree   扫描 git diff --name-only HEAD 列出的已跟踪改动文件（默认）
  --staged     仅扫描已暂存文件（git diff --cached --name-only）
  --all        全仓存量审计（git ls-files）
  --files      显式指定路径，支持目录递归（跳过 node_modules 与 .git）
  --strict     WARN 级命中也判定为失败

退出码: 0 通过 / 仅 WARN；1 存在 ERROR 级命中；2 用法或 IO 错误`);
}

function failUsage(msg) {
  console.error(`✖ ${msg}`);
  printUsage();
  process.exit(2);
}

function failIO(msg) {
  console.error(`✖ ${msg}`);
  process.exit(2);
}

// ERROR 级命中脱敏：保留前 6 与后 3 字符，中间以 … 代替；过短命中整体隐藏
function mask(text) {
  if (text.length <= 9) return '…';
  return `${text.slice(0, 6)}…${text.slice(-3)}`;
}

// 邮箱白名单：GitHub 机器人邮箱、本团队邮箱、示例/占位/测试邮箱、localhost
function isAllowlistedEmail(email) {
  const e = email.toLowerCase();
  const at = e.lastIndexOf('@');
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (domain === 'users.noreply.github.com' || domain.endsWith('.users.noreply.github.com')) return true;
  if (e.includes('okmihonor')) return true;
  if (domain === 'example.com' || domain === 'example.org'
    || domain.endsWith('.example.com') || domain.endsWith('.example.org')) return true;
  if (domain === 'localhost') return true;
  if (/^(your-name|yourname|username)$/.test(local)) return true;
  if (e === 'test@test') return true;
  return false;
}

// 相对路径展示：仓库外路径（如临时目录）直接显示绝对路径
function displayPath(abs) {
  const rel = path.relative(ROOT, abs);
  if (!rel || rel.startsWith('..')) return abs.replace(/\\/g, '/');
  return rel.replace(/\\/g, '/');
}

function gitListFiles(gitArgs) {
  const res = spawnSync('git', ['-c', 'core.quotepath=false', ...gitArgs], { cwd: ROOT, encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    failIO(`git 命令执行失败: git ${gitArgs.join(' ')}${res.stderr ? `\n${res.stderr.trim()}` : ''}`);
  }
  return res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function walkDir(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    failIO(`目录读取失败: ${dir} (${err.message})`);
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDir(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
}

function collectFiles(mode, fileArgs) {
  const absFiles = [];
  if (mode === 'files') {
    if (fileArgs.length === 0) failUsage('--files 需要至少一个路径参数');
    for (const p of fileArgs) {
      const abs = path.resolve(process.cwd(), p);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        failIO(`路径不存在或不可访问: ${p}`);
      }
      if (st.isDirectory()) walkDir(abs, absFiles);
      else if (st.isFile()) absFiles.push(abs);
    }
  } else {
    const gitArgs = mode === 'worktree'
      ? ['diff', '--name-only', 'HEAD']
      : mode === 'staged'
        ? ['diff', '--cached', '--name-only']
        : ['ls-files'];
    for (const rel of gitListFiles(gitArgs)) {
      const abs = path.resolve(ROOT, rel);
      // 已删除/不存在的路径与非常规文件一律跳过
      try {
        if (fs.statSync(abs).isFile()) absFiles.push(abs);
      } catch { /* 文件已删除，跳过 */ }
    }
  }
  return [...new Set(absFiles)].sort();
}

function addHit(hits, seen, lineNo, level, id, text, entry) {
  const key = `${entry || ''}|${id}|${lineNo}|${text}`;
  if (seen.has(key)) return;
  seen.add(key);
  const hit = { lineNo, level, id, text };
  if (entry) hit.entry = entry;
  hits.push(hit);
}

function looksBinary(content) {
  return content.slice(0, BINARY_SNIFF_BYTES).includes('\0');
}

// 对一段文本套用全部规则；baseName 用于 sensitive-filename 判定，
// zip 内条目传条目名而非外层文件名。
function scanText(content, baseName) {
  const hits = [];
  const seen = new Set();

  // sensitive-filename：按 basename 判定，行号记 0 表示文件级命中
  for (const re of FILENAME_RULES) {
    if (re.test(baseName)) addHit(hits, seen, 0, 'ERROR', 'sensitive-filename', baseName);
  }

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const lineNo = i + 1;
    for (const rule of ERROR_RULES) {
      for (const m of line.matchAll(rule.re)) addHit(hits, seen, lineNo, 'ERROR', rule.id, m[0]);
    }
    for (const rule of WARN_RULES) {
      for (const m of line.matchAll(rule.re)) addHit(hits, seen, lineNo, 'WARN', rule.id, m[0]);
    }
    for (const m of line.matchAll(EMAIL_RE)) {
      if (!isAllowlistedEmail(m[0])) addHit(hits, seen, lineNo, 'WARN', 'non-allowlist-email', m[0]);
    }
    for (const m of line.matchAll(PRIVATE_IPV4_RE)) {
      if (m[0] === '127.0.0.1' || m[0] === '0.0.0.0') continue;
      addHit(hits, seen, lineNo, 'WARN', 'private-address', m[0]);
    }
  }
  return hits;
}

function scanFile(abs) {
  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return failIO(`文件读取失败: ${displayPath(abs)} (${err.message})`);
  }
  if (looksBinary(content)) return { binary: true, hits: [] };
  return { binary: false, hits: scanText(content, path.basename(abs)) };
}

// PowerShell 单引号内需把 ' 翻倍；zip 路径经此转义后嵌入 -EncodedCommand 脚本
function psQuote(p) { return p.replace(/'/g, "''"); }

// zip 解包：借系统 .NET ZipFile 把每个文本条目读成字节，再以 base64 走 stdout，
// 全程 ASCII 管道，规避 Windows 中文路径/编码问题，且不落临时文件。
function readZipTextEntries(abs) {
  // 与 ZIP_TEXT_EXT 等价；PowerShell -notmatch 本身大小写不敏感，无需 (i)
  const extPattern = '\\.(js|cjs|mjs|json|jsonc|md|ts|tsx|jsx|yml|yaml|txt|html|css|xml|svg|sh|bat|ps1|backup\\d*|bak|orig|old)$';
  // 条目内容与错误原因都走 base64 的 ASCII 行，失败时始终 exit 0，
  // 避免 PowerShell 本地化错误文本/CLIXML 经控制台编码后变成乱码。
  const script = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    'try {',
    `  $z=[System.IO.Compression.ZipFile]::OpenRead('${psQuote(path.resolve(abs))}')`,
    '  try {',
    '    foreach ($e in $z.Entries) {',
    `      if ($e.Length -gt ${ZIP_ENTRY_MAX_BYTES}) { continue }`,
    `      if ($e.FullName -notmatch '${extPattern}') { continue }`,
    '      try {',
    '        $s=$e.Open(); $ms=New-Object System.IO.MemoryStream',
    '        try { $s.CopyTo($ms); $bytes=$ms.ToArray() } finally { $s.Dispose(); $ms.Dispose() }',
    '        $nb=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($e.FullName))',
    '        $cb=[Convert]::ToBase64String($bytes)',
    '        [Console]::Out.WriteLine($nb + "`t" + $cb)',
    '      } catch { continue }',
    '    }',
    '  } finally { $z.Dispose() }',
    '} catch {',
    '  $msg=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))',
    '  [Console]::Out.WriteLine("ZIPERR|" + $msg)',
    '}',
  ].join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  const entries = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('ZIPERR|')) {
      let reason = 'zip 读取失败';
      try { reason = Buffer.from(line.slice(7), 'base64').toString('utf8'); } catch { /* 保留默认原因 */ }
      throw new Error(reason.slice(0, 200));
    }
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    try {
      const name = Buffer.from(line.slice(0, tab), 'base64').toString('utf8');
      const bytes = Buffer.from(line.slice(tab + 1), 'base64');
      entries.push({ name, content: bytes.toString('utf8') }); // Node utf8 解码即 errors:'replace'
    } catch { /* 单条解码失败则跳过，不影响其它条目 */ }
  }
  return entries;
}

function scanZip(abs) {
  let entries;
  try {
    entries = readZipTextEntries(abs);
  } catch (err) {
    return { unreadable: true, hits: [{ lineNo: 0, level: 'WARN', id: 'zip-unreadable', text: String(err.message || err).slice(0, 200) }] };
  }
  const hits = [];
  for (const entry of entries) {
    if (!ZIP_TEXT_EXT.test(entry.name) || looksBinary(entry.content)) continue;
    for (const h of scanText(entry.content, path.posix.basename(entry.name))) {
      hits.push({ ...h, entry: entry.name });
    }
  }
  return { unreadable: false, hits };
}

function main() {
  const argv = process.argv.slice(2);
  let mode = null;
  let strict = false;
  const fileArgs = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--strict') {
      strict = true;
    } else if (arg === '--worktree' || arg === '--staged' || arg === '--all') {
      if (mode) failUsage(`扫描模式冲突: --${mode} 与 ${arg} 不可同时使用`);
      mode = arg.slice(2);
    } else if (arg === '--files') {
      if (mode) failUsage(`扫描模式冲突: --${mode} 与 --files 不可同时使用`);
      mode = 'files';
      for (let j = i + 1; j < argv.length; j++) {
        if (argv[j] === '--strict') strict = true;
        else fileArgs.push(argv[j]);
      }
      break;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      failUsage(`未知参数: ${arg}`);
    }
  }
  if (!mode) mode = 'worktree';

  const absFiles = collectFiles(mode, fileArgs);
  console.log(`🔐 ZMod 发版前隐私扫描 | 模式: ${mode} | 待扫文件: ${absFiles.length}`);

  let errorCount = 0;
  let warnCount = 0;
  let binarySkipped = 0;
  let zipUnreadable = 0;

  for (const abs of absFiles) {
    const isZip = path.extname(abs).toLowerCase() === '.zip';
    const { binary, hits, unreadable } = isZip ? scanZip(abs) : scanFile(abs);
    if (binary) {
      binarySkipped++;
      continue;
    }
    const outer = displayPath(abs);
    for (const hit of hits) {
      const shown = hit.level === 'ERROR' ? mask(hit.text) : hit.text;
      const where = hit.entry ? `${outer}!${hit.entry}` : outer;
      console.log(`  ${where}:${hit.lineNo} [${hit.level}] ${hit.id}: ${shown}`);
      if (hit.level === 'ERROR') errorCount++;
      else warnCount++;
    }
    if (unreadable) zipUnreadable++;
  }

  const binNote = binarySkipped > 0 ? `（跳过二进制 ${binarySkipped} 个）` : '';
  const zipNote = zipUnreadable > 0 ? `（zip 不可读 ${zipUnreadable} 个）` : '';
  console.log(`\n📊 扫描汇总：文件 ${absFiles.length}，ERROR ${errorCount}，WARN ${warnCount} ${binNote}${zipNote}`.trimEnd());

  if (errorCount > 0) {
    console.error('✖ 发现 ERROR 级敏感信息命中，禁止发版！请先清理上述敏感内容。');
    process.exit(1);
  }
  if (warnCount > 0 && strict) {
    console.error('✖ --strict 模式下 WARN 级命中同样判定失败，请人工复核后处理。');
    process.exit(1);
  }
  if (warnCount > 0) {
    console.log('⚠ 仅存在 WARN 级提示，请人工复核确认后继续。');
  } else {
    console.log('✔ 未发现敏感信息命中，扫描通过。');
  }
  process.exit(0);
}

main();
