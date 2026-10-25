# ZMod 插件规范（manifest v2）

> 本文是插件清单与安装机制的权威定义。开发走查见 [plugin-author-guide.md](./plugin-author-guide.md)。

## 1. manifest.json 全字段

插件根目录必须含 `manifest.json`（UTF-8 JSON 对象）与入口 JS 文件（缺省 `index.js`）。

| 字段 | 必填 | 类型 | 语义 | 缺省行为 |
| --- | --- | --- | --- | --- |
| `id` | 必填 | string | 插件唯一标识，kebab-case（`/^[a-z0-9][a-z0-9-]*$/`），须与目录名、`definePlugin.id` 一致 | 无，缺失即校验失败 |
| `name` | 必填 | string | 面板/市场里的显示名 | 无，缺失即校验失败 |
| `version` | 必填 | string | 严格 semver：`x.y.z[-prerelease][+build]`；须与 `definePlugin.version` 一致 | 无，缺失即校验失败 |
| `description` | 必填 | string | 一句话描述，市场搜索按它匹配 | 无，缺失即校验失败 |
| `author` | 必填 | string | 作者名 | 无，缺失即校验失败 |
| `entry` | 可选 | string | 入口文件相对路径，相对插件根 | `"index.js"` |
| `engine` | 可选 | object | 引擎版本约束：`{ zmod?: range, zcode?: range }`，range 语义见 §3 | 不声明 = 无约束 |
| `permissions` | 可选 | string[] | 能力白名单声明，见 §2 | `[]` |
| `category` | 可选 | string | 市场分类，仅允许 `appearance` / `productivity` / `datasource` / `fun` | 不参与分类过滤 |
| `homepage` | 可选 | string | 主页 http(s) URL | 忽略 |
| `repo` | 可选 | string | 源码仓库 http(s) URL | 忽略 |

规范之外的未知字段不报错，但会产生 warning 并被忽略（向前兼容）。

**一致性铁律**：`manifest.id` / `manifest.version` 必须与 `index.js` 里 `definePlugin({ id, version })` 字面量一致——官方仓库的 `manifest-consistency.test.js` 会对每个 `plugins/` 目录强制校验，第三方脚手架（`zmod plugin init`）生成的测试骨架也内置同一检查。

## 2. permissions 白名单

声明「这个插件要真实使用的能力」，按需声明：

| 权限 | 语义 |
| --- | --- |
| `dom.patch` | 通过 `ctx.patcher` 对宿主对象做 AOP 补丁（before/after/instead） |
| `net.fetch` | 经主进程 HTTP 代理发起网络请求（绕开渲染端 CORS，仅 http(s)） |
| `vault.write` | 向加密凭据库写入 secret（API Key / Cookie 等） |
| `vault.read` | 读取自己写入的 secret |
| `datasource` | 使用 `ctx.datasources`（消费实例状态 / 注册 Provider 类型） |

清单只允许上述五个值，其它值 schema 校验直接失败。白名单是给用户看的安全声明（市场详情页展示），不是运行时沙箱开关——不要声明用不到的权限（尤其 `vault.write`），避免浪费用户信任。

## 3. engine 版本范围

`engine.zmod` / `engine.zcode` 接受以下子集（不引 npm semver 依赖，SDK 内自实现）：

| 表达式 | 语义 |
| --- | --- |
| `"*"`（或空串） | 任意版本 |
| `"1.2.3"` | 精确等于该版本 |
| `">=1.2.3"` | 大于等于该版本（含等号：`>=1.0.0-beta` 满足 `1.0.0-beta`） |
| `"^1.2.3"` | 同主版本内兼容（base major>0：`^1.2.3` = `>=1.2.3 <2.0.0`；0.x 依次锁 minor/patch） |
| `"~1.2.3"` | `>=1.2.3 <1.3.0`（锁 minor） |

**prerelease 规则**：遵循 semver 优先级——同 x.y.z 下无 prerelease > 有 prerelease（`1.0.0 > 1.0.0-beta`）；prerelease 标识逐段比较，数字段按数值（`beta.11 > beta.2`），数字段 < 字母段，前缀短者小（`beta.1 < beta.1.1`）。

