# pdf-lib 和 fontkit

- 来源：npm `pdf-lib@1.17.1`（MIT，见 LICENSE-pdf-lib.md）、`@pdf-lib/fontkit@1.1.1`（MIT，见 LICENSE-fontkit.md）。
  主进程用它们写 PDF（加字、签名、图片、页面增删转、填表），fontkit 把中文字体按用到的字嵌进 PDF。
- 只拿了 UMD 的压缩版 `pdf-lib.min.js`、`fontkit.umd.min.js`，主进程里直接 require。
- `@pdf-lib/fontkit` 的 npm 包里没带许可证文件（README 和 package.json 写的是 MIT），LICENSE-fontkit.md 按 MIT 原文补的。
- 升级：换成新版本的同名文件。
