# pdf.js

- 来源：npm `pdfjs-dist@5.7.284`（Mozilla，Apache-2.0，见 LICENSE），文坊的 PDF 查看和编辑使用。
- 只包含用到的部分：`build/pdf.min.mjs`、`build/pdf.worker.min.mjs`、`cmaps/`（中文等 CJK 的 PDF 需要）、`standard_fonts/`、`iccs/`，
  以及 `wasm/` 中的 JBIG2、OpenJPEG、QCMS（图片解码和色彩管理，各自附带许可证）。未包含 PDF 内脚本的沙箱（quickjs），文坊不运行 PDF 中的脚本。
- 升级：替换为新版本的同名文件。
