# 本地 Git 仓库使用说明

工程目录 `D:\CampusPrint-V1` 已建立 Git 仓库，默认分支为 `main`。2026-10-17已上传至 [GitHub仓库 CampusPrint-V1](https://github.com/k01055119509-lang/CampusPrint-V1)，本机 `origin` 指向该仓库，`main` 跟踪 `origin/main`。

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

## 提交署名及日常保存

Git 提交需要姓名和邮箱作为署名；它们不用于登录。可使用自己的 GitHub 公开提交署名或 GitHub 提供的隐私邮箱。尚未配置时，不会用 Windows 用户名自动猜测身份。

本机首次提交已完成。换新电脑时可在项目终端中配置本仓库署名；以下姓名和邮箱是示例占位值：

```powershell
git config --local user.name "你的提交署名"
git config --local user.email "你的提交邮箱"
```

后续修改按 `git status` 检查范围、`git add` 暂存、`git diff --cached` 审查内容、`git commit` 保存，最后运行 `git push` 上传到已关联仓库。登录由 Git Credential Manager 处理，不把密码或令牌写入远程网址和源码。

```powershell
git status
git diff --cached --stat
git commit -m "说明本次修改"
git push
```

上述提交命令用于已经暂存所需修改的情况。其他电脑同步同一仓库时，开始工作前先确认本机改动已妥善保存，再使用 `git pull --ff-only` 更新；存在分歧时先处理分支情况，不使用强制推送覆盖历史。

数据库和收款图片不是 Git 备份的一部分。新电脑需要按安装说明创建自己的管理员和运行配置，不能从源码仓库恢复本机历史订单。
