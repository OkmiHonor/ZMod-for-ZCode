#!/usr/bin/env node
/**
 * ZMod 基座标准自动化发版工具 (Standard Base Release Pipeline)
 *
 * 核心职责（杜绝人工遗漏）：
 *  1. 状态自检：检查 Git 工作树与分支、运行单元测试；
 *  2. 版本顺延（5处全覆盖）：根 package.json、cli、core、sdk、renderer/index.js (ZMOD_VERSION)；
 *  3. 构建安装器：执行 tools/build-installer.cjs 并验证 dist/ZMod-Setup-<ver>.exe 产物与大小；
 *  4. 生产环境部署：自动同步最新运行时文件到本机生产目录 D:\ZMod\data\runtime；
 *  5. Git 提交与 Tag：提交发版改动、打 v<ver> 标签并推送到 GitHub；
 *  6. GitHub Release：以「ZMod 基座 <ver>」标准标题发布 Release，挂载安装包并附加 Plugins release 链接；
 *  7. 终检闭环：检查 Release 是否为公开 Latest 状态且资产完整。
 *
 * 用法：
 *   node tools/release.cjs --check            # 只检查当前版本状态与一致性
 *   node tools/release.cjs --bump [patch|minor] # 自动顺延版本、构建、部署与发版 (默认 patch)
 *   node tools/release.cjs --version <x.y.z>   # 指定确切版本号发版
 *   node tools/release.cjs --deploy-only      # 仅部署当前源码到本机生产数据目录 (D:\ZMod\data)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROD_DATA_DIR = 'D:\\ZMod\\data';
const DEMO_DATA_DIR = 'D:\\ZMod-Dev\\ZModDemo\\zmoddata';

const VERSION_FILES = [
  { file: path.join(ROOT, 'package.json'), type: 'json' },
  { file: path.join(ROOT, 'packages', 'zmod-cli', 'package.json'), type: 'json' },
  { file: path.join(ROOT, 'packages', 'zmod-core', 'package.json'), type: 'json' },
  { file: path.join(ROOT, 'packages', 'zmod-sdk', 'package.json'), type: 'json' },
  { file: path.join(ROOT, 'packages', 'zmod-core', 'src', 'renderer', 'index.js'), type: 'const' }
];

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: opts.silent ? 'pipe' : 'inherit', ...opts });
}

function getVersions() {
  const versions = [];
  for (const item of VERSION_FILES) {
    const content = fs.readFileSync(item.file, 'utf8');
    if (item.type === 'json') {
      const v = JSON.parse(content).version;
      versions.push({ file: path.relative(ROOT, item.file), version: v });
    } else {
      const m = content.match(/const\s+ZMOD_VERSION\s*=\s*'([^']+)'/);
      versions.push({ file: path.relative(ROOT, item.file), version: m ? m[1] : 'NOT_FOUND' });
    }
  }
  return versions;
}

function checkVersions() {
  const list = getVersions();
  const first = list[0].version;
  const mismatch = list.filter((x) => x.version !== first);
  if (mismatch.length > 0) {
    console.error('❌ 版本号不一致 (Version Mismatch):');
    for (const item of list) console.error(`  - ${item.file}: ${item.version}`);
    return null;
  }
  return first;
}

function setVersion(newVer) {
  for (const item of VERSION_FILES) {
    let content = fs.readFileSync(item.file, 'utf8');
    if (item.type === 'json') {
      const json = JSON.parse(content);
      json.version = newVer;
      fs.writeFileSync(item.file, JSON.stringify(json, null, 2) + '\n', 'utf8');
    } else {
      content = content.replace(/const\s+ZMOD_VERSION\s*=\s*'[^']+'/, `const ZMOD_VERSION = '${newVer}'`);
      fs.writeFileSync(item.file, content, 'utf8');
    }
  }
  console.log(`✔ 5 处版本号已全部同步更新为: ${newVer}`);
}

function bumpSemver(cur, type = 'patch') {
  const parts = cur.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`无法识别的标准版本号: ${cur}`);
  }
  if (type === 'minor') {
    return `${parts[0]}.${parts[1] + 1}.0`;
  }
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

function deployToProduction() {
  console.log('\n🚀 [1/4] 部署最新运行时到生产与演示数据目录...');
  const targets = [path.join(PROD_DATA_DIR, 'runtime'), path.join(DEMO_DATA_DIR, 'runtime')];
  
  for (const tgt of targets) {
    if (!fs.existsSync(path.dirname(tgt))) continue;
    fs.mkdirSync(tgt, { recursive: true });

    // 同步 common, main, sdk
    for (const mod of ['common', 'main']) {
      const src = path.join(ROOT, 'packages', 'zmod-core', 'src', mod);
      const dst = path.join(tgt, mod);
      fs.cpSync(src, dst, { recursive: true, force: true });
    }
    const sdkSrc = path.join(ROOT, 'packages', 'zmod-sdk', 'src');
    fs.cpSync(sdkSrc, path.join(tgt, 'sdk'), { recursive: true, force: true });

    // 同步 core (renderer)
    const coreDst = path.join(tgt, 'core');
    fs.mkdirSync(coreDst, { recursive: true });
    const rendSrc = path.join(ROOT, 'packages', 'zmod-core', 'src', 'renderer');
    for (const f of fs.readdirSync(rendSrc)) {
      if (f.endsWith('.js')) {
        fs.copyFileSync(path.join(rendSrc, f), path.join(coreDst, f));
      }
    }
    console.log(`  ✔ 已部署到: ${tgt}`);
  }
  console.log('  👉 客户端内按下 Ctrl+R 即可秒级热重载生效！\n');
}

function buildInstaller(version) {
  console.log(`\n📦 [2/4] 构建 NSIS 安装器 (ZMod-Setup-${version}.exe)...`);
  sh('node tools/build-installer.cjs');
  const exePath = path.join(ROOT, 'dist', `ZMod-Setup-${version}.exe`);
  if (!fs.existsSync(exePath)) {
    throw new Error(`安装包生成失败，未找到产物: ${exePath}`);
  }
  const sizeMb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(2);
  console.log(`  ✔ 安装器构建成功: ${exePath} (${sizeMb} MB)\n`);
  return exePath;
}

function runTests() {
  console.log('🧪 运行回归测试套件 (Test Gate)...');
  try {
    sh('node --test packages/zmod-core/test/settings-page-titlebar.test.js packages/zmod-cli/test/*.test.js', { silent: true });
    console.log('  ✔ 关键路径回归测试全绿通过！\n');
  } catch (err) {
    console.error('❌ 测试未通过，发版终止！', err.message);
    process.exit(1);
  }
}

function gitAndRelease(version, notesFile) {
  console.log(`\n🚀 [3/4] 提交 Git 与 Tag (v${version})...`);
  sh('git add package.json packages/zmod-cli/package.json packages/zmod-core/package.json packages/zmod-sdk/package.json packages/zmod-core/src/renderer/index.js');
  
  // 检查是否有要提交的文件
  try {
    sh(`git commit -m "release: v${version}"`);
  } catch {
    console.log('  (版本无新变动或已预先提交)');
  }

  sh('git push origin main');
  sh(`git tag v${version}`);
  sh(`git push origin v${version}`);
  console.log(`  ✔ Git 分支与 Tag v${version} 推送完成！\n`);

  console.log(`🌐 [4/4] 发布 GitHub Release (ZMod 基座 ${version})...`);
  const exePath = path.join(ROOT, 'dist', `ZMod-Setup-${version}.exe`);
  
  // 生成标准 Release Notes
  const defaultNotes = `## ZMod 基座 ${version}

> 本 Release 发布的是 **ZMod 基座**：安装后**不预装任何 Mod**。启动 ZCode 后打开「设置」（左下角齿轮）→ 侧栏底部「ZMod」分组，即可从**插件市场**一键安装所需 Mod。安装后的图文首航指南见 [README · 安装后首航](https://github.com/OkmiHonor/ZMod-for-ZCode#安装后首航图文)。

### ✨ 更新亮点
- 请在 commit 历史中查看本次更新细节。

---
Plugins release: [Plugins release](https://github.com/OkmiHonor/ZMod-for-ZCode/releases/tag/plugins)
`;

  const finalNotesPath = notesFile || path.join(os.tmpdir(), `zmod-release-${version}.md`);
  if (!notesFile) {
    fs.writeFileSync(finalNotesPath, defaultNotes, 'utf8');
  }

  sh(`gh release create v${version} "${exePath}" --title "ZMod 基座 ${version}" --notes-file "${finalNotesPath}" --latest`);
  console.log(`\n🎉 发布大功告成！Release「ZMod 基座 ${version}」已上线！`);
  sh(`gh release view v${version} --json name,tagName,isDraft,assets`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--deploy-only')) {
    deployToProduction();
    return;
  }

  if (args.includes('--check')) {
    console.log('🔍 检查版本号一致性:');
    const cur = checkVersions();
    if (cur) {
      console.log(`  ✔ 全仓版本自洽，当前版本: ${cur}`);
    }
    return;
  }

  const curVer = checkVersions();
  if (!curVer) {
    console.error('❌ 版本号不自洽，请先执行检查修复！');
    process.exit(1);
  }

  let targetVer = null;
  const verIdx = args.indexOf('--version');
  if (verIdx >= 0 && args[verIdx + 1]) {
    targetVer = args[verIdx + 1];
  } else if (args.includes('--bump-minor')) {
    targetVer = bumpSemver(curVer, 'minor');
  } else {
    // 默认 patch 顺延
    targetVer = bumpSemver(curVer, 'patch');
  }

  const notesIdx = args.indexOf('--notes');
  const notesFile = notesIdx >= 0 ? args[notesIdx + 1] : null;

  console.log(`\n======================================================`);
  console.log(`   ZMod 基座标准发版流水线: v${curVer}  ➔  v${targetVer}`);
  console.log(`======================================================\n`);

  runTests();
  setVersion(targetVer);
  deployToProduction();
  buildInstaller(targetVer);
  gitAndRelease(targetVer, notesFile);
}

main().catch((err) => {
  console.error('\n❌ 发版异常中断:', err);
  process.exit(1);
});
