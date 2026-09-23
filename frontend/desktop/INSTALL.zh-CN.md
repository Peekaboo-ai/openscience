# OpenScience Workspaces Windows 安装说明

适用于 Windows 10/11 64 位（x64）。安装包包含桌面应用、本地后端和用于 Linux/macOS x64、ARM64 的远端后端，不需要预先安装 Node.js 或 Bun。

建议安装盘至少保留 2 GB 可用空间，系统盘至少保留 1 GB 用于临时文件和安装器缓存；项目、模型缓存和科研环境还需额外空间。

1. 双击 `OpenScience-Workspaces-…-windows-x64-setup.exe`。
2. 选择中文或英文，按向导选择安装目录并完成安装。采用当前用户安装，不需要管理员权限。
3. 从桌面或开始菜单打开 **OpenScience Workspaces**。应用会自动启动本地服务并显示工作台，不需要手动启动服务或输入端口。
4. 启动后直接进入本地工作台，无需 Synthetic Sciences 账号或 sign-in key。在 Models 中配置自己的模型服务，在 Projects 中创建本地或远程项目。官方账号登录保留在设置中，使用官方云服务时可自行登录。

安装包不含制作者的 API Key、SSH 账号、私钥、项目或会话。模型服务需要用户自行配置；SSH、WSL、Docker 连接需要相应的客户端或主机环境。科研任务所需的 Python、Conda、R 等环境按实际任务配置。

应用数据、配置、日志和桌面状态默认位于 `%LOCALAPPDATA%\OpenScience Workspaces`，与程序安装目录分开。可通过 `OPENSCIENCE_WORKSPACES_HOME` 指定其他数据目录。此安装版不会自动导入已有开发服务的数据。

SSH 连接支持含空格和中文的数据目录，并对保存的主机密钥执行严格校验。首次导入主机后按界面流程测试连接；无需关闭主机密钥校验或手动修改系统 `known_hosts`。

更新时关闭应用，运行较新的 **Workspaces** 安装包覆盖安装即可。请使用同一版本系列的安装包，不要用上游原版替换定制版。在 Windows 的“已安装的应用”中卸载 **OpenScience Workspaces** 会删除程序和快捷方式，但保留用户数据。

本地构建未配置代码签名证书，Windows 可能提示发布者未知或显示 SmartScreen 提示。可用同目录的 `.sha256` 文件核对安装包完整性；正式公开分发需要配置可信的 Windows 发布者签名。
