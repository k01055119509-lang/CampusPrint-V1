# 本地 Git 仓库使用说明

工程目录 `D:\CampusPrint-V1` 已建立 Git 仓库，默认分支为 `main`。本地 Git 仓库用于保存版本历史；只有配置 GitHub 远程仓库并推送后，文件才会出现在 GitHub。

## 版本管理范围

纳入前后端源码、配置样例、数据库迁移、接口契约、测试代码和固定测试样例、部署及便携包构建脚本、许可证和使用说明。

以下内容保留在本机，由 `.gitignore` 排除：

- 运行数据库、学生文件、个人配置、会话、备份及临时目录。
- 收款码和广告原图；素材投放目录只纳入 README。
- `node_modules`、内置运行环境、`dist` 发行包。
- 自动生成的验证报告、测试截图和日志。
- 项目总控核心、任务分工、交接和上线筹备等本机管理资料。
- 两份含历史本机登录值的运维脚本：`scripts/deploy/audit-workflow-local.js`、`scripts/deploy/local-upgrade.js`。

忽略不会删除本机文件。普通使用说明和测试代码仍可查阅；部分历史审计脚本依赖本机交接/证据目录，不能在新克隆的仓库中当作通用验证入口。日常验证使用 `npm test` 和 README 中的命令。

`.gitattributes` 禁用自动换行转换，确保迁移 SQL 的已应用摘要及其他源文件字节保持稳定。不要为了换行风格重写已经发布的迁移。

## 首次提交及日常保存

Git 提交需要姓名和邮箱作为署名；它们不用于登录。可使用自己的 GitHub 公开提交署名或 GitHub 提供的隐私邮箱。尚未配置时，不会用 Windows 用户名自动猜测身份。

在项目终端中配置本仓库署名后，再提交已审查的暂存内容：

```powershell
git config --local user.name "你的提交署名"
git config --local user.email "你的提交邮箱"
git status
git diff --cached --stat
git commit -m "Initial import of Campus Print 1.4.0"
```

此处是配置示例，不代表这些占位值已写入仓库。后续修改按 `git status` 检查范围、`git add` 暂存、`git commit` 保存。本轮没有配置远程地址或推送；需要上传时再提供 GitHub 目标仓库。

数据库和收款图片不是 Git 备份的一部分。新电脑需要按安装说明创建自己的管理员和运行配置，不能从源码仓库恢复本机历史订单。
