# pdf.js

- 来源：npm `pdfjs-dist@5.7.284`（Mozilla，Apache-2.0，见 LICENSE），文坊的 PDF 查看和编辑用。
- 只拿了用得到的：`build/pdf.min.mjs`、`build/pdf.worker.min.mjs`、`cmaps/`（中文等 CJK 的 PDF 要用）、`standard_fonts/`、`iccs/`、
  `wasm/` 里的 JBIG2、OpenJPEG、QCMS（图片解码和色彩，各带自己的许可证）。没拿 PDF 里的脚本沙箱（quickjs），文坊不运行 PDF 里的脚本。
- 升级：换成新版本的同名文件。
