# Security Policy

LuckyTag 会接触本机知识、消息入口和模型凭据。安全问题请优先私下披露。

## 支持范围

项目当前处于早期预览阶段。安全修复仅保证进入最新的 `main`；尚未承诺长期维护旧版本。

## 私下报告漏洞

请在 GitHub 仓库的 **Security → Advisories → Report a vulnerability** 中提交私密报告：

<https://github.com/yxlphobe-pixel/LuckyTag/security/advisories/new>

请提供：

- 受影响版本或 commit；
- 可复现步骤与最小 PoC；
- 影响到的数据、权限或信任边界；
- 建议修复（如有）。

不要在公开 Issue 中粘贴真实凭据、身份信息、聊天原文、知识文档或可直接利用的细节。维护者会先确认收到，再根据影响协调修复与披露时间。

## 设计边界

- Renderer 使用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，并通过受限 Preload API 访问能力。
- Electron 与 Daemon 在 macOS 上通过权限收敛的 Unix Domain Socket 和安装级随机 Token 通信。
- 模型 Key 在保存请求期间短暂经过受信 IPC/UDS 内存通道；持久化到 macOS Keychain 后不可读回给 Renderer，不写入 SQLite、日志或进程参数。
- 外部 CLI 与 Agent 子进程默认 fail closed，并使用固定参数、收敛环境、独立工作目录、有界输出和超时回收。
- 这不是完整的 macOS 容器或虚拟机边界。启用第三方 Runtime 或 Provider 前，请自行评估其数据处理与供应链风险。

更完整的信任边界见 [架构文档](./docs/architecture.md)。
