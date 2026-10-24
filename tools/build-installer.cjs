#!/usr/bin/env node
/**
 * ZMod 一键安装器构建：staging（运行所需文件 + 生产依赖）→ makensis → dist\ZMod-Setup-<ver>.exe
 * 前置：本机已 npm install（@electron/asar 供 staging 引用安装）+ NSIS（winget install NSIS.NSIS）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGING = path.join(DIST, 'staging');
const VERSION = require(path.join(ROOT, 'package.json')).version;
const MAKENSIS = 'C:\\Program Files (x86)\\NSIS\\makensis.exe';
const OUT = path.join(DIST, `ZMod-Setup-${VERSION}.exe`);

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(STAGING, { recursive: true });

// package.json：去掉 workspaces/private —— npm install 在 staging 里只装实体依赖，
// 避免 Windows workspace junction 被 NSIS File /r 打爆
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(
  path.join(STAGING, 'package.json'),
  JSON.stringify({ name: pkg.name, version: pkg.version, type: pkg.type, dependencies: pkg.dependencies }, null, 2) + '\n'
);

// 运行所需文件：v2 CLI + 运行时源 + 官方插件 + 入口脚本
for (const item of ['packages', 'plugins', 'LICENSE', 'README.md']) {
  fs.cpSync(path.join(ROOT, item), path.join(STAGING, item), { recursive: true });
}
fs.copyFileSync(path.join(ROOT, 'installer', 'run-install.cmd'), path.join(STAGING, 'run-install.cmd'));

console.log('[1/3] installing production deps into staging ...');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const r = spawnSync(npm, ['install', '--omit', 'dev', '--no-audit', '--no-fund'], { cwd: STAGING, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) { console.error('npm install failed'); process.exit(1); }

console.log('[2/3] compiling NSIS installer ...');
if (!fs.existsSync(MAKENSIS)) { console.error(`makensis not found: ${MAKENSIS}`); process.exit(1); }
const nsi = spawnSync(MAKENSIS, [
  `-DVERSION=${VERSION}`,
  `-DSTAGING_DIR=${STAGING}`,
  `-DOUT_FILE=${OUT}`,
  path.join(ROOT, 'installer', 'zmod-setup.nsi')
], { stdio: 'inherit' });
if (nsi.status !== 0) { console.error('makensis failed'); process.exit(1); }

console.log('[3/3] done.');
console.log(`  ${OUT}  (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
