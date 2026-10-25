# ZMod 插件开发指南（从 init 到发布）

> 规范细节（manifest 字段 / 权限 / engine / 安装机制）见 [plugin-spec.md](./plugin-spec.md)。本文是操作走查。

## 0. 一分钟总览

```bash
zmod plugin init my-mod          # 生成 my-mod/ 脚手架（manifest + index.js + README + 测试）
# 编辑 my-mod/index.js …
zmod plugin install ./my-mod     # 装进开发数据目录
# 重启客户端（或经面板安装触发热装载）
zmod plugin remove my-mod        # 卸载（配置保留）
```

## 1. 脚手架：`zmod plugin init`

```bash
zmod plugin init <kebab-id> [--dir <目标目录，缺省 ./>]
```

生成四件套：

| 文件 | 用途 |
| --- | --- |
| `manifest.json` | v2 清单，`description`/`author` 为占位文案，发布前改成真实信息 |
| `index.js` | `definePlugin` 入口，注释内含完整 ctx 能力速览 |
| `README.md` | 开发 / 打包 / 安装备忘 |
| `test/<id>.test.js` | node:test 骨架，校验 manifest 与 `definePlugin` 的 id/version 一致 |

`engine.zmod` 自动写为 `>=当前 CLI 版本`；id 必须是 kebab-case，目录已存在时报错。

## 2. definePlugin API 概览

`index.js` 导出 `definePlugin({...})`（SDK 源码与注释：`packages/zmod-sdk/src/index.js`）：

- **声明字段**：`id` / `name` / `version` / `description` / `author`（必填）；`settings`（声明式设置 Schema，面板自动渲染表单）；`styles`（可选原始 CSS，启用时自动注入）；`actions`（可选，设置页按钮：`{ key: { title, description, run } }`）。
- **生命周期**：`async start(ctx)` / `async stop(ctx)`。

`ctx` 能力（由渲染微内核注入，见 `packages/zmod-core/src/renderer/index.js` 的 `PluginRegistry`）：

| 成员 | 说明 |
| --- | --- |
| `ctx.invoke(method, params)` | 主进程 RPC：`vault.get/set`、`window.setMaterial`、`window.registerBossKey`、`system.openExternal` 等 |
| `ctx.ui` | `injectStyle(id, css)` / `removeStyle(id)` / `showToast(msg, 'success'\|'error'\|'info'\|'warn')` |
| `ctx.events` | 全局事件总线 `on / off / emit`；内建事件：`setting:<id>:<key>`、`plugin:enabled/disabled` |
| `ctx.patcher` | AOP 补丁器 `before / after / instead(obj, method, fn)`，插件禁用时自动 `unpatchAll` |
| `ctx.settings` | `get(key, fallback)` / `set(key, val)` / `onChange(key, fn)`（onChange 监听禁用时自动解绑） |
| `ctx.datasources` | 数据源消费与注册（需 manifest 声明 `datasource` 权限，否则为 null） |
| `ctx.cleanup(fn)` | 注册回收逻辑，禁用时 LIFO 执行——优先用它而不是 `stop()` 里手工还原 |

## 3. 调试

- **最快路径**：把插件目录放进 ZMod 数据目录的 `plugins/<id>/`（仓库开发者即 `<repo>/data/plugins/`），重启客户端加载。
- **热装载**：经管理面板（Ctrl+Shift+M）安装/移除/更新，或任何走主进程 `plugin.install` RPC 的操作，都会广播 `zmod:plugin-changed`，**运行中的客户端无需重启**即时装载/卸载（每次广播携带 `?v=mtime` 绕开 ESModule 缓存）。
- **CLI 装的插件**（`zmod plugin install`）重启后生效；之后可在面板内即时开关。
- 设置 Schema 改动后，面板表单自动跟随；`secret` 类型设置加密存 Vault，`config.json` 只留非敏感字段。

## 4. 打包 zip

要求：**解压根直接是 `manifest.json` + `index.js`**（不允许多包一层目录）。

```bash
# 在插件目录内执行
powershell -Command "Compress-Archive -Path .\* -DestinationPath ..\my-mod-0.1.0.zip"
```

打包后本地验证：

```bash
zmod plugin install ..\my-mod-0.1.0.zip
```

安装前会过 manifest schema + engine 校验，不合格拒绝落盘。

## 5. 发布到官方 registry

两条路（详见 `tools/publish-plugins.cjs` 头注释）：

1. **收录进官方仓库（推荐）**：把插件目录放进 ZMod 仓库 `plugins/<id>/`，提 Pull Request。维护者合并后由 `node tools/publish-plugins.cjs` 统一打 zip、算 sha256、更新仓根 `registry.json`，并上传到 GitHub release tag `plugins`。CI/维护者的 `--check` 模式会校验 zip/sha/内嵌 manifest 与目录无漂移，所以**四个官方插件的 manifest.version 必须与 index.js 里 definePlugin 字面量同步改**。
2. **登记条目**：插件留在你自己的仓库/托管，开 issue 或 PR 给维护者提交 registry 条目（`id` / `version` / `url`（zip 直链）/ `shasum` / `manifest` 内嵌副本），由维护者合入 `registry.json`。

用户侧随后即可 `zmod plugin update` 或面板市场一键安装。

## 6. 权限与安全注意

- **声明真实权限**：`permissions` 是给用户看的安全承诺（市场详情页展示），声明了就要真用，用不到的不要写。
- **不要索取不需要的 `vault.write`**：凭据库是全系统信任级别最高的能力；只读自己的 secret 用 `vault.read` 就够。
- **UI 铁律**：不要向 React 主树注入 DOM——用 `position:fixed` + 独立 z-index 的自绘层；样式走 `ctx.ui.injectStyle` 命名空间。
- **媒体限制**：禁用 `file://`（Chromium 拦截协议页资源），用内联 SVG / Base64 / WebAudio。
- **凭据永不落明文**：API Key / Cookie 一律声明为 `secret` 类型设置，走 DPAPI 加密 Vault。
- **版本一致性**：manifest 与 `definePlugin` 的 id/version 保持同步，测试骨架会帮你盯住。
