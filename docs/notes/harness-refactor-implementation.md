# Harness migration implementation record

The accepted roadmap is [the September 24 audit](harness-refactor-roadmap-2026-09-24.zh-CN.md).
This record describes implementation contracts and verification, not a claim that all roadmap phases have shipped.

## Source provenance

Reference: ZCode `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f` (Apache-2.0).

| ZCode source                                                                                              | OpenScience adaptation                  | Contract                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`, `AsyncGateRegistry` (under `apps/zcode-cli`) | `backend/cli/src/runtime/admission.ts`  | FIFO admission, idempotent release; retain OpenScience cross-process file leases                                                |
| `packages/core/src/agent/turn-machine.ts:68` and `turn-state.ts`                                          | `backend/cli/src/session/controller.ts` | 借鉴显式转移约束，提取 OpenScience 现有取消/准备/等待者所有权。不是完整移植 ZCode TurnMachine，尚未拆出工具/权限/模型步骤状态机 |
| `packages/core/src/runtime/methods/turn-guide-drain.ts:13`                                                | `RuntimeRuns.settle` / `pendingPrompt`  | 迁移纯文本结束后仍须检查 guide 的行为；适配现有 MessageV2 transcript 和跨进程接收租约，不复制 ZCode 的上下文表示                |
| `packages/bootstrap/src/zcode-protocol-v4/cold-session-resume.ts:43`                                      | `SessionPrompt.resumeInterrupted`       | 借鉴 hydration 与执行分离边界；有 runtime 回执的会话不走原始 loop 自动恢复旁路                                                  |
| `packages/adapters/src/storage/session-store/repositories/session-inputs.ts`                              | **待实施：P2 输入账本**                 | 已审计 admitted/promoted 和事务边界；本批未复制 SQLite repository，也未实现 JSON transcript 的原子 promotion                    |

Only entries with implementation and passing behavioral tests are considered delivered. Remaining mappings are planned migration targets.

## Compatibility requirements

- Keep current message/part/call IDs, tool result shapes, plugin hook order, Timeline recovery and scientific execution history.
- User PTYs remain owned by their existing authority, not by model turns; no changes to PTY framing or resize protocol.
- Admission locks end before model/tool execution. A cancelled owner cannot release or cancel its successor.
- Public request validation remains strict. Internal scientific inputs do not grant new permissions.
- Runtime crash reconciliation and project warmup must not independently restart the same accepted command.
- Preserve file storage compatibility until a transactional-store PoC and filesystem capability tests justify migration.

## Baseline

Baseline commit: `4d1b85670a49e6190a87ba170df2cb95950811e1`. Bun 1.3.14.
The initial Windows run includes runtime, prompt cancellation, action timeline and PTY replay suites.
Existing failures include Windows temporary-directory EBUSY cleanup and runtime ownership/cancellation cases; final results and isolated reproductions must be recorded before claiming regression success.

## 本批实现范围

这是路线 P0/P1 的第一批落地，以及为统一入口必需的收尾与恢复保护，**不是 P0–P6 全部完成**。没有更换模型 SDK、系统提示、工具调度算法、科研数据库、PTY 协议或 Timeline 数据格式。

- `RuntimeAdmission` 直接改编 ZCode `AsyncGateRegistry` 的 FIFO promise 链与幂等 release；保留原文件租约路径，因此多个本地进程仍共享原有锁。来源和许可证保留在 `NOTICE`。
- `SessionController` 管理 preparing/running/completed/cancelled、精确 AbortSignal 和等待者；旧任务迟到取消不能影响后继任务。科研作业和 PTY 不属于该控制器。
- `RuntimeRuns.submit` 适配旧同步接口，仍返回最终 `MessageV2.WithParts`，使用与公开 runtime 相同的持久回执和幂等指纹。内部模型/agent/系统字段保留，公共 schema 不放宽。默认 agent 仍读取原项目配置。
- 普通根会话、展开为 prompt 的自定义命令、StudyDriver 和后台 Task 结果接入统一入口；后台结果保留 synthetic 标记。子任务继续归父回合控制。`noReply`、手动压缩/交接、shell、checkpoint 等操作仍保留专用路径，不能称作所有命令已全面迁移。
- `settle` 与接收/取消共享租约，在结束前检查尚未回答的新 prompt。忽略 compaction/continuation carrier；取消请求优先于引导续接。检查使用最新消息流，不重新读取整个长会话。
- 实例销毁等待本实例已登记的 runtime 任务收尾；模型任务不会主动销毁独立 PTY。
- 慢异步观察者不再占用控制路径。事件先持久化，订阅者仍按 sequence 同步被调用；异步传输由各自队列处理。这是 OpenScience 适配补强，不标作已移植 ZCode projection/replay 协议。
- Windows 进程所有权增加句柄存活检查：`OpenProcess/GetProcessTimes` 在进程退出后仍可能成功。此项是本项目的 Windows 兼容修正，不归因于 ZCode 代码。

## 测试及限制

初始基线：75 pass、6 fail、2 errors（81 tests）。主要失败为 Windows 句柄/临时目录清理、两例取消测试依赖不可用沙箱，以及退出进程仍被识别为 owner。

当前确定性用例包括 FIFO/重复释放/跨会话独立性、owner 替换、准备阶段取消、旧接口精确重试、纯文本收尾 guide、收尾取消、warmup 不复活已终结回执、慢观察者隔离。使用本地仿真 provider 和隔离数据目录，不访问付费模型或用户真实会话。

测试清理修正：关闭进程级科研 SQLite 缓存、等待日志 flush 和实例销毁；Windows 原生句柄延迟释放做有界重试，最终失败仍抛出。取消生命周期用例显式使用已有 `fullAccessExecution` 测试夹具，仅影响隔离测试配置并恢复；生产安全策略不改变。

- 控制层扩大回归：81 pass、1 skip、0 fail，403 assertions；Linux zombie 专属用例在 Windows 跳过。命令涵盖 `test/runtime`、controller、prompt-cancellation、process-identity、windows-job。
- 上述长批次通过时设置了 `OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`。未禁用的早期长批次出现 Bun 1.3.14 / `watcher.node` 原生崩溃，不能把隔离后的通过解释为文件监听器已验收。
- 旧 restart/resume 两例分别执行通过；组合执行出现后台 AI SDK `NoOutputGeneratedError`，仍需收敛测试收尾/后台流问题。
- 扩展科研回归中，真实本地沙箱作业和跟踪脚本因 Windows 无 OS sandbox backend 未通过；保留隔离策略，没有降低这些测试的安全要求。
- 广泛 slash-command/task 回归还暴露 Windows 路径断言、沙箱和高核数并发夹具超时，不能宣称整个仓库测试全绿。

后续验证结果在这里追加。后端没有编辑 `src/server`，公共协议没有变化，因此本批不生成 SDK。

## 最终补充验证

- 启用原生文件监听的 runtime 长批次最终通过：64 pass、0 fail（277 assertions）。早期原生崩溃保留作为压力测试关注项，不能由一次通过断言所有 native 场景均已解决。
- Timeline/Terminal 前端：26 pass、0 fail（94 assertions），覆盖分页控制器、投影、长行重排、回放尺寸、搜索和错误提示。
- 新增旧接口/收尾/销毁集成用例：5 pass、0 fail（34 assertions）；后端类型检查通过。
- 科研 driver/kill/store/study-tool：21 pass、0 fail（176 assertions）。追查清理失败发现并发首次访问会重复打开 SQLite、覆盖缓存并泄漏 WAL 句柄，现按 ZCode `ColdSessionResumeCoordinator.ensureResumed` 的 single-flight 模式共享初始化。科研 schema/数据不变。
- Windows 瞬时文件占用处理直接改编 `apps/zcode-cli/packages/adapters/src/storage/workspace-hook-trust-store.ts:505` 的 `renameWithRetry`，保留 `[50,100,200,400,800]` ms 有界退避；OpenScience 加入取消与租约预算，只在 Windows 启用。原子重命名不删除目标，`ENOSPC`/`ENOENT`/`EEXIST` 不重试，持续权限错误最终保留。
- 文件重试/租约/存储回归：29 pass、1 skip、2 fail；两例失败明确为 Windows 不支持测试中的 `SIGSTOP`，没有修改断言或安全策略来隐藏它们。科研真实 OS 沙箱、Linux 进程信号测试仍需 Linux 环境验收。
- 最后针对队列、文件重试、并发科研账本初始化的回归：16 pass、0 fail（72 assertions）；24 个并发首次访问后 WAL/SHM 正常关闭。高并发 Task 夹具以 60 秒测试预算单独运行通过（97 assertions），原子重命名不再因瞬时占用中断该次测试。格式检查、后端类型检查和 `git diff --check` 通过。

这些数字属于不同测试批次，部分用例重叠，不能相加充当独立用例总数。

## 下一阶段门禁

1. 收敛原生 watcher 长批次与后台流清理；补充真实 Linux/远端及 PTY 生命周期验证。
2. 在此基础上进行 P2 存储 PoC：确认本地与 NFS 的能力，明确账本和 transcript 的统一提交边界，再迁移 start/guide/queue。禁止只添加独立 JSON/SQLite 表便声称完成原子接收。
3. P3 完整状态机、P4 版本快照/投影/Timeline 增量、P5 工具协调、P6 安装包/远程混合版本灰度仍按路线执行。当前未构建新安装包、未重启用户应用、未推送仓库。
