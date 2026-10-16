/// Top level docs
pub fn render_frame(delta: f32) -> Result<(), String> {
    let mut canvas = init_canvas();
    // 故意漏写括号导致 AST 处于错误截断态
    if delta > 0.0 {
        canvas.draw();
    // 缺失闭合括号，AST 在此报错，但下面缩进回落且闭合
}