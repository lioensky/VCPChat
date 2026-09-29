// 冒烟检查：确认各 grammar 与 tree-sitter 核心 ABI 兼容（正式实现会覆盖本文件）。
fn main() {
    let languages: Vec<(&str, tree_sitter::Language, &str)> = vec![
        ("javascript", tree_sitter_javascript::LANGUAGE.into(), "const gui = { async f() {} };\n"),
        ("typescript", tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "class A { m(): void {} }\n"),
        ("tsx", tree_sitter_typescript::LANGUAGE_TSX.into(), "const C = () => <div />;\n"),
        ("python", tree_sitter_python::LANGUAGE.into(), "@dec\ndef f():\n    pass\n"),
        ("rust", tree_sitter_rust::LANGUAGE.into(), "#[inline]\nfn f() {}\n"),
    ];
    for (name, language, source) in languages {
        let mut parser = tree_sitter::Parser::new();
        match parser.set_language(&language) {
            Ok(()) => {
                let tree = parser.parse(source, None).expect("parse returned None");
                let root = tree.root_node();
                println!(
                    "{name}: abi={} ok root={} children={} has_error={}",
                    language.abi_version(),
                    root.kind(),
                    root.named_child_count(),
                    root.has_error()
                );
            }
            Err(error) => println!("{name}: ABI 不兼容 {error}"),
        }
    }
}