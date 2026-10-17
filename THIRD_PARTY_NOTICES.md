# 来源与许可材料

账号、校验、错误和初始化命令选择性复用/改写自 SkillWorkbench V1；公共样式参考该应用的卡片、表单、主题实现。保留原 MIT 声明：Copyright (c) 2026 KAN-H，完整条款见 LICENSE。

没有复制参考应用 `.env`、数据库、旧业务路由、dist、node_modules 或测试日志。新依赖在本目录独立安装并以 package-lock.json 锁定。

| 依赖 | 锁定版本 | 用途 | 上游材料 |
| --- | --- | --- | --- |
| Express | 5.3.0 | 同源 HTTP 和权限路由 | https://expressjs.com/ |
| busboy | 1.6.0 | 有资源限制的流式 multipart | https://github.com/mscdex/busboy |
| PDF.js / pdfjs-dist | 6.4.299 | 本地 PDF 解析与光栅化 | https://mozilla.github.io/pdf.js/getting_started/ |
| @napi-rs/canvas | 1.0.11 | 子进程 Canvas 渲染；npm Windows x64 MSVC 包 | https://github.com/Brooooooklyn/canvas |
| sharp | 0.35.5 | 图片方向、灰度、A4 比例与 PNG | https://sharp.pixelplumbing.com/install/ |
| pdf-lib | 1.17.1 | 生产 PDF 封装和结构检查 | https://pdf-lib.js.org/ |

安装包自带许可证保留在 node_modules 中，并在 `docs/licenses/` 保留上述主要包和 PDF.js 的 CMap、标准字体、ICC、WASM 许可文本，供 D 分发时带入。子依赖及原生包也需随 npm 安装树保留自己的许可材料。本文件记录来源，不替代完整上游条款。

开发验证使用 js-yaml 5.4.3、Swagger Parser 13.1.0、Playwright Core 1.64.0。独立 PDF 视觉复核使用本机 Codex 工作区依赖中的 Poppler；生成加密测试样本使用其 pypdf，均不属于应用运行依赖。

所有 PDF 字体/CMap/WASM 资源均从锁定 npm 包的本地路径读取，不请求 CDN。没有 Word、Office、打印驱动或 Ghostscript 运行依赖。
