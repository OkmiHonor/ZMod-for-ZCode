import fs from 'node:fs';
import path from 'node:path';
import { getPluginsDir } from '../../../zmod-core/src/common/paths.js';
import { configManager } from '../../../zmod-core/src/common/config.js';

export async function pluginCommand(subCmd, arg) {
  if (subCmd === 'list') {
    console.log('\n📦 [ZMod 插件列表]:\n');
    const scan = (dir, type) => {
      if (!fs.existsSync(dir)) return;
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.isDirectory()) {
          const id = ent.name;
          const enabled = configManager.isPluginEnabled(id);
          const manifestFile = path.join(dir, id, 'manifest.json');
          let desc = '';
          if (fs.existsSync(manifestFile)) {
            try {
              const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
              desc = m.description || '';
            } catch {}
          }
          console.log(`  ${enabled ? '●' : '○'} [${enabled ? '启用' : '禁用'}] ${id.padEnd(18)} (${type}) - ${desc}`);
        }
      }
    };
    scan(path.resolve(process.cwd(), 'plugins'), '内置');
    scan(getPluginsDir(), '用户');
    console.log('');
    return;
  }

  if (subCmd === 'enable') {
    if (!arg) {
      console.error('用法: zmod plugin enable <plugin-id>');
      process.exit(1);
    }
    configManager.setPluginEnabled(arg, true);
    console.log(`✔ 插件 "${arg}" 已设为启用。`);
    return;
  }

  if (subCmd === 'disable') {
    if (!arg) {
      console.error('用法: zmod plugin disable <plugin-id>');
      process.exit(1);
    }
    configManager.setPluginEnabled(arg, false);
    console.log(`✔ 插件 "${arg}" 已设为禁用。`);
    return;
  }

  console.log('未知子命令。支持: list, enable <id>, disable <id>');
}
