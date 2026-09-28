# Bio 执行失败与无关回复复核

这是对 `agent-execution-reliability-2026-09-28.zh-CN.md` 初次验收的后续复核。沙箱问题已按用户授权处理。用户补充的成功 ZCode 会话随后证明两者 API 协议不同；下文保留早期探测记录，最新结论见“ZCode 成功会话对照”。

## 用户会话与执行根因

- GEO 会话：`ses_f1a5c9c4affeOAPcNVcDtJVhOv`。
- CNCB-NGDC 会话：`ses_f1a54b923ffeqGL2cFJmR1hD2T`。
- GEO 会话的 Bash、Python 内核、local compute job 均在执行前被 `ExecutionAuthority.DeniedError` 拒绝，原因为 `spawnSync /usr/bin/bwrap ETIMEDOUT`；并非 R 安装缺失或 R 脚本报错。
- 通过独立 SSH 运行 bubblewrap 的最小 `/usr/bin/true` 隔离探测，同样在 12 秒期限后退出 124。服务器的 bubblewrap 为 0.4.0；发现可执行文件不代表内核隔离可用。未改变服务器内核设置或安装系统软件。
- 用户明确授权仅远端 Bio 持续使用 Full access。通过项目 access API 更新，没有修改全局沙箱策略或其他项目。Bio 的 `sandbox.enabled` 为 false。
- 应用 Shell 通道验收会话 `ses_f1a485035ffeMx0xmB6U5gC88L` 返回工作目录 `/public/home/zzugaozhan/Bio`、onezone 的 Rscript 4.4.3、完整 MODULEPATH 与 `/opt/gridview/slurm/bin/sinfo`。该次登录 Shell 初始化及执行总计约 57 秒；HTTP 调用先超时，后续读取持久会话确认执行完成，不能把 HTTP 超时误记为命令失败，也不能据此宣称启动延迟已解决。

## 通用代码修复

原处理器只把逐次工具许可的拒绝视为停止条件。执行权威层的拒绝被当作普通工具错误，模型可以在 Bash、Python、compute_job 和子任务之间轮流尝试。

部署后复核发现另一个直接 Shell 通道问题：带 20 秒外部期限的 Conda 包装命令只留下先前标记输出，没有 R 版本；旧通道未记录退出码。现已在直接 Shell 的 metadata 和模型可见文本中保留非零退出/信号，成功输出保持原样。该次 Conda 探测不计为成功，不宣称已解决所有远端启动延迟。

现在直接识别结构化的 `ExecutionAuthority.DeniedError`：第一处拒绝即阻止进入下一轮模型调用，等待本轮已启动的工具收尾，保留它们的产物和失败记录，并向会话呈现真实错误。不会通过匹配报错文字猜测，也不会把普通非零退出或可恢复工具错误升级为项目权限故障。未增加自动解除沙箱、自动信任或自动放宽权限的路径。

对照 OpenCode `packages/opencode/src/session/processor.ts` 的权限拒绝停止逻辑及 OpenScience 已有 outcome coordinator，保留其执行前授权与执行结果收尾边界。ZCode 的 `core/src/runtime/helpers/model-anomaly.ts` 和 `turn-tool-warnings.ts` 提供的是重复提醒；确定的执行策略拒绝不应进入普通重复提醒的重试流程。

## 无关问候：独立 HTTP 复现

使用 Bio 配置的同一凭据，在本机直接请求 `https://api.quya.org/v1` 的 `gpt-5.6-sol`，绕过 Onelab 的消息组装、插件、压缩、工具、前端和远端代理。测试内容只有随机标记与算术，不包含科研文件或私有会话。凭据仅在内存中使用，未写入本报告或诊断输出。

14 次有限探测中，3 次返回正确标记，11 次返回与请求无关的问候。覆盖 Chat Completions 字符串/文本数组、流式/非流式，以及 Responses。初始“文本数组可能有效”的假设被后续重复试验推翻，因此没有据此改写正式请求或自动切换 API 协议。

