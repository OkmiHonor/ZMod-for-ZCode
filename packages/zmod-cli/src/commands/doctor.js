import fs from 'node:fs';
import path from 'node:path';
import { locateZCode } from '../locate.js';
import { getUserDataDir, getConfigPath, getPluginsDir } from '../../../zmod-core/src/common/paths.js';
import { configManager } from '../../../zmod-core/src/common/config.js';

export async function doctor() {
  console.log('\n🩺 [ZMod Doctor] 运行环境与安装状态诊断报告\n');

  // 1. Node & OS
  console.log(`• Node 版本: ${process.version}`);
  console.log(`• 操作系统: ${process.platform} (${process.arch})`);

  // 2. Locate ZCode
  const zcodePath = locateZCode();
  if (zcodePath) {
    console.log(`• ZCode 安装目录: ${zcodePath} [✔ 发现]`);
    const asarPath = path.join(zcodePath, 'resources', 'app.asar');
    if (fs.existsSync(asarPath)) {
      const stats = fs.statSync(asarPath);
      console.log(`• 目标 asar 包: ${asarPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB) [✔ 正常]`);
    } else {
      console.log(`• 目标 asar 包: 未在 resources/ 下找到 app.asar [✖ 警告]`);
    }
  } else {
    console.log(`• ZCode 安装目录: 未探测到 (可通过环境变量 ZCODE_PATH 指定) [✖ 缺失]`);
  }

  // 3. User Data Directory
  const userDataDir = getUserDataDir();
  console.log(`• 用户数据目录: ${userDataDir} [${fs.existsSync(userDataDir) ? '✔ 存在' : '○ 未初始化'}]`);
  const cfgPath = getConfigPath();
  console.log(`• 核心配置文件: ${cfgPath} [${fs.existsSync(cfgPath) ? '✔ 正常' : '○ 未创建'}]`);

  // 4. Plugins scan
  const cfg = configManager.get();
  console.log(`• 全局开关: ${cfg.enabled ? '开启 (ON)' : '关闭 (OFF)'}`);

  const pluginsDir = getPluginsDir();
  const builtInDir = path.resolve(getUserDataDir(), '..', '..', 'plugins');
  console.log('\n📦 [已安装/内置插件清单]:');

  const printPlugin = (dir, isBuiltIn) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        const id = ent.name;
        const enabled = configManager.isPluginEnabled(id);
        const manifestFile = path.join(dir, id, 'manifest.json');
        let name = id;
        if (fs.existsSync(manifestFile)) {
          try {
            name = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).name || id;
          } catch {}
        }
        console.log(`  - [${enabled ? '✔' : ' '}] ${id.padEnd(18)} : ${name} (${isBuiltIn ? '内置' : '用户自定义'})`);
      }
    }
  };

  printPlugin(path.resolve(process.cwd(), 'plugins'), true);
  printPlugin(pluginsDir, false);

  console.log('\n诊断结束。\n');
}
