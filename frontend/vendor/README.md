# 前端依赖

A 的基础页面使用浏览器原生 ES modules、dialog、fetch 和 FormData，没有 CDN 或外部脚本。公共样式从参考应用的卡片、表单与深浅主题选择性改写，版权见项目 LICENSE 与 THIRD_PARTY_NOTICES.md。

B/C 可以调用 /shared/api.js、/shared/auth.js、/shared/i18n.js；交接后公共目录由 D 集成，新增页面逻辑在各自目录实现。
