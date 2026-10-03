# Bio 模型请求拒绝审计

日期：2026-10-03。范围：Bio 远端会话中反复出现的 `The request was rejected`。

## 错误来源

截图对应会话为 `ses_f04288722ffez1PJjv4Jm13Nzk`。失败记录是模型推理请求产生的 `APIError`，HTTP 状态为 400，实际请求地址为 `https://api.quya.org/v1/messages`，供应商为自定义 YunQiao 连接。前端将 400/422 显示为 `The request was rejected`，与记录的错误一致。

Bio 原先使用 `@ai-sdk/anthropic` 将 GPT 模型通过 Messages 协议发送到该网关，启用了 adaptive thinking。会话及验收中存在三种拒绝：

| 错误 | 证据 |
| --- | --- |
| `synthetic previous_response_id is unavailable or expired` | 网关明确说明其合成的上游响应引用不可用或过期。 |
| `The request could not be processed. Please check the request parameters.` | 网关只给出通用 `invalid_request_error`，没有具体参数、错误码或内部原因。 |
| `previous_response_id is not available for this user` | 实际远端多轮验收返回的 `api_error`，进一步说明上游续接引用与账号归属存在问题。 |

最近两次通用拒绝的网关请求标识为 `ea4c2133-5674-4c4c-bd30-11dd060d621d` 和 `4a4a0fc3-4622-4f9f-8098-d516a7a46ab1`。历史错误同时涉及 gpt-5.6-sol 和 gpt-6.1-sol；后者在多次成功工具调用之后也出现拒绝。

## 排查和对照

检查了会话序列化、模型切换、工具调用与结果配对、推理签名、模型参数合并、SDK 请求转换、网关错误保留和远端部署版本。

- 当前回合的推理签名非空，没有发现截图错误由缺少签名直接导致的证据。
- `/provider` 返回空 options/variants 是 `Provider.redact` 的主动脱敏行为，实际保存的 adaptive 配置没有丢失。
- 当前工具列表及其 schema 在成功与失败步骤的 harness 指纹相同，不能据此认定某一个科研工具参数必然错误。
- 保存的失败助手消息被 `MessageV2.toModelMessages` 排除，完成的工具结果仍保留。

受控请求使用原会话转换后的约 199 条消息、106 次历史工具调用。诊断系统提示、工具选择及部分工具定义与原科研请求存在差异，因此这些对照用于定位兼容行为，不声称精确重放了当时的完整请求。测试过程中没有执行模型生成的科研工具调用。

| 对照 | 结果 |
| --- | --- |
| 新请求 | 正常返回诊断标记。 |
| 原历史和签名，禁用工具选择 | 正常返回诊断标记。 |
| 原历史和签名，自动工具选择，简化工具定义 | 复现相同通用 HTTP 400。 |
| 去掉历史推理签名，保留工具 ID，自动工具选择 | 正常返回诊断标记。 |
| 保留签名，更新工具 ID 和配对结果 | HTTP 成功，返回工具调用；未执行。 |
| 原历史和真实工具 schema，自动选择，32,000 输出上限 | HTTP 成功，返回工具调用；未执行。 |
| 最新回合历史和真实工具 schema | 正常返回诊断标记。 |
| 使用新增生产代码，无状态历史，真实工具 schema，32,000 输出上限 | 6.35 秒正常返回诊断标记，未调用工具。 |

可以确认网关存在临时续接引用失效的问题，而且其拒绝具有状态相关和间歇性特征。通用 400 没有暴露网关内部原因，不能将其全部断言为同一种参数错误，也不能将所有 HTTP 400 自动归类为可重试错误。

进一步远端验收发现，仅清理客户端历史签名和工具 ID 仍不足：第一轮工具往返成功，第二轮返回 `previous_response_id is not available for this user`。这将故障进一步定位到网关的 Messages 到上游 Responses 续接层；客户端完整历史无法阻止该层再次使用其内部状态。工作台原配置让 GPT 的多轮执行依赖这一中转层，而既有明确过期恢复无法修复其账号关联问题。

参考源码：

