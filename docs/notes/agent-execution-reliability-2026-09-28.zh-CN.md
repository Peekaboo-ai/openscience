# 模型消息、远端执行与无进展循环修复

## 已验证的问题

- 远端历史会话 `ses_f1c5c87edffeuXJ2daaH5d8qcD` 保存了完整用户任务，但回复与任务无关。早期探测出现“流式问候、非流式正确标记”的差异，但后续真实远端验收和直接 HTTP 请求证明非流式及 Responses 路径也会返回无关问候，故不能将非流式视为此接口的可靠修复。不能靠回答文本猜测错误并反复付费重试。
- R 任务 `ses_f2deb2423ffebYvvH8WMigyH8m` 有 35 个工具调用，包含重复运行时搜索、模块加载与网络探测。历史记录已证明命名环境中存在 R。远端登录进程及 workspace-bridge 都保留 MODULEPATH，而工具进程的环境过滤漏掉了它。
- Bash 的非零退出码仅在 metadata 中，模型消息转换只读 output；无输出的失败无法可靠区分于成功。

## 来源与适配边界

| 对照源码 | 本次采用的机制 |
| --- | --- |
| OpenScience 的 `openscience/index.ts`、`tool/bash.ts`、`session/message-v2.ts` | 保留现有环境隔离和工具结果契约，修复运行时变量遗漏及失败状态不可见；不更换科研运行时或 Terminal/Timeline 数据结构。 |
| ZCode `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`，`core/src/runtime/helpers/model-anomaly.ts` | 改编 stableJson，消除参数对象键顺序对重复检测的影响；保留数组顺序。归属见 NOTICE。 |
| ZCode `core/src/tool/handlers/bash-output.ts` | 参考显式退出码、信号和标准流反馈，在本项目文本工具结果中附带非零退出状态。 |
| ZCode `adapters/src/model/runner-options.ts`、`reasoning-history-normalization.ts` | 对照生成/流式共用消息与推理历史契约；使用现有 SDK 中间件，不自行重写 SSE 或盲目复制跨协议的签名推理。 |
| OpenCode `b471c2b4495747353af768fbf2e0790c9d820ce2`，`session/processor.ts` | 保留执行前 doom-loop 权限门；与科研会话原有 epoch、持久记录及取消逻辑衔接。 |
| OpenAI4S `cfd297feca1517f57409842df3462252e5784dcc`，`agent/progress_circuit.py` | 相同行动且结果不变才视为停滞；按外部用户任务划分窗口，结果变化即有进展。额外覆盖长度 2/3 的短周期循环。 |

## 通用行为

1. 环境变量采用精确的非秘密运行时白名单，适用于 Conda、Modules/Lmod、ROCm/CUDA 和常见调度器；无这些变量的普通主机无需配置。不会透传 BASH_ENV、导出 shell 函数、SLURM_JWT 或任意同前缀密钥，也不会关闭沙箱或扩大文件系统授权。
2. Bash 非零退出附加机器可读性稳定的状态文本，原始 stdout/stderr、产物、溯源和 metadata 保留。非零退出不是无条件抛异常，例如 grep 的退出码仍由调用方解释。
3. 重复检测不含环境名、科学任务、模型或供应商特例。三次相同行动和结果触发 guard；已有 harness 允许一次有界调整，再次停滞时暂停。新用户任务重置窗口，变化中的轮询不触发此结果检测。原有执行前权限检查仍独立生效。
4. 自定义模型只继承精确目录匹配的推理能力，未知别名不猜档位。用户选定的推理强度覆盖合法目录默认值。
5. `provider.options.streaming: false` 是显式连接级兼容选项，使用 AI SDK simulateStreamingMiddleware/wrapLanguageModel 保留工具、usage、取消和错误。默认继续流式，不自动根据问候语重试，也不按域名分支。非流式文字需等完整响应，因此并不承诺降低供应商本身的推理延迟。
6. Conda 工具说明推荐直接执行命名环境中的程序，避免内嵌登录 shell 重置 PATH。运行时错误、真实网络限制和不可用的沙箱应如实返回，不能伪造成已完成科研任务。

## 验证范围

覆盖真实 SDK 请求/工具往返/取消/401、推理强度序列化、环境过滤与凭据排除、Bash 失败及溯源、跨任务重复隔离、变化轮询、短周期循环，以及实际会话中的执行前拒绝和批准后停滞终止。远端验收另使用独立诊断会话，不修改用户既有科研任务或降低其权限。

## 远端验收结论与未闭环项

- 已部署远端后端 `0.0.0-dev-202609271714`，SHA-256 为 `573948cb44406614a92d6b41b91869691d259e1030e496e65a949e878748d372`；本地服务端口 4106。
- 独立验收会话 `ses_f1c11b4b4ffeCFWqhzRyj0CAnP` 的 xhigh 指令仍收到 “How can I help with your Bio project?”。此结果不算验收通过。
- 完整 research harness 的真实 HTTP 请求回归测试证明，用户任务与 xhigh 没有在本项目消息组装/SDK 传输边界丢失。直接绕过本项目调用当前接口，同样可得到无关问候；Responses 探测也未解决。需要与用户在 ZCode/OpenCode 中成功运行的 API URL、模型 ID、协议进行同条件对照。
- 已删除本次诊断为两个连接临时设置的 `options.streaming: false`，恢复默认流式。保留通用显式兼容选项的实现，但不把它描述为当前接口的修复。本机可读 ZCode 配置为 GLM/DeepSeek，OpenCode 配置为 DeepSeek，未找到用户所述成功运行当前模型的对应连接。
- 远端 Bio 项目当前策略为 approve、强制沙箱，实际检测结果为 `spawnSync /usr/bin/bwrap ETIMEDOUT`。沙箱仍保持开启；未以宿主执行代替应用工具验收。
- 额外 Terminal/Timeline 回归中，Timeline、PTY 环境与回放测试通过。Windows 实际 PTY 的 model-terminal 集成测试在 shell 启动阶段未通过，不能据此声称 Terminal 已全面验收。远程取消/订阅者隔离测试的 pending-rejection 断言改成等待真实 I/O 后断言，远端协议 9 项测试通过。
