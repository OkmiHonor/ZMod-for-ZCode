# ZMod (v2.0) — Next-Generation Modular Mod Loader for ZCode

<div align="center">

**现代化、声明式、全外置的 ZCode 桌面客户端模块化扩展框架**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Architecture: Vencord+Spicetify](https://img.shields.io/badge/Architecture-Vencord%2BSpicetify-success.svg)](#architecture)
[![Node: >=18](https://img.shields.io/badge/Node-%3E%3D18-green.svg)](package.json)

</div>

---

## 🌟 为什么重构 ZMod 2.0？

传统的客户端魔改方案通常采用“反编译 asar 并硬编码注入 3MB 巨石代码”的方式。这在多次客户端更新中带来了巨大的维护痛苦：
- ❌ **设置孤岛与散落**：各个插件自己写 localStorage 或在磁盘各个目录写 JSON，配置极其混乱。
- ❌ **更新截断崩溃**：Electron asar 头部偏移缓存导致巨石内联脚本被截断报错。
- ❌ **环境绑死**：源码中写死特定开发者的绝对盘符路径，无法在 GitHub 上开源给他人使用。
- ❌ **敏感凭据裸奔**：云厂商 API Key 和 Cookie 明文保存在本地。

**ZMod 2.0 彻底终结了这些问题！**  
我们参考了 **Spicetify (Spotify)** 与 **Vencord (Discord)** 的现代化工业级架构：
- 💎 **全外置数据与运行时**：代码与配置 100% 存放在标准用户数据目录（`%APPDATA%/ZMod`），宿主安装器更新无法清除。
- 💎 **特权本地协议（`zmod-local://`）**：彻底干掉 3MB 内联巨石，通过自定义 Scheme 异步动态加载 ESModule 插件，支持即时热更新。
- 💎 **声明式配置中心（Declarative Settings）**：插件只需声明配置 Schema（开关、滑块、下拉框、密码输入），管理面板自动渲染出官方质感的原生 UI 表单！
- 💎 **硬件级安全凭据库（Secret Vault）**：基于 Electron `safeStorage`（Windows DPAPI 硬件加密），保护 API Key 与凭据安全。
- 💎 **开箱即用 CLI**：跨平台命令行工具，自动探测客户端路径，一键安装、诊断与自愈。

---

## 🏗️ 架构全景

```text
zmod/ (Monorepo)
├── packages/
│   ├── zmod-cli/              # 跨平台 CLI 工具 (install, restore, doctor, plugin)
│   ├── zmod-core/             # 运行时微内核 (zmod-local:// 协议, safeStorage 密钥库, 统一 RPC)
│   └── zmod-sdk/              # 面向插件作者的 SDK 与 definePlugin 规范
├── plugins/                   # 官方标准生态插件
│   ├── acrylic-window/        # Windows 11 亚克力半透明全透背板与全局老板键
│   ├── prompt-snippets/       # 常驻悬浮球 Prompt 片段库 (Lexical 富文本适配, {{变量}} 跳转)
│   ├── qcard-fade/            # 提问卡与输入框智能半透明与悬停聚焦
│   ├── token-monitor/         # Token 用量与百炼/DeepSeek/MiMo 多源配额 (安全凭据加密)
│   └── whale-widget/          # 小鲸鱼桌宠伴侣与 9 款 Chibi 角色换装
```

---

## 🚀 快速上手 (用户指南)

### 1. 运行环境诊断
自动检查系统环境、Node 版本以及本机 ZCode 安装位置：
```bash
npx zmod doctor
```

### 2. 一键安装
```bash
npx zmod install
```
启动 ZCode 客户端后，按快捷键 `Ctrl+Shift+M` 即可唤起统一管理面板！

### 3. 管理插件
```bash
# 查看所有已安装插件
npx zmod plugin list

# 启用或禁用插件
npx zmod plugin enable qcard-fade
npx zmod plugin disable whale-widget
```

### 4. 一键恢复纯净官方客户端
```bash
npx zmod restore
```

---

## 🛠️ 插件开发者指南 (1 分钟编写一个 Mod)

在 ZMod 2.0 中，你不需要手写复杂的弹窗、不需要操作 Electron 底层 IPC，也不需要手动读写本地文件：

```javascript
// plugins/my-awesome-mod/index.js
import { definePlugin } from '@zmod/sdk';

export default definePlugin({
  id: 'my-awesome-mod',
  name: '我的自定义增强',
  description: '给输入框添加酷炫特效',
  version: '1.0.0',
  author: 'Developer',

  // 1. 声明式配置: ZMod 管理面板会自动渲染对应控件!
  settings: {
    enableGlow: {
      type: 'switch',
      title: '启用发光特效',
      default: true
    },
    glowIntensity: {
      type: 'slider',
      title: '发光强度',
      default: 50,
      min: 10,
      max: 100
    },
    apiKey: {
      type: 'secret',
      title: '第三方服务密钥',
      description: '将受到操作系统硬件级安全加密保护'
    }
  },

  // 2. 插件生命周期
  start({ settings, ui, patcher }) {
    const intensity = settings.get('glowIntensity', 50);

    // 动态注入 CSS
    ui.injectStyle('my-glow', `
      .composer { box-shadow: 0 0 ${intensity}px rgba(59, 130, 246, 0.5); }
    `);

    // 监听用户在设置面板实时调节滑块
    settings.onChange('glowIntensity', (newVal) => {
      ui.injectStyle('my-glow', `
        .composer { box-shadow: 0 0 ${newVal}px rgba(59, 130, 246, 0.5); }
      `);
    });
  },

  stop({ ui }) {
    ui.removeStyle('my-glow');
  }
});
```

---

## 📄 开源许可证

本项目遵循 [MIT License](LICENSE)。
