#!/usr/bin/env node
/**
 * ZMod 插件市场发布脚本：plugins/ 下命中 PUBLISHED_PLUGINS 白名单且含
 * manifest.json 的目录 →
 *   dist/plugins/<id>-<version>.zip（zip 根 = 插件目录内容）→ sha256 → 更新仓根 registry.json。
 * （安装器已纯基座化，官方市场只独立分发白名单内的插件；其余目录仅作源码存档。）
 *
 * 用法：
 *   node tools/publish-plugins.cjs          打包 + 生成 registry.json + 打印 gh release upload 命令
 *   node tools/publish-plugins.cjs --check  重算 zip+sha 与 registry.json 比对，一致 exit 0，漂移 exit 1
 *
 * 不引第三方依赖：zip 用 PowerShell Compress-Archive；zip 条目自检用 .NET ZipFile 列条目名。
 * 所有 PowerShell 调用走 -EncodedCommand（UTF-16LE base64），绕开 Windows 命令行引号地狱。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const DIST_PLUGINS = path.join(ROOT, 'dist', 'plugins');
const REGISTRY = path.join(ROOT, 'registry.json');
const RELEASE_TAG = 'plugins';
const RELEASE_BASE = `https://github.com/OkmiHonor/ZMod-for-ZCode/releases/download/${RELEASE_TAG}`;

// 官方市场只独立分发这些插件（安装器已纯基座化；其余 plugins/ 目录仅作本地
// 源码存档，不进 registry）。
const PUBLISHED_PLUGINS = new Set([
  'quota-popover',
  'acrylic-window',
  'bubble-notifications',
  'prompt-snippets',
  'qcard-fade',
  'usage-stats',
]);

function ps(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`PowerShell failed (exit ${r.status}):\n${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout;
}

function q(p) { return p.replace(/'/g, "''"); }

// 打 zip：-Path 'dir\*' 使 zip 解压根直接是插件目录内容（首层即 manifest.json）
function packZip(dir, zipPath) {
  ps(`$ErrorActionPreference='Stop'\nCompress-Archive -Path '${q(path.join(dir, '*'))}' -DestinationPath '${q(zipPath)}' -Force`);
}

// 列 zip 条目名，用于自检（manifest.json 必须在解压根，且无反斜杠条目保证跨平台可解压）
function listZipEntries(zipPath) {
  const out = ps(
    `$ErrorActionPreference='Stop'\n` +
    `Add-Type -AssemblyName System.IO.Compression.FileSystem\n` +
    `$z=[System.IO.Compression.ZipFile]::OpenRead('${q(zipPath)}')\n` +
    `try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }`
  );
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadPlugins() {
  return fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(PLUGINS_DIR, e.name, 'manifest.json')))
    .filter((e) => PUBLISHED_PLUGINS.has(e.name))
    .map((e) => {
      const dir = path.join(PLUGINS_DIR, e.name);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      if (!manifest.id || !manifest.version) {
        throw new Error(`${dir}: manifest 缺少 id/version`);
      }
      return { dir, manifest };
    })
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

function buildRegistryEntry(plugin, zipPath) {
  const { id, version } = plugin.manifest;
  return {
    id,
    version,
    url: `${RELEASE_BASE}/${id}-${version}.zip`,
    shasum: sha256(zipPath),
    manifest: plugin.manifest,
  };
}

// 打包全部插件到 targetDir，返回 [{ plugin, zipPath, entries }]；自检失败直接终止
function packAll(plugins, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  return plugins.map(({ dir, manifest }) => {
    const zipPath = path.join(targetDir, `${manifest.id}-${manifest.version}.zip`);
    packZip(dir, zipPath);
    const entries = listZipEntries(zipPath);
    if (!entries.includes('manifest.json')) {
      throw new Error(`${zipPath}: 自检失败——zip 根缺少 manifest.json（条目：${entries.join(', ')}）`);
    }
    const backslash = entries.filter((n) => n.includes('\\'));
    if (backslash.length) {
      throw new Error(`${zipPath}: 条目名含反斜杠（${backslash.join(', ')}），跨平台解压会出问题`);
    }
    return { manifest, zipPath, entries };
  });
}

function main() {
  const checkMode = process.argv.includes('--check');
  const plugins = loadPlugins();
  if (!plugins.length) {
    console.error('plugins/ 下没有含 manifest.json 的插件目录');
    process.exit(1);
  }

  if (checkMode) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugins-check-'));
    let registry;
    try {
      if (!fs.existsSync(REGISTRY)) {
        console.error(`--check 失败：${REGISTRY} 不存在，先运行 node tools/publish-plugins.cjs 生成`);
        process.exit(1);
      }
      registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
      const packed = packAll(plugins, tmp);
      const byId = new Map((registry.plugins || []).map((p) => [p.id, p]));
      const drifts = [];
      for (const { manifest, zipPath, entries } of packed) {
        const expected = buildRegistryEntry({ manifest }, zipPath);
        const actual = byId.get(manifest.id);
        if (!actual) {
          drifts.push(`${manifest.id}: registry.json 缺少该插件`);
          continue;
        }
        for (const key of ['version', 'url', 'shasum']) {
          if (actual[key] !== expected[key]) {
            drifts.push(`${manifest.id}.${key}: registry=${actual[key]} 实际=${expected[key]}`);
          }
        }
        if (JSON.stringify(actual.manifest) !== JSON.stringify(manifest)) {
          drifts.push(`${manifest.id}.manifest: registry.json 内嵌 manifest 与 plugins/${manifest.id}/manifest.json 不一致`);
        }
        const distZip = path.join(DIST_PLUGINS, `${manifest.id}-${manifest.version}.zip`);
        if (!fs.existsSync(distZip)) {
          drifts.push(`${manifest.id}: dist zip 缺失（${path.relative(ROOT, distZip)}）`);
        } else if (sha256(distZip) !== expected.shasum) {
          drifts.push(`${manifest.id}: dist zip sha 与重算结果不一致，需重新发布`);
        }
        console.log(`[check] ${manifest.id} @ ${manifest.version}: ${entries.length} entries, sha ${expected.shasum.slice(0, 12)}...`);
      }
      const extra = (registry.plugins || []).map((p) => p.id).filter((id) => !plugins.some((p) => p.manifest.id === id));
      for (const id of extra) drifts.push(`${id}: registry.json 存在但 plugins/ 下已无此插件`);

      if (drifts.length) {
        console.error(`\n--check 失败，${drifts.length} 处漂移：`);
        for (const d of drifts) console.error(`  - ${d}`);
        process.exit(1);
      }
      console.log(`\n--check 通过：${plugins.length} 个插件 zip/sha/manifest 与 registry.json 完全一致`);
      process.exit(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 发布模式：打包 → registry → 打印 gh release upload 命令
  const packed = packAll(plugins, DIST_PLUGINS);
  const registry = {
    updated: new Date().toISOString(),
    plugins: packed.map(({ manifest, zipPath }) => buildRegistryEntry({ manifest }, zipPath)),
  };
  fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + '\n', 'utf8');

  console.log(`\nregistry.json 已更新（${registry.plugins.length} 个插件）：`);
  for (const { manifest, zipPath, entries } of packed) {
    const rel = path.relative(ROOT, zipPath);
    const size = fs.statSync(zipPath).size;
    console.log(`  ${rel}  ${(size / 1024).toFixed(1)} KB, ${entries.length} entries, sha256 ${registry.plugins.find((p) => p.id === manifest.id).shasum}`);
  }
  console.log(`\n上传（统一挂 release tag「${RELEASE_TAG}」）：`);
  for (const { zipPath } of packed) {
    console.log(`  gh release upload ${RELEASE_TAG} "${path.relative(ROOT, zipPath)}" --clobber`);
  }
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
