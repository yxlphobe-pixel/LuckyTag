# Contributing to LuckyTag

感谢你帮助改进 LuckyTag。项目优先接受可验证、默认安全、不会扩大本机数据访问面的变更。

## 开始之前

- Bug 与小型修复可以直接提交 Issue 或 Pull Request。
- 新连接器、持久化格式、真实发送能力和安全边界变更，请先通过 Issue 说明威胁模型、失败策略和迁移方案。
- 不要在 Issue、日志、截图、测试夹具或提交中包含真实 API Key、登录票据、员工资料、群 ID、聊天原文或私有知识文档。
- 安全漏洞请按 [SECURITY.md](./SECURITY.md) 私下报告，不要创建公开 Issue。

## 本地开发

需要 macOS、Node.js 22.12+ 与 pnpm 10：

```bash
pnpm install --frozen-lockfile
pnpm security:scan
pnpm security:audit
pnpm typecheck
pnpm test
pnpm build
```

真实 Runtime 端到端测试默认跳过，必须显式运行对应脚本。测试必须使用回环假 Provider、假凭据与隔离数据目录；不得在自动化回归中调用真实模型、发送真实消息或改变真实登录态。

## Pull Request 要求

1. 保持变更聚焦，并为行为变化添加测试。
2. 说明用户影响、安全边界、迁移方案和验证命令。
3. 新增外部进程必须使用固定 argv、`shell: false`、有界输出、超时和退出回收。
4. 新增凭据必须使用系统安全存储；不得落入配置、SQLite、日志、argv 或页面快照。
5. 新增网络目标必须说明协议、认证、TLS、重试、超时、数据最小化和 SSRF 防护。
6. 更新 README 或架构文档，明确“已实现”与“路线图”。

提交即表示你同意按照 [Apache License 2.0](./LICENSE) 授权该贡献。
