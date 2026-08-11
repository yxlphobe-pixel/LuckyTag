# 测试与发布门禁

LuckyTag 的测试重点不是只验证“成功返回”，而是证明本机进程、凭据、发送状态与升级路径在失败时保持安全。

## 默认回归

```bash
pnpm install --frozen-lockfile
pnpm security:scan
pnpm security:audit
pnpm typecheck
pnpm test
pnpm build
```

默认套件覆盖：

- 配置 schema、迁移、严格输入校验与 Renderer 脱敏投影；
- Electron 自定义协议、IPC sender、原生确认和文件夹授权边界；
- UDS 鉴权、协议/构建握手、SSE、超时与 Daemon 升级；
- SQLite WAL、事务回滚、旧 JSON 迁移、Outbox 租约与保留策略；
- DWS、语雀、OpenAuth 和 Dima 适配器的参数、分页、超时与错误归类；
- 首跑水位、群白名单、dry-run、撤回、人工接管、限流与幂等发送；
- Agent 配置、Keychain scope、Runtime 供应链校验和进程组回收；
- Renderer 关键结构与响应式 CSS 契约。

测试使用临时目录、Fake CLI 和去标识化夹具。它们不得读取真实聊天、知识库、Keychain 凭据或登录态。

## 显式端到端测试

以下测试默认跳过，只有开发者主动执行时才运行：

```bash
pnpm test:metric-layout:e2e
pnpm test:claude:e2e
pnpm test:codex:runtime:e2e
pnpm test:byok:e2e
```

- UI 布局 E2E 使用真实 Electron 渲染器，验证不同窗口宽度和缩放比例下的单行、截断与无溢出约束。
- Runtime/BYOK E2E 使用真实受信 CLI，但 Provider 固定为 `127.0.0.1` 假服务并使用假 Key；不得连接公网模型或产生费用。
- 真实 CLI 不存在或供应链摘要不匹配时，测试必须明确失败或跳过，不能回退到 `PATH` 中的同名程序。

## macOS 包验证

```bash
pnpm package:mac
```

该命令构建 Apple Silicon 开发目录包，并检查：

- Daemon sidecar 及其 Node 运行时存在；
- UDS 鉴权和权限收敛可用；
- Electron Fuses 与预期安全策略一致；
- 包结构、签名完整性与关键资源可读取。

仓库生成的是开发验证包。正式发布还需要 Developer ID、Hardened Runtime、公证、更新签名链和独立的发布流水线。

## 禁止进入自动化的真实操作

- 向真实群聊发送消息；
- 创建真实工作项；
- 登录或退出真实组织身份；
- 使用真实 API Key 调用收费模型；
- 把用户聊天、知识文档、群 ID 或身份信息写入 fixture。

需要验证这些路径时，应使用专用测试账号、测试群、最小权限知识源和独立数据目录，并在不可逆操作发生前取得明确授权。