**fail-closed**：清单声明了某引擎约束但安装/运行环境拿不到对应版本号时，判定为**不满足**并给出原因，绝不放行。声明了不支持的 range 表达式（如 `1.x`、`||` 组合）同样直接失败。

## 4. 目录约定

```text
<plugin-id>/
├── manifest.json      # 必需
├── index.js           # 缺省入口（ESModule，default 导出 definePlugin(...)）
├── README.md          # 建议提供
└── test/              # 可选；node:test 骨架（zmod plugin init 自动生成）
```

- 插件是纯 ESModule，源码即产物，无构建步骤；`zmod-local://` 协议端自动把裸导入 `@zmod/sdk` 重写为绝对 URL。
- 非缺省入口时在 manifest 写 `"entry": "./lib/main.js"` 形式的相对路径。
- 打包 zip 时解压根必须直接是 `manifest.json` + `index.js`（不允许多包一层目录）。

## 5. registry.json 格式

官方插件注册表位于仓根 `registry.json`，随 main 分支发布；运行时/CLI 按「GitHub raw 主源 → jsdelivr 镜像」双源顺序拉取，失败回退本地磁盘缓存。`tools/publish-plugins.cjs` 是它的事实源生成器。

```json
{
  "updated": "2026-10-25T09:07:13.241Z",
  "plugins": [
    {
      "id": "quota-popover",
      "version": "1.1.0-beta",
      "url": "https://github.com/OkmiHonor/ZMod-for-ZCode/releases/download/plugins/quota-popover-1.1.0-beta.zip",
      "shasum": "<64 位 hex，zip 的 sha256>",
      "manifest": { "...": "与 plugins/<id>/manifest.json 完全一致的内嵌副本" }
    }
  ]
}
```

- `url` 统一指向 GitHub release tag `plugins` 下的 zip 资产；
- `shasum` 安装时强制校验，不匹配即拒绝；
- 内嵌 `manifest` 供市场列表展示（名称/描述/分类/权限），与 `plugins/` 目录漂移会被 `publish-plugins.cjs --check` 抓住。

## 6. 安装来源四形态

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| `registry:<id>` | 面板「插件市场」tab / 主进程 `plugin.install` RPC | 强刷注册表 → 下载 zip → sha256 校验 → 解压校验后落盘 |
| `git:<https-url>` | 面板 URL 安装（`.git` 结尾自动补全）| 浅克隆仓库根当插件根；`zmod plugin update` 支持重克隆检查 |
| `zip:<http(s)-url>` | 面板 URL 安装 | 下载 zip → 解压；CLI 侧等价形式是直接传 `.zip` 本地路径 |
| 本地目录 | `zmod plugin install <目录>` | 目录即插件根，开发调试主通道 |

CLI `zmod plugin install` 接受三种实参：本地目录、本地/网络 `.zip` 路径、`https://…/*.git` 仓库 URL（等价 `git:` 形态）。所有来源安装前都会过 manifest schema + engine 校验，不合格拒绝落盘。

## 7. installed.json 安装账本

数据目录 `<data>/installed.json` 记录「每个插件实际是怎么装进来的」，是 `zmod plugin update` 的决策依据：

```json
{
  "plugins": {
    "demo-hello": {
      "version": "0.1.0",
      "source": "dir",
      "sourceRef": "D:\\path\\to\\demo-hello",
      "shasum": "",
      "installedAt": "2026-10-25T12:00:00.000Z"
    }
  }
}
```

- `source` ∈ `builtin` / `registry` / `git` / `zip` / `dir`；
- `sourceRef`：registry/zip 为下载 URL，git 为克隆 URL，dir 为安装时绝对路径；
- `shasum` 仅 zip/registry 来源记录；
- update 行为：`registry` → 对比远端版本自动更新；`git` → 重克隆检查；`zip`/`dir`/`builtin` → 不支持自动更新（builtin 随基座发布，重跑安装器即可）。
