# ZMod 插件开发标准规范与四类实现范式

> **核心宗旨**：保证所有 ZMod 插件拥有 **1:1 官方原生一致的视觉与交互体验**，并为人类与 AI 开发者提供清晰的 **“免探索抄作业路径”**，彻底终结重复逆向与重复造轮子。

---

## 一、 设置界面统一规范（Design System 铁律）

为了防止第三方插件自绘散装 UI 导致设置面板风格混乱，ZMod 内核推行**强类型声明式设置（Declarative Settings Schema）**。

### 1. 铁律：严禁手写设置界面的 HTML/CSS
- 插件开发者与 AI **绝对禁止** 在代码里手动创建设置弹窗、自定义按钮或拼凑表单 DOM；
- 插件只需在 `definePlugin.settings` 中声明需要的字段与类型，ZMod 微内核会自动在官方设置页「扩展插件」分区中渲染出 **1:1 原生对齐的控件**。

### 2. 标准支持控件（全量清单）

| 控件类型 (`type`) | 对应数据类型 | 说明与原生交互 |
|---|---|---|
| `'switch'` | `boolean` | **官方 1:1 Radix 规范开关**，自带微内核统一的绿色滑轨、平滑过渡动效与无障碍属性（`role="switch"`） |
| `'slider'` | `number` | **原生胶囊滑块**，支持 `min` / `max` / `step`，带右侧等宽数字实时回显 |
| `'text'` | `string` | 官方原生风格输入框，支持 `placeholder` |
| `'secret'` | `string` | **机密凭据输入框**，内容自动交由内核安全 Vault（AES-GCM）加密落盘，不在 `config.json` 留明文 |
| `'number'` | `number` | 数字输入框，自动类型转换 |
| `'select'` | `string` | 下拉单选框，需提供 `options: [{ label, value }]` |
| `'action'` | 无 | 触发型按钮，绑定至 `definePlugin.actions` 中的函数 |
| `'group'` | 无 | 视觉分组标题，用于长表单分段 |

### 3. 声明式配置示例
```javascript
export default definePlugin({
  id: 'my-plugin',
  name: '我的增强插件',
  version: '1.0.0',
  author: 'Developer',
  settings: {
    baseGroup: {
      type: 'group',
      title: '基础配置'
    },
    enabledFeature: {
      type: 'switch',
      title: '启用功能开关',
      description: '开启后将激活悬浮挂件与状态提示',
      default: true
    },
    transparency: {
      type: 'slider',
      title: '透明度',
      description: '调节显示透明度（推荐 80%）',
      min: 10,
      max: 100,
      step: 5,
      default: 80
    },
    apiKey: {
      type: 'secret',
      title: '服务凭据',
      description: '密钥将通过操作系统凭据安全加密保存',
      placeholder: 'sk-...'
    }
  }
});
```

---

## 二、 四大标准实现范式（Four Implementation Archetypes）

写新插件时，必须先**对号入座**选择对应的实现路径，直接沿用成熟轮子，严禁从零探索客户端架构。

```
                    ┌─────────────────────────┐
                    │     新插件功能需求      │
                    └────────────┬────────────┘
                                 │
         ┌───────────────┬───────┴───────┬───────────────┐
         ▼               ▼               ▼               ▼
   【范式 A: 视觉】  【范式 B: 悬浮】  【范式 C: 遥测】  【范式 D: 数据】
    样式/换肤/动效    挂件/桌宠/HUD     用量/拦截/声音    模型/账号/配额
```

### 范式 A：视觉与样式增强（Visual & Styles）
- **典型代表**：`acrylic-window`（窗口毛玻璃）、`qcard-fade`（提问卡淡出）。
- **标准实现路径**：
  1. 使用 `ctx.ui.injectStyle(id, css)` 注入样式表；
  2. 结合 `ctx.settings.onChange` 动态更新 CSS 变量（如 `--zmod-opacity: ...`）；
  3. 窗口级材质通过 `ctx.invoke('window.setMaterial', ...)` 驱动。
- **踩坑红线**：
  - ❌ 严禁直接改写客户端 asar 内部的 bundle 文件；
  - ❌ 严禁使用未命名的裸全局类名，选择器必须带作用域。