- OpenCode `b471c2b4495747353af768fbf2e0790c9d820ce2` 的 provider transform、错误解析与请求适配。
- ZCode `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f` 的 reasoning-history-normalization、anthropic-stream-compat 和 reasoning metadata 保留逻辑。

两者均保留完成的工具结果，并对明确的签名错误做有限恢复。本次没有复制外部源码，也没有扩展成对通用 400 的无限重试。

## 最终修复

Bio 的 YunQiao 连接已通过现有模型连接 API 切换到 `openai-responses` 协议，连接 ID、模型 ID 和凭据继续沿用。对该网关已验证 Responses 接口确实支持当前模型、流式输出、工具往返和长历史。

- 使用 GPT 原生 Responses 请求，移除对 Messages 合成续接引用的依赖。
- 使用工作台既有的 `store: false` 完整历史路径，不发送 `previous_response_id`，移除输入 item 的存储 ID。
- 新的推理结果使用 `reasoning.encrypted_content` 保留无状态工具循环所需的推理数据，继续支持 xhigh 等强度选项。
- 原来通过 Messages 保存的完整工具历史也通过了 Responses 兼容验收，原会话可以继续使用。
- 实际科研任务没有被验收程序重新执行，临时验收会话已删除。

新增 `responses-context.test.ts` 覆盖真实 SessionPrompt、Provider 和 SDK 请求链，验证完整工具结果、加密推理及无状态参数，确保已完成工具不会因后续请求再次执行。

## Messages 兼容处理及边界

本次还增加了自定义 Messages 连接的显式设置：`provider.<connection-id>.options.anthropicContinuation = "stateless"`。该设置用于网关历史引用兼容；它在本次调查中通过了请求重建测试，但无法彻底解决 Bio 网关内部的账号归属错误，因此 Bio 的最终 Responses 配置不使用该设置。

- 发往网关的请求副本使用完整已保存历史，更新历史工具调用 ID 及其配对结果，去掉可能携带临时上游状态的 opaque thinking/redacted thinking 块。
- 继续保留用户请求、助手文本、工具名称、参数、完成结果、系统提示、工具 schema 和当前推理设置。
- 原始会话中的推理和工具 ID 不被修改，已完成工具不会因历史转换重新执行。
- 原生 Claude 模型保留签名；其他连接默认保持既有行为。
- 普通参数拒绝仍保留原始错误。已经开始输出的流不会自动重放；明确 synthetic 引用过期的既有恢复仍最多重试一次。
- 编辑同一地址、同一协议的连接时保留设置，改变地址或协议时清除。Bio 切换到 Responses 时已清除该设置。

该模式可能降低网关对历史工具前缀的缓存复用。它解决对不稳定临时续接状态的依赖，不承诺消除供应商独立产生的所有参数、限流或服务故障。

## 验证与部署

- 40 项针对性测试通过，包括实际 Messages/Responses SDK 和 research 会话流程，确认工具只执行一次、推理留存、原生 Claude 保留签名、连接编辑及普通拒绝行为。
- 后端 `tsgo --noEmit` 通过。
- 变更文件格式检查通过；文档检查通过，验证了 67 个页面、930 个链接、16 个 JSON 示例和 9 个 TypeScript 示例。
- Linux x64 baseline 后端构建成功，版本 `0.0.0-dev-20261003-stateless-history`。
- 上传 SHA-256：`e2b71c145726951ea3cef4ee804ba05c410bd4a77016b4293ebac5982a7cba7c`，远端校验一致。
- 切换前确认会话均空闲，唯一终端为没有子进程的 bash。Bio 已重连到新版本，原会话没有发送额外科研任务。
- 原会话历史转换为 229 个 Responses input 项，实际请求未发送 `previous_response_id`，正常返回诊断标记，没有调用工具。
- 原生 Responses 直接 SDK 验收连续三次请求成功，固定值测试工具只执行一次；保留加密推理，没有服务器续接引用。
- Bio 工作台完整请求链的三轮流式验收成功，耗时分别约 16.0、13.2、8.2 秒。第一轮创建待办，第二轮完成待办，第三轮未重复执行工具，错误数均为 0。
- 最终 Bio 使用 `openai-responses`，临时诊断会话已删除。历史失败记录保留，最终验收不会改写原始科研对话。
