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
 *   node tools/preflight-secret-scan.cjs --worktree --strict # WARN 级命中也判定失败
 *
 * 约定：
 *  - 只扫描存在的普通文件；内容前 8KB 含 \0 判定为二进制并跳过；
 *  - ERROR 级命中文本脱敏显示（保留前 6 与后 3 字符，中间以 … 代替）；
 *  - 退出码：0 = 干净 / 仅 WARN（--strict 时 WARN 也失败）；1 = 存在 ERROR 级命中；2 = 用法或 IO 错误。
 *
 * 零第三方依赖，Node >= 18。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BINARY_SNIFF_BYTES = 8 * 1024;

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

function addHit(hits, seen, lineNo, level, id, text) {
  const key = `${id}|${lineNo}|${text}`;
  if (seen.has(key)) return;
  seen.add(key);
  hits.push({ lineNo, level, id, text });
}

function scanFile(abs) {
  const content = (() => {
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch (err) {
      return failIO(`文件读取失败: ${displayPath(abs)} (${err.message})`);
    }
  })();

  const result = { binary: false, hits: [] };
  if (content.slice(0, BINARY_SNIFF_BYTES).includes('\0')) {
    result.binary = true;
    return result;
  }

  const hits = result.hits;
  const seen = new Set();

  // sensitive-filename：按 basename 判定，行号记 0 表示文件级命中
  const base = path.basename(abs);
  for (const re of FILENAME_RULES) {
    if (re.test(base)) addHit(hits, seen, 0, 'ERROR', 'sensitive-filename', base);
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
  return result;
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

  for (const abs of absFiles) {
    const { binary, hits } = scanFile(abs);
    if (binary) {
      binarySkipped++;
      continue;
    }
    for (const hit of hits) {
      const shown = hit.level === 'ERROR' ? mask(hit.text) : hit.text;
      console.log(`  ${displayPath(abs)}:${hit.lineNo} [${hit.level}] ${hit.id}: ${shown}`);
      if (hit.level === 'ERROR') errorCount++;
      else warnCount++;
    }
  }

  const binNote = binarySkipped > 0 ? `（跳过二进制 ${binarySkipped} 个）` : '';
  console.log(`\n📊 扫描汇总：文件 ${absFiles.length}，ERROR ${errorCount}，WARN ${warnCount} ${binNote}`.trimEnd());

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
