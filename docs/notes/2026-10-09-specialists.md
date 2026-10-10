# Settings → Specialists

本轮新增专家管理页面、持久化注册表、运行时权限接入和 `/customize` 工作流。保留现有内置专家与项目配置能力。

## 用户流程

- Settings 的 Research 分组新增 Specialists。列表区分内置、自定义和配置文件专家，支持搜索、过滤、启停、编辑、复制、删除；内置专家的删除入口改为恢复默认。
- Add specialist → Write from scratch 支持名称、稳定 Agent ID、图标、颜色、描述、附加指令，以及 Skills / Connectors 的全部可用或指定列表模式。空列表表示不使用对应能力。
- Add specialist → Chat with OneLab 创建新会话并预填 `/customize Help me create a new specialist.`，等待用户发送。首页没有项目时使用工作台 task 路由，避免创建不可达会话。
- 配置文件定义的专家可以查看和复制，其原始定义继续由配置文件管理。
- 保存冲突时保留草稿，用户可选择重新加载。读取请求不会覆盖较新的写入结果，重复提交受到抑制。返回列表时保护未保存修改。

## 数据与运行时

注册表位于 `Global.Path.data/specialists.json`，使用当前服务的数据目录，因此兼容 Settings → Storage 的数据目录配置。每个 OneLab 服务器独立保存，同一服务器上的项目共享；本地和远端的注册表不会自动同步。

`backend/cli/src/specialist/` 分离 schema、repository、服务和运行时覆盖。存储使用 JsonStore 的文件租约、进程内锁、临时文件原子替换及 revision 校验。损坏 JSON、错误根类型和非法 profile 均拒绝覆盖。

新增 `/settings/specialists` 的 GET/POST，以及 `/:name` 的 PUT/PATCH/DELETE；`/catalog` 返回当前项目真实可用的 skills 和已配置连接器。路由位于项目实例中间件之后，沿用本地/远端项目转发。OpenAPI 和 TypeScript SDK 已同步生成。

Agent 运行时合并原始定义和已保存 profile。自定义专家作为 subagent 使用共享专家基础提示词，用户 instructions 作为补充。选定 skillNames 限制发现与加载，保留已有权限拒绝；连接器按 MCP 的准确注册名筛选，避免 `lab` 匹配到 `lab_extra`。核心工具继续受项目权限控制。专家不能借此工具修改注册表或递归委派。

停用会从新委派列表移除专家，保留已运行子任务对原专家的解析。`specialist.updated` 事件刷新设置列表和已加载项目的专家菜单。删除自定义专家与停用含义不同：删除会移除定义。

## Customize

`backend/cli/skills/research/customize/SKILL.md` 参考 AcademicForge 收录的 Claude Science Customize 技能，改写为 OneLab 的实际 `specialist` 工具。先区分能力咨询、查看比较、方案草拟和明确写入请求；仅按当前意图读取相关配置或保存 profile。统一展示和提交 `/customize`，保留对旧大写草稿的解析兼容。

管理工具经技能 allowed-tools 解锁，仍执行权限检查与取消检查；child session 不允许调用。沿用上游 Anthropic 的 Apache-2.0 归属，提供 LICENSE，并更新 ATTRIBUTION 和 NOTICE。

## 验证

