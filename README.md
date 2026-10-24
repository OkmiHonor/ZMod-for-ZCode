# ZMod (v2.0) — Modular Mod Loader for ZCode

<div align="center">

**声明式、全外置的 ZCode 桌面客户端模块化扩展框架**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Architecture: Vencord+Spicetify](https://img.shields.io/badge/Architecture-Vencord%2BSpicetify-success.svg)](#️-架构)
[![Node: >=18.17](https://img.shields.io/badge/Node-%3E%3D18.17-green.svg)](package.json)

</div>

---

## 它解决什么问题

传统的客户端魔改方案把几 MB 的代码反编译后硬编码注入 asar 包。ZMod 2.0 改用 **Vencord/Spicetify 式架构**：

- 💎 **宿主补丁只有四小片**：主进程头/尾各几行（注册自定义协议 + 动态加载外置运行时）、preload 尾部一个 CJS 桥、index.html 一个 `<script>` 标签。所有真正的代码 100% 存放在用户数据目录，**更新运行时/插件无需重打 asar**。
- 💎 **特权本地协议（`zmod-local://`）**：`standard + supportFetchAPI + corsEnabled` 特权协议，从外部动态加载 ESModule 插件；协议端自动把裸导入 `@zmod/sdk` 重写为绝对 URL，插件源码零构建直接运行。
- 💎 **声明式配置中心**：插件声明 settings Schema（开关/滑块/下拉/文本/密码/颜色），管理面板自动渲染表单，持久化到 `%APPDATA%/ZMod/config.json`。
- 💎 **硬件级凭据库（Secret Vault）**：基于 Electron `safeStorage`（Windows DPAPI），API Key / Cookie 加密落盘。
- 💎 **双通道 RPC**：preload IPC 桥优先，fetch-over-protocol 兜底；含路径穿越防护与插件启用配置持久化。
- 💎 **安装器安全设计**：自动快照官方 asar 基线（`base/app.asar`）→ `restore` 一键还原；检测到旧版 v1 内联魔改或 Electron 熔断（AsarIntegrity 烧录）时拒绝安装；重建时强制校验 node-pty/ssh2 原生二进制 unpack 集合与官方一致。

## 🏗️ 架构

```text
ZCode 宿主 (app.asar, 四通道补丁)
├── out/main/index.js        ← 头: registerSchemesAsPrivileged(ready 前) | 尾: import(外置运行时)
├── out/preload/index.cjs    ← 尾: contextBridge.exposeInMainWorld("zmodAPI")
└── out/renderer/index.html  ← <script type="module" src="zmod-local://core/index.js">

%APPDATA%/ZMod/ (全外置运行时, 更新零接触 asar)
├── runtime/main/            ← 微内核主进程: 协议路由 / RPC 网关 / Secret Vault
├── runtime/core/index.js    ← 渲染微内核: 插件注册表 / 声明式设置表单 / 管理面板
├── runtime/sdk/             ← @zmod-sdk (definePlugin + Schema 校验)
├── plugins/<id>/            ← ESModule 插件 (源码即产物, 无构建步骤)
├── config.json              ← 声明式配置持久化
├── secure.vault             ← safeStorage 加密凭据
└── base/app.asar            ← 官方纯净基线快照 (restore 的还原源)

packages/
├── zmod-cli/                ← 跨平台 CLI (install / restore / doctor / plugin)
├── zmod-core/               ← 运行时微内核 (main + renderer + common)
└── zmod-sdk/                ← 插件作者 SDK
```

## 🚀 快速上手

```bash
git clone <this-repo> zmod && cd zmod
npm install

npm run zmod doctor                 # 诊断环境、宿主与熔断哨兵
npm run zmod install                # 一键安装（自动快照官方基线）
npm run zmod install -- --force     # 客户端运行中: 自动结束进程并在完成后重启
npm run zmod restore                # 一键还原官方纯净客户端
npm test                            # 运行测试套件
```

宿主目录探测顺序：`--path` > `config.json installPath` > `ZCODE_PATH` 环境变量 > 平台默认路径。

启动 ZCode 后按 **Ctrl+Shift+M** 唤起管理面板：启停插件、实时编辑声明式设置。

## 🛠️ 插件开发（1 分钟上手）

在 `plugins/my-mod/index.js` 写一个 ESModule，无需任何构建步骤：

```javascript
// plugins/my-mod/index.js
import { definePlugin } from '@zmod/sdk';

export default definePlugin({
  id: 'my-mod',
  name: '我的增强',
  description: '给输入框加光晕',
  version: '1.0.0',

  // 声明式设置: 管理面板自动渲染控件, 值自动持久化
  settings: {
    glow: { type: 'slider', title: '光晕强度', default: 50, min: 10, max: 100 },
    apiKey: { type: 'secret', title: '第三方密钥', description: 'DPAPI 硬件级加密存储' }
  },

  async start(ctx) {
    const { settings, ui, invoke, cleanup } = ctx;

    const apply = () => ui.injectStyle('my-glow', `
      .composer { box-shadow: 0 0 ${settings.get('glow', 50)}px rgba(59,130,246,.5); }
    `);
    apply();
    settings.onChange('glow', apply);   // 面板调节实时生效, 禁用时自动解绑

    cleanup(() => ui.removeStyle('my-glow'));
  }
});
```

- **生命周期**：`start(ctx)` / `stop(ctx)`；`ctx.cleanup(fn)` 注册的回收逻辑在禁用时 LIFO 执行。
- **RPC**：`ctx.invoke(method, params)` 调用主进程能力（`vault.get/set`、`window.setMaterial`、`window.registerBossKey`、`system.openExternal` 等）。
- **UI 铁律**：不要向 React 主树注入 DOM，用 `fixed` 定位 + 独立 z-index；样式走 `ui.injectStyle` 命名空间。
- **媒体**：禁 `file://`（Chromium 拦截），用内联 SVG / Base64 / WebAudio / emoji。

### 内置官方插件

| 插件 | 说明 |
| --- | --- |
| `acrylic-window` | Windows 11 亚克力/云母背板（主进程 `setBackgroundMaterial`）+ 全局老板键 |
| `qcard-fade` | 提问卡与输入框离底自动淡出/折叠，悬停毛玻璃唤醒 |
| `prompt-snippets` | 常驻悬浮球片段库：搜索、插入、`{{变量}}` 填充、Ctrl+/ 开关 |

> Roadmap（未随 v2 首发）：小鲸鱼桌宠与角色换装、多源 Token 配额监控。欢迎 PR。

## 📄 许可证

[MIT](LICENSE)
