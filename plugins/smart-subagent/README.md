# 子代理智能模型路由 (Smart Subagent Router)

ZMod 官方生产力插件。解决 ZCode 原生子代理（Agent 工具）只能硬编码特定模型或完全继承父模型的痛点，实现**“根据当前会话订阅源自动动态匹配轻量 Flash 模型”**。

## 🌟 核心特性

- **订阅源自适应（Provider-Aware）**：自动感知主会话当前的提供商通道，子代理始终在同一个提供商/账号内派发，绝不跨源扣费或越权。
- **同源轻量降级（Flash Tier Mapping）**：
  - **Google Gemini**：`gemini-2.5-pro` $\rightarrow$ 自动选用 `gemini-2.5-flash`
  - **Anthropic Claude**：`claude-3-7-sonnet` / `opus` $\rightarrow$ 自动选用 `claude-3-5-haiku`
  - **OpenAI**：`gpt-4o` / `o1` $\rightarrow$ 自动选用 `gpt-4o-mini`
  - **阿里百炼 (DashScope)**：`qwen-max` / `qwen-plus` $\rightarrow$ 自动选用 `qwen-turbo`
  - **智谱 GLM (BigModel)**：`GLM-5.3` $\rightarrow$ 自动选用 `GLM-5.3-Flash`
  - **DeepSeek**：`deepseek-reasoner` (R1) $\rightarrow$ 自动选用 `deepseek-chat` (V3)
- **探路代理极速优化**：读代码、搜文件的只读探路子代理（`Explore`）默认强制走 Flash，并发更快、延迟极低。
- **思考预算自动优化**：子代理自动将 `reasoningLevel` 降为 `low`，避免在检索任务中空耗大量思维链 Token。
- **启发式与安全兜底**：
  - 对第三方网关（OneAPI / NewAPI / SiliconFlow 等）自动按名称启发式替换 `pro` $\rightarrow$ `flash`、`max` $\rightarrow$ `turbo`；
  - 遇到完全未知的模型时，严格在同 Provider 内部原地继承主会话模型，保证 100% 连通与鉴权有效。
- **自定义规则扩展**：支持在设置面板中通过 JSON 直接配置专有网关的映射映射。

## ⚙️ 安装与启用

1. 在 ZMod 插件管理器中搜索并安装 `smart-subagent`（或通过 Release 下载 zip 离线导入）；
2. 开启插件，无需重启客户端即刻生效；
3. 在设置页可以按需微调开关或自定义 Provider 映射规则。
