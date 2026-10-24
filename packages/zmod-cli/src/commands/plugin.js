import fs from 'node:fs';
import path from 'node:path';
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

export async function pluginCommand(subCmd, arg) {
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
