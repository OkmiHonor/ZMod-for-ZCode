import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { getPluginsDir } from '../../../zmod-core/src/common/paths.js';
import { configManager } from '../../../zmod-core/src/common/config.js';

function scanInstalled() {
  const dir = getPluginsDir();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifestPath = path.join(dir, ent.name, 'manifest.json');
    let manifest = { id: ent.name, name: ent.name, description: '' };
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
      } catch {}
    }
    out.push({ id: ent.name, ...manifest });
  }
  return out;
}

/**
 * Turn a user-supplied source (local dir / .zip / git URL) into a local plugin
 * directory. Returns { dir, cleanup } — always call cleanup() when done.
 */
function resolvePluginSource(arg) {
  if (/^https?:\/\//.test(arg)) {
    const url = /\.git$/.test(arg) ? arg : `${arg}.git`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-'));
    const res = spawnSync('git', ['clone', '--depth', '1', '--quiet', url, tmp], { stdio: 'inherit' });
    if (res.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      console.error(`✖ git clone 失败: ${url}`);
      process.exit(1);
    }
    return { dir: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  }
  if (arg.toLowerCase().endsWith('.zip')) {
    const abs = path.resolve(arg);
    if (!fs.existsSync(abs)) {
      console.error(`✖ 文件不存在: ${abs}`);
      process.exit(1);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-plugin-'));
    // Windows 10+/macOS tar 都能解 zip（bsdtar）；显式用 System32 的 tar，
    // 避免在 Git Bash 等 MSYS 环境下抓到会把 "C:\" 当远程主机解析的 MSYS tar
    const tarBin = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    const res = spawnSync(tarBin, ['-xf', abs, '-C', tmp], { stdio: 'inherit' });
    if (res.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      console.error(`✖ 解压失败: ${abs}`);
      process.exit(1);
    }
    // 压缩包常见的单层包裹目录：下钻一层
    const entries = fs.readdirSync(tmp, { withFileTypes: true });
    const dir = entries.length === 1 && entries[0].isDirectory()
      ? path.join(tmp, entries[0].name)
      : tmp;
    return { dir, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  }
  const abs = path.resolve(arg);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error(`✖ 目录不存在: ${abs}`);
    process.exit(1);
  }
  return { dir: abs, cleanup: () => {} };
}

export async function pluginCommand(subCmd, arg) {
  if (subCmd === 'install') {
    if (!arg) {
      console.error('用法: zmod plugin install <本地目录 | xxx.zip | git-url>');
      process.exit(1);
    }
    const src = resolvePluginSource(arg);
    try {
      if (!fs.existsSync(path.join(src.dir, 'index.js'))) {
        console.error('✖ 插件源缺少 index.js（约定：插件根目录必须含 index.js，可选 manifest.json）');
        process.exit(1);
      }
      let manifest = {};
      const mp = path.join(src.dir, 'manifest.json');
      if (fs.existsSync(mp)) {
        try {
          manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
        } catch {}
      }
      const id = manifest.id || path.basename(src.dir);
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
        console.error(`✖ 非法插件 id: "${id}"（仅允许字母/数字/-/_）`);
        process.exit(1);
      }
      const dest = path.join(getPluginsDir(), id);
      if (fs.existsSync(dest)) {
        console.error(`✖ 插件 "${id}" 已安装（${dest}）。如需覆盖请先手动删除旧目录。`);
        process.exit(1);
      }
      fs.mkdirSync(getPluginsDir(), { recursive: true });
      fs.cpSync(src.dir, dest, { recursive: true });
      configManager.setPluginEnabled(id, true);
      console.log(`✔ 插件 "${id}"${manifest.version ? ` v${manifest.version}` : ''} 已安装并启用。`);
      console.log('  重启客户端生效；之后可在面板 (Ctrl+Shift+M) 内即时开关。\n');
    } finally {
      src.cleanup();
    }
    return;
  }

  if (subCmd === 'list' || !subCmd) {
    console.log('\n📦 [ZMod 插件]:\n');
    const plugins = scanInstalled();
    if (plugins.length === 0) {
      console.log(`  （无插件 — 运行 zmod install 部署官方插件到 ${getPluginsDir()}）\n`);
      return;
    }
    for (const p of plugins) {
      const enabled = configManager.isPluginEnabled(p.id);
      console.log(`  ${enabled ? '●' : '○'} [${enabled ? '启用' : '禁用'}] ${p.id.padEnd(18)} v${p.version || '?'} - ${p.description || p.name}`);
    }
    console.log('\n  注：CLI 开关在下次客户端启动时生效；面板内切换为即时生效 (Ctrl+Shift+M)\n');
    return;
  }

  if (subCmd === 'enable' || subCmd === 'disable') {
    if (!arg) {
      console.error(`用法: zmod plugin ${subCmd} <plugin-id>`);
      process.exit(1);
    }
    const installed = scanInstalled().some((p) => p.id === arg);
    if (!installed) {
      console.error(`✖ 插件 "${arg}" 未安装。用 zmod plugin list 查看已装插件。`);
      process.exit(1);
    }
    configManager.setPluginEnabled(arg, subCmd === 'enable');
    console.log(`✔ 插件 "${arg}" 已设为${subCmd === 'enable' ? '启用' : '禁用'}（重启客户端生效）。`);
    return;
  }

  console.log('未知子命令。支持: list, enable <id>, disable <id>');
}