可复核示例：

| 协议                          | 唯一指令                       | 实际返回                           | 上游响应 ID                                               |
| ----------------------------- | ------------------------------ | ---------------------------------- | --------------------------------------------------------- |
| Chat Completions              | 输出 `db90d905:543`（217+326） | Hi Elizabeth—how can I help?       | `resp_01be191231c71491016ab9c750d49c87d1803bc1e6f63c323c` |
| Chat Completions 文本数组     | 输出 `7a037039:543`            | `7a037039:543`                     | `resp_0b3dac7d47612a10016ab9c754398c87d1bf664a65a0ac794d` |
| Responses，store=false，xhigh | 输出 `89374a88:543`            | Hi Jennifer! How can I help today? | `resp_0167d4815037d887016ab9c93893b487d19d9f019908ac2afa` |
| Responses，store=false，xhigh | 输出 `6ae0d832:543`            | Hi Michael—how can I help?         | `resp_00886fe632aa6944016ab9c93c938c87d1a959437bf6ee92ff` |

一个正确的短请求被报告为 24 个输入 token，错误请求则多次被报告为 17627 或 17643 个输入 token。这里只记录供应商返回的统计，无法从客户端证明其内部如何路由、注入上下文或计算用量。

最小复现请求（凭据通过调用者自己的 Authorization 请求头提供）：

```json
{
  "model": "gpt-5.6-sol",
  "stream": false,
  "messages": [{ "role": "user", "content": "Compute 217 + 326 and reply with exactly 'TEST_NONCE:543'." }]
}
```

结论仅限于当前网关/凭据/路由链路无法可靠遵循请求，不能外推为所有同名模型或所有第三方网关都有问题。客户端不能修复网关返回的、HTTP 200 且结构合法的任意错误答案。也没有根据问候语强制重试、伪造任务完成或擅自更换模型；那会掩盖上游问题并产生额外费用。

这些早期探测没有覆盖成功 ZCode 会话的 Anthropic Messages 协议，因此不足以判断同一供应商的所有接口都不可用，也不足以排除客户端配置能力缺失。用户随后提供了可核对的成功会话，见下文。

## ZCode 成功会话对照

远端 `~/.zcode/cli/db/db.sqlite` 及对应 model-io rollout 确认，用户提供的 `sess_c1d1064c-2820-485c-974b-f353de91272d` 使用模型 `gpt-5.6-sol`、`xhigh` 和云桥供应商。读取 `~/.zcode/v2/provider_config.json` 后，在内存中比较凭据，确认与 Bio 配置的 API Key 完全相同，没有输出或保存凭据副本。

关键差异：ZCode 使用 `anthropic-messages`（`/v1/messages`），请求包含 `thinking: {type: "adaptive"}`、`output_config: {effort: "xhigh"}`。Onelab 的自定义连接保存逻辑此前固定写入 `@ai-sdk/openai-compatible`，只能发送 Chat Completions。模型名称、供应商与推理档位相同并不意味着协议相同。

对照源码为 ZCode `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`（328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f）：按显式 API 格式选择 SDK；Anthropic 兼容认证同时支持 Bearer 和 x-api-key，并保留显式认证头优先级。Onelab 现在提供三个显式协议、可选 adaptive thinking、对应的模型发现认证、SDK 序列化和协议可表达的推理档位。没有按域名、特定提示词或回复字符串进行自动切换/重试。

新一轮短请求：从 SCNet 直接探测的三个请求均返回 HTTP 429；随后本机使用相同凭据和同一协议参数，两次 Messages 请求分别正确返回 `563c46d7:543`、`448cc371:543`，夹在其中的 Chat 请求也正确返回 `491ed6fe:543`。Messages 响应 ID 分别为 `resp_07eda26f34648c77016ab9db48cd8887d1bf2a9300ddee3e0f`、`resp_09771ff936843af0016ab9db5668b087d18f659b52521ba637`。这些结果证明该接口可以正确工作，但样本不足以声称网关永不间歇失败，更不能把此前 11 次异常都确定归因于协议。

