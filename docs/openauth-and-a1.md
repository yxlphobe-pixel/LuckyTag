# OpenAuth 与钉 A1 接入边界

OpenAuth 是一个可选的组织统一身份连接器。它负责 IAM 身份状态；DWS 继续负责消息，语雀 CLI 继续负责知识同步，三条登录态相互独立。连接器二进制、服务端实现、凭据与访问权限都不随 LuckyTag 分发。

## 当前 OpenAuth 实现

Electron 主进程以 `execFile`、固定参数数组和 `shell: false` 调用：

```text
openauth status --json
openauth login --yes --json
openauth logout --json
```

登录流程由 CLI 自己管理浏览器会话。LuckyTag 只等待有界结果，不接收自定义 callback URL，也不代理用户凭据；超时或取消后会回收它启动的子进程。

适配器把“未登录”与“CLI 不可用/协议异常”分开处理，避免把正常登出状态误报为本机故障。

## 凭证与 IPC 边界

凭证由组织提供的 CLI 管理。LuckyTag 不读取、复制、记录或展示其凭证文件，也不会请求输出可复用的身份票据。

Renderer 只能收到以下白名单身份投影：

```ts
interface OpenAuthSessionView {
  authenticated: boolean
  displayName?: string
  employeeNumber?: string
  subject?: string
  expiresAt?: string
  refreshExpiresAt?: string
}
```

Renderer 只能发起无参数的“连接 OpenAuth”或“断开 OpenAuth”。它不能传入 token、ticket、audience、scope、callback URL 或任意内部 operation。生产子进程会删除继承环境中的票据变量，防止非交互凭据绕过预期的登录边界。

## 状态与错误

- 有效 IAM 身份：`connected`，界面只展示姓名、工号和安全的到期时间。
- 官方返回未登录：`disconnected`。
- 登录取消、超时或网络失败：`disconnected`，提示重试或检查所需组织网络。
- CLI 不存在、JSON 契约异常或无法验证本地状态：`unavailable`，默认拒绝。

`openauth logout --json` 会删除 IAM token 和全部 OpenAuth skill session，因此界面必须
二次确认。退出 OpenAuth 不会修改 DWS 或当前语雀 CLI 的独立凭证。

## 安装约束

OpenAuth CLI 必须从使用者所在组织批准的分发渠道安装。LuckyTag 不下载、不更新、不捆绑该 CLI，也不会绕过系统或组织的签名、网络与权限策略。若多个包注册同名可执行文件，应使用明确且经过验证的入口，避免 PATH 冲突或二进制替换。

## 钉 A1

钉 A1 仍只作为未来显式配对后的 step-up authentication 或挑战签名设备。设备在线
不能自动提升账号权限。OpenAuth 的 `local-file` 模式可作为未来本地硬件身份 broker
的候选接口，但一期不会自动启用或写入这类配置。

正式接入 A1 前必须核验：设备发现协议、用户确认界面、设备证明链、固件/型号约束、
nonce 防重放、签名算法、密钥不可导出保证、撤销/丢失流程和审计要求。
