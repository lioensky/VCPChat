# pdf-lib 和 fontkit

- 来源：npm `pdf-lib@1.17.1`（MIT，见 LICENSE-pdf-lib.md）、`@pdf-lib/fontkit@1.1.1`（MIT，见 LICENSE-fontkit.md）。
  主进程用它们写入 PDF（添加文字、签名、图片，增删和旋转页面，填写表单），fontkit 按用到的字符把中文字体嵌入 PDF。
- 只包含 UMD 压缩版 `pdf-lib.min.js`、`fontkit.umd.min.js`，在主进程中直接 require。
- `@pdf-lib/fontkit` 的 npm 包未附带许可证文件（README 和 package.json 写明为 MIT），LICENSE-fontkit.md 按 MIT 原文补充。
- 升级：替换为新版本的同名文件。