成功 ZCode 会话确实没有无关问候，但它最终因安装 R 未获授权而停止，并未完成分析产物。这与“保持任务相关”是不同的验收维度。

新增本地回归覆盖真实 SDK 的三个协议路由、双认证头、编辑后协议保留、换协议清除不兼容选项、项目实例不销毁，以及真实 research harness 的中文任务、流式工具调用/结果、追加消息和 xhigh。SDK/OpenAPI 已重新生成；Windows 上生成脚本最后的直接 shebang 格式化调用失败，改为显式执行已修改文件的 Prettier，生成本身成功。

### 新版远端验收

- 远端制品 `0.0.0-dev-202609280318`，SHA-256 `3bd132552415a14c6507b7a6b305496291a64cd8882c41578cada1097687fb81`，上传后远端哈希验证通过。Bio 健康接口确认加载该版本。
- Bio 的现有 YunQiao 连接已改为 `anthropic-messages` 与 `adaptive`，供应商 ID、模型列表、API Key 和用户数据保留；其他连接未自动迁移。会话仍显式选择 `gpt-5.6-sol / xhigh`。
- 实际验收会话 `ses_f19f52549ffeqiKst1QbotHEe9`：输入包含 onezone、R、GSE2034、火山图/热图及真实数据范围要求，并明确本次仅验证、不得下载/安装/申请节点。模型准确中文概述任务，只调用一次 Bash `printf`，在远端 `/public/home/zzugaozhan/Bio` 返回 `ONELAB_PROTOCOL_8342`、exit 0，执行进度约 4.8 秒（完整工具记录约 5.2 秒）。后续模型正确报告结果和计划，没有无关问候。
- 第二轮要求不用工具、回忆命令输出/数据集/产物状态，模型正确回答标记、GSE2034、尚未生成图，并保留 `FOLLOWUP_5271`。验收后 session/status 为空。
- 这验证了远端实际研究 harness 的上下文与工具往返，没有宣称完成完整 GEO 数据分析，也不能保证任意网关永不返回语义错误。
- 当前累计 165 项定向回归通过：协议/会话/流式兼容 15 项，参数转换及自定义推理 150 项；前后端类型检查与前端构建通过。
- 浏览器验收发现通用 Select 的浮层不属于设置对话框的可访问区域，改用现有设置专用 FilterMenu，使菜单挂载在同一对话框内。实际 Edge 自动化确认可选择 Messages、adaptive，再切换 Responses 并隐藏不适用的 thinking 设置；沿用原字体与主题样式，没有重载页面或保存测试凭据。

## 回归范围

- 本地 39 项定向回归全部通过（执行循环/工具结果 24、消息与传输 6、执行权威/安全边界及 Shell 退出状态 9），后端类型检查通过。
- 本地 4106 已重启；最终远端制品 `0.0.0-dev-202609280209` 的 SHA-256 为 `de201a734443c95e8535cdd9e057b953d77f3dd21369e6e7e6ca3669859f1072`，通过上传后哈希校验。Bio 重连后仍为 Full access。
- 最终版本通过应用 Shell 通道直接执行已确认的 onezone `bin/Rscript --version`，约 17.8 秒返回 R 4.4.3、`exit: 0`、`signal: null`。没有安装软件或修改科研数据；该绝对路径仅用于本次验收，没有硬编码进产品。
- 真正运行 research harness 和 HTTP SDK：中文原任务、多轮追加消息及 xhigh 在流式/非流式请求中均保留。
- 工具结果往返、取消与 401 不被盲目重试。
- 不可用沙箱的第一次 Shell 拒绝后停止，没有第二次模型工具调用。
- 既有重复循环和 outcome coordinator 的成功/失败/并行收尾语义保留。
- 回归中修复一处测试夹具：实际 Shell 测试显式授权其隔离测试项目执行，并在启动失败时传播错误，避免永远等待一个不会产生的进度事件。没有变更产品的沙箱授权边界。
