# Claude Code 集成

## 当前可信基线

LuckyTag 当前只信任官方 npm 包 `@anthropic-ai/claude-code@2.1.112`：

- 包名：`@anthropic-ai/claude-code`
- 版本：`2.1.112`
- CLI：`cli.js`
- CLI SHA-256：`bc3358282800e3e99daa8e71ac5b7b1566bd0d7ca7eb94f714a7859365d3163f`
- `package.json` SHA-256：`56cd40fd6b7bb73da50ec9259805e3363150a5bc218b69d6dba5bd51a3f27cc0`
- npm `dist.integrity`：`sha512-9FUgJ0EOvILyhIqxFKNVliebiUjL68dwpEW3eGSSe0vkVDJ1c5qMDNWc22gW3zkD7zRAqtfQPSGv0t4vMM2DPA==`

LuckyTag 不会重签名 Claude Code、清除 quarantine 或绕过 Gatekeeper。当前集成使用 Anthropic 发布的固定 npm JavaScript 版本，并将包元数据与内容摘要作为向进程注入模型 Key 之前的信任门禁。上游参考：[GitHub 仓库](https://github.com/anthropics/claude-code)、[安装说明](https://code.claude.com/docs/en/setup)、[CLI 参考](https://code.claude.com/docs/en/cli-usage)、[Headless 模式](https://code.claude.com/docs/en/headless)。

安装：

```bash
npm install -g @anthropic-ai/claude-code@2.1.112
claude --version
```

预期版本为 `2.1.112 (Claude Code)`。Daemon 只检查受支持的明确 npm 安装位置；真正执行前会解析软链接，并校验包元数据、所有者、写权限和内容摘要。CLI 由 Daemon 自身的绝对 Node 解释器执行，不经过 `#!/usr/bin/env node` 的 PATH 解析；普通 `PATH` 中的同名 `claude` 或 `node` 都不会被信任。

## 两种配置模式

### 沿用 Runtime 默认配置

- 保留 Claude Code 自己的认证选择，不向进程注入模型 Key。
- 使用一次性 `0700` HOME 和工作目录，不转发项目目录或真实 `CLAUDE_CONFIG_DIR`。
- 不加载 user/project/local setting sources；工具列表与 MCP 配置为空，hooks 关闭，不保存会话。
- 固定版本不支持新版 `--safe-mode`，因此这里是参数与目录层的收敛，不应描述成 macOS 容器。

### 自定义模型

- Key 按 `runtime + Provider URL` 保存在 macOS Keychain。
- 用户保存时，Key 会短暂经过受信 IPC/UDS 的请求内存；持久化后无法从 Renderer 读回。
- 运行时使用 `--bare`，并仅通过进程环境注入 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_BASE_URL`；Key 不进入 argv、日志、SQLite 或页面快照。
- Provider 必须兼容 Anthropic Messages API。OpenAI-compatible MaaS URL 不能由 Claude Code 自动转换。

## 验证

```bash
pnpm exec vitest run tests/daemon/agent-runtime.test.ts
pnpm test:claude:e2e
pnpm test
pnpm typecheck
pnpm build
```

真实 CLI 端到端测试只连接 `127.0.0.1` 的假 Anthropic Messages 服务，使用假 Key，并断言请求、输出、进程退出和工作目录回收；不会请求公网模型，也不会产生模型费用。应用级验收还需在打包后的“应用配置”页面完成 Runtime 探测和一次本地 Provider 模型测试。

升级可信版本时必须同时更新版本、SHA-256、兼容参数与真实 CLI 端到端测试。任一项未同步时，LuckyTag 应保持不可用状态，而不是回退到未经验证的二进制。
