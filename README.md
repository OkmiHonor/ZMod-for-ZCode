# ZMod — Modular Mod Loader for ZCode

<div align="center">

**声明式、全外置的 ZCode 桌面客户端模块化扩展框架**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Architecture: Vencord+Spicetify](https://img.shields.io/badge/Architecture-Vencord%2BSpicetify-success.svg)](#️-架构)
[![Node: >=18.17](https://img.shields.io/badge/Node-%3E%3D18.17-green.svg)](package.json)

</div>

---

## 它解决什么问题

传统的客户端魔改方案把几 MB 的代码反编译后硬编码注入 asar 包。ZMod 改用 **Vencord/Spicetify 式架构**：

- 💎 **宿主补丁只有四小片**：主进程头/尾各几行（注册自定义协议 + 动态加载外置运行时）、preload 尾部一个 CJS 桥、index.html 一个 `<script>` 标签。所有真正的代码 100% 存放在用户数据目录，**更新运行时/插件无需重打 asar**。
- 💎 **特权本地协议（`zmod-local://`）**：`standard + supportFetchAPI + corsEnabled` 特权协议，从外部动态加载 ESModule 插件；协议端自动把裸导入 `@zmod/sdk` 重写为绝对 URL，插件源码零构建直接运行。
- 💎 **声明式配置中心**：插件声明 settings Schema（开关/滑块/下拉/文本/密码/颜色），管理面板自动渲染表单，持久化到数据目录的 `config.json`（数据目录随 ZMod 安装目录，自动迁移旧版 %APPDATA%/ZMod）。
- 💎 **硬件级凭据库（Secret Vault）**：基于 Electron `safeStorage`（Windows DPAPI），API Key / Cookie 加密落盘。
- 💎 **双通道 RPC**：preload IPC 桥优先，fetch-over-protocol 兜底；含路径穿越防护与插件启用配置持久化。
- 💎 **安装器安全设计**：自动快照官方 asar 基线（`base/app.asar`）→ `restore` 一键还原；检测到旧版 v1 内联魔改或 Electron 熔断（AsarIntegrity 烧录）时拒绝安装；重建时强制校验 node-pty/ssh2 原生二进制 unpack 集合与官方一致。

## 🏗️ 架构

```text
ZCode 宿主 (app.asar, 四通道补丁)
├── out/main/index.js        ← 头: registerSchemesAsPrivileged(ready 前) | 尾: import(外置运行时)
├── out/preload/index.cjs    ← 尾: contextBridge.exposeInMainWorld("zmodAPI")
└── out/renderer/index.html  ← <script type="module" src="zmod-local://core/index.js">

<ZMod 安装目录>/data/ (全外置运行时, 更新零接触 asar)
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

### 方式一：一键安装（推荐，无需 Node.js）

从 [Releases](https://github.com/OkmiHonor/ZMod-for-ZCode/releases) 下载 `ZMod-Setup-x.y.z.exe` 双击运行即可。安装器不到 10MB，无需预装 Node.js——没有系统 Node 时会自动借用 ZCode 客户端自带的运行时（`ELECTRON_RUN_AS_NODE`）完成安装。

### 方式二：源码安装

```bash
git clone https://github.com/OkmiHonor/ZMod-for-ZCode.git zmod && cd zmod
npm install

npm run zmod doctor                 # 诊断环境、宿主与熔断哨兵
npm run zmod install                # 一键安装（自动快照官方基线）
npm run zmod install -- --force     # 客户端运行中: 自动结束进程并在完成后重启
npm run zmod restore                # 一键还原官方纯净客户端
npm test                            # 运行测试套件
```

宿主目录探测顺序：`--path` > `config.json installPath` > `ZCODE_PATH` 环境变量 > 平台默认路径 > 运行中进程反推（自定义安装目录也能自动找到）。

### 插件管理

```bash
npm run zmod plugin list                                 # 查看已装插件
npm run zmod plugin install <目录|xxx.zip|git-url>       # 安装第三方插件
npm run zmod plugin enable <id>                          # 启用（重启客户端生效）
npm run zmod plugin disable <id>                         # 禁用
```

启动 ZCode 后有两种管理入口：

- **官方设置页（推荐）**：打开设置，侧边栏出现原生外观的 **ZMod** 分组（「扩展插件」「数据源」两个条目）。全部 UI 使用宿主自身的主题 token 与类名，跟随明暗主题，观感与官方一致；
- **兜底面板**：**Ctrl+Shift+M** 唤起独立管理面板——官方大版本更新导致设置页结构变化时的保险入口。

## 🔌 数据源系统（datasources）

余额/额度类插件不写死任何接口地址或账号，统一走「类型适配器 + 用户实例」模型：

```text
Provider（类型适配器，插件注册）        Instance（用户实例，设置页配置）
┌──────────────────────────┐         ┌────────────────────────────┐
│ type: custom-http        │◀──类型──│ name: 我的网关              │
│ settings: url/token/路径 │         │ settings: {url, token, …}  │
│ fetchStatus(settings)    │◀─查询───┤ token 等凭据加密存 Vault    │
└──────────────────────────┘         └────────────────────────────┘
```

- **官方适配器插件** `official-providers`：`custom-http`（任意 JSON 接口：地址 + Bearer 令牌 + 取值路径）、`openai-compatible`（反代网关）、`console-web`（Cookie 控制台接口）；全部出厂零预配；
- **凭据永不落明文**：`secret` 类型设置写入系统加密保险库（Windows DPAPI / `safeStorage`），`config.json` 只保留非敏感字段；
- **共享缓存**：多个插件消费同一数据源时共享一次上游请求（60s TTL，可强制刷新）；
- **主进程 HTTP 代理** `net.fetch`：渲染端经 RPC 走主进程网络栈绕开 CORS；仅允许 http(s) 与常规方法。

插件侧消费 API：`ctx.datasources.getInstances()` / `getStatus(id)` / `subscribe(fn)` / `onStatus(id, fn)`、`ctx.datasources.registerProvider(def)` 注册新类型；`window.ZMod.settingsPage.contribute({ id, title, render })` 可向设置页「扩展插件」页贡献自定义区块（余额总览等）。

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
| `official-providers` | 数据源类型适配器（custom-http / openai-compatible / console-web），凭据全加密、出厂零预配 |
| `quota-popover` | 输入框「上下文容量」浮窗追加今日余额卡 + 模型设置页余量总览 |
| `account-quota` | 官方账号数据源：从客户端自身通道采集账号余量供余额卡消费 |

## 📄 许可证

[MIT](LICENSE)