- 前后端类型检查通过，最终前端生产构建通过。
- 新增后端专家专项 6 项通过：真实 API/Agent 接入、冲突与非法能力、跨项目权限、并发与损坏存储、Customize 解锁及真实工具调用、真实 MCP 连接器精确筛选。
- bundled skills 2 项、工具 registry 10 项、前端状态/组件/设置 registry 11 项通过。
- Customize 的 CLI `skill validate --strict` 通过。
- Edge 真实浏览器连接隔离后端：创建专家并选定 scanpy、持久化读回、启停、深浅主题、860px 窄窗口和 Customize 新会话预填全部通过，无浏览器运行时错误。未进行模型生成质量评估。
- Windows MCP 子进程测试曾出现连接超时；该测试涉及两个真实进程的所有权建立，增加独立的 Windows 测试时限与状态诊断。最终整个专家专项文件通过。没有放宽生产连接超时。
- 扩展回归发现既有 Windows 限制：plan agent 的计划目录权限断言在 HEAD 原始实现和当前实现均返回 deny；plan-mode 与 research-command 的执行用例依赖本机不可用的 OS sandbox；一个 checkpoint 用例假定 POSIX 路径分隔符。这些结果不计入上述通过项，也未扩展修改到无关功能。

验证脚本、结果和截图位于 `E:/Sugon/OneZone/.cache/specialists-20261009/`。最终生产构建位于其中的 `final-web-build`，未嵌入隔离测试后端地址。隔离测试后端使用独立数据目录。

## 命令补全与部署

首版只在后端注册大写 Customize，前端的内置命令菜单采用固定入口列表，未纳入该命令。现已统一注册小写 customize，将其加入菜单，并与同名技能入口去重。选择时补全文本、保留周围草稿和光标位置，等待用户填写要求后发送；旧大写草稿也会路由到小写命令。Specialists 使用现有 network 协作节点图标，与 Memory 的 brain 图标区分。

补全修正的前端回归 16 项、后端命令专项 1 项及前后端类型检查通过。新增 Playwright 回归延迟技能目录响应，确认命令独立出现在提示中，点击只补全、不会发送。实际服务页面再次验证完整 `/` 列表、`/cust` 搜索、入口去重、不同图标，以及 Chat with OneLab 的小写预填；无浏览器运行时错误，测试创建的临时会话已清理。

已按用户明确授权重启 4106 后端并沿用原数据目录；3000 前端通过 Vite 加载更新。实际接口仅列出小写 customize，健康检查正常。该用户授权优先于前端 AGENTS 的禁止重启约束。代码未提交或推送。

## Customize 意图与执行链路修正

本次用户截图揭示的根因有三处：

1. 内置命令模板把用户原文替换成了强制创建/修改专家的英文提示，既显示在用户气泡内，也改变了模型收到的任务。现在保留 `/customize <用户原文>`，走已有技能预加载链路；不解释其中的命令模板 shell 表达式或替换字符串特殊字符。旧大写命令仍兼容，项目自定义命令仍遵循自身配置。
2. 原技能无条件要求读取专家列表与完整能力目录。现在普通能力介绍不调用管理工具，草稿不写入，明确创建/编辑才走对应流程；默认全部可用无需枚举能力。管理工具 list/catalog 支持 query、offset、limit，默认 10 条、最多 20 条，说明预览 240 字符；get 读取单个完整 profile，写入仅返回目标专家的简要回执。Settings 的完整目录接口保持原契约。
3. specialist 未注册到权限风险分类，被统一当作 unknown，即便只读也可能停在审批等待。list/get/catalog 现归为 passive，创建、修改、启停、删除归为 risky。显式 deny/ask 继续有效，未知 action 仍要求审批；批准读取不再提供 `*` 全部管理权限。

验证记录：