### 范式 B：桌面悬浮挂件与独立 HUD（Floating HUD & Widgets）
- **典型代表**：`whale-widget`（小鲸鱼桌宠）、`bubble-hud`（全局气泡）。
- **标准实现路径**：
  1. 挂件 DOM 统一挂载在全局单例 Portal：`#zmod-mount-portal`；
  2. 容器默认 `pointer-events: none`，仅可交互的子按钮声明 `pointer-events: auto`；
  3. 数据采集走只读 SQLite（如 `tasks-index.sqlite`）或主进程 RPC。
- **踩坑红线**：
  - ❌ 严禁把 DOM 强行 `appendChild` 到 React `#root` 内部（会导致官方 UI 死循环冲刷或白屏）；
  - ❌ 严禁在浏览器端加载本地 `file://` 媒体，一律使用内联 SVG、Base64 或 `zmod-local://` 协议。

### 范式 C：数据流与事件拦截（Telemetry & Event Tap）
- **典型代表**：`usage-stats`（Token 计费与用量统计）、`notification-sounds`（通知音拦截）。
- **标准实现路径**：
  1. 主进程端统一拦截 IPC 通道：`ipcMain._invokeHandlers.get('zcode:report-telemetry-event')`；
  2. 将事件广播至渲染端总线：`win.webContents.send('zmod:telemetry-event', payload)`；
  3. 渲染端通过 `ctx.events.on` 消费清洗后的结构化数据。
- **踩坑红线**：
  - ❌ 严禁试图在前端 monkey-patch 被 contextBridge 冻结的 `window.zcode` 对象；
  - ❌ 计费价表必须做模型分桶与 USD/CNY 安全换算，防除零错误。

### 范式 D：账号与第三方数据源（Datasources & Providers）
- **典型代表**：`official-providers`（百炼/DeepSeek/官方模型）、`quota-popover`（余额卡片）。
- **标准实现路径**：
  1. 在 `manifest.json` 中声明 `"permissions": ["datasource"]`；
  2. 使用通用 JSON 引擎注册 Provider 预设；
  3. 密钥与 Token 统一注入 Vault。
- **踩坑红线**：
  - ❌ 严禁自建本地 HTTP 独立服务器转接网络；
  - ❌ 多模型结构化数据必须通过 spread 完整透传，禁止丢弃未识别字段。

---

## 三、 生命周期与资源自洁铁律（Cleanup Protocol）

插件在设置面板中被用户随手切换是日常操作，必须做到**100% 干净卸载，零内存泄露**。

### 1. 使用 `ctx.cleanup(fn)` 自动清理栈
插件在 `start(ctx)` 中产生的任何持续性副作用，必须立即向 `ctx.cleanup` 注册撤销回调：

```javascript
export default definePlugin({
  id: 'my-clock',
  name: '时钟插件',
  version: '1.0.0',
  async start(ctx) {
    // 1. 定时器清理
    const timer = setInterval(() => updateTime(), 1000);
    ctx.cleanup(() => clearInterval(timer));

    // 2. 全局 DOM 事件监听清理
    const onKey = (e) => { ... };
    window.addEventListener('keydown', onKey);
    ctx.cleanup(() => window.removeEventListener('keydown', onKey));

    // 3. 挂载的 DOM 节点清理
    const el = document.createElement('div');
    document.querySelector('#zmod-mount-portal')?.appendChild(el);
    ctx.cleanup(() => el.remove());
  }
});
```

### 2. 停用行为契约
当插件被用户从设置面板关闭或执行热重载时：
1. 内核自动按 **后进先出（LIFO）** 执行全部 `ctx.cleanup` 回调；
2. 自动移除由 `ctx.ui.injectStyle` 注入的全部样式；
3. 自动撤销 `ctx.patcher` 注入的全部 AOP 钩子；
4. 随后调用 `stop(ctx)` 完成收尾。

---

## 四、 AI 开发者执行守则（AI Coding Directive）

任何 AI 编程智能体在接到“编写新 ZMod 插件”或“修改现有插件”任务时，必须严格遵守以下执行流：

1. **先选范式**：在规划阶段必须明确声明：「本项目属于范式 [A/B/C/D]，将参考 [对应参考插件] 的成熟实现」；
2. **严禁逆向客户端**：严禁去执行解包 `app.asar`、静态分析混淆 bundle 或扫描客户端内部未公开 API；
3. **设置项声明化**：严禁编写任何自定义的设置界面代码，必须严格采用 `settings` schema 声明；
4. **单次重载验收**：插件代码落盘至 `<数据目录>/plugins/<id>/` 后，直接提示用户或由用户在客户端按 **`Ctrl+R`** 完成验收。