- 最终相关回归共 99 项通过：命令集成 4 项、专家和权限专项 85 项、技能路由 10 项。后端类型检查、技能严格验证、diff 空白检查通过。
- 命令集成测试覆盖 `/customize`、旧 `/Customize` 和普通 prompt 三条链路，确认原文持久化、第一次模型请求已加载技能并解锁真实工具、字面 shell/替换字符保持不变、研究控制不丢失。
- 明确创建还通过本地协议夹具驱动完整模型调用循环，实际执行 list → create，经真实项目权限检查写入注册表并读回。该用例验证执行链路，不代替在线模型语义评估。
- 45 个带长描述的真实技能目录夹具验证搜索、分页无遗漏、单页小于 8 KB；完整 Settings 目录仍保留详细内容。读取详情、写入回执、显式拒绝、启停、删除、并发冲突、损坏存储与 MCP 精确筛选继续通过。
- 实际 3000 页面验证补全、去重、草稿、不同设置图标、Chat with OneLab 预填与用户原文气泡，无浏览器运行时错误。渲染验证使用 noReply 临时消息，命令执行链路由上述集成测试覆盖；测试会话已清理。
- 模型行为验证使用隔离目录和当前已配置供应商，不修改用户专家。中文原始咨询已返回能力介绍，仅加载 skill，无目录读取、研究任务或注册表写入。仅起草测试返回了草稿且未写入，但长输出未在测试时限内完成，不能计为完整通过。英文咨询、完整在线创建受到供应商错误/超时阻断；最终一次创建在约 156 秒后返回 `Upstream HTTP/2 stream failed`，尚未调用管理工具。不能据此承诺固定响应秒数或声称所有在线模型场景通过。原始结果记录于 `.cache/specialists-20261009/intent-eval-*/results.json`。

本次最终后端 runId：`customize-intent-f64c4d0a-9713-4da1-b39b-c091493f9868`，端口 4106；前端端口 3000，健康检查正常。隔离测试进程已退出，临时凭据文件剩余 0；结果文件不包含密钥。

## 远端 Customize 部署修复

Bio 实际运行的远端后端仍为 `0.0.0-dev-202610041504-compute-allocation`：`/command` 与 `/skill` 均没有 customize，`/settings/specialists` 返回 404。此前只更新了本地源码服务；远端内容寻址缓存仍对应 10 月 4 日的旧运行包。前端正确采用当前项目所在服务器的能力目录，因此远端菜单缺失。

重新构建并部署 `linux-x64-baseline`，版本为 `0.0.0-dev-20261009-specialists`，包含 368 个技能、2255 个技能文件。运行包 SHA-256 为 `070bf45e36ce2f406fe7311daa8a7f6789ba66296ca2f48b591b6a86754e916f`，技能 bundle digest 为 `5e7005f2f833d25a0b08c309ec198b39bbc97c3facaaf34ef2834e0c8a472d61`。

先通过 Bio1 上传新包并验证运行，再重新连接 Bio。Bio1 首次上传后启动遇到连接关闭，重试命中已校验缓存后启动成功。Bio 重连前会话运行状态为空，唯一终端为空闲 bash 且无子进程；按用户已有重启授权部署，保留原远端数据、项目、会话和专家配置。本地 4106 服务无需重启。

验收结果：

- Bio 与 Bio1 的健康检查均报告新版本；两者均有且仅有小写 customize 命令，模板为 `/customize $ARGUMENTS`，技能目录包含 customize，Specialists 列表与能力目录正常。
- Edge 实际打开 Bio 远端项目：`/cust`、`/custom`、`/customize` 补全及完整 `/` 列表正常且无重复入口，选择后保留草稿，未提前发送。
- Settings → Specialists 从 Bio 远端 API 加载；Chat with OneLab 在 Bio 项目创建新会话并预填小写命令。
- 发送中文咨询时，浏览器请求指向 Bio 的远端 command API，项目头与原文参数准确。该发送验证拦截了模型请求，不属于新一轮在线模型语义评估；前轮在线模型结果与限制仍适用。
- 浏览器运行时错误为 0；仅创建的临时验证会话已删除，未创建或修改用户专家。截图和结果位于 `.cache/specialists-20261009/remote-customize-*` 与 `remote-specialists.png`。

新增 `tooling/repo/verify-remote-capabilities.ts`，对指定远端进行只读版本、JSON 响应类型、命令、技能及 Specialists 接口验证，并已在 Bio / Bio1 实际通过。远端工作区文档补充了重新构建、逐个重连与该验收命令，避免仅验证本地健康检查而遗漏远端功能部署。
