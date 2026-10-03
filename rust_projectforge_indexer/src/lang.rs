//! 语言识别：扩展名 / 语言名 → tree-sitter grammar。

use std::path::Path;

use tree_sitter::Language;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lang {
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Rust,
    C,
    Cpp,
    Go,
    Java,
    CSharp,
    Lua,
}

/// 同一族共用一套符号提取规则（JS / TS / TSX 语法树节点基本一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Js,
    Python,
    Rust,
    C,
    Cpp,
    Go,
    Java,
    CSharp,
    Lua,
}

impl Lang {
    pub const ALL: [Lang; 11] = [
        Lang::JavaScript,
        Lang::TypeScript,
        Lang::Tsx,
        Lang::Python,
        Lang::Rust,
        Lang::C,
        Lang::Cpp,
        Lang::Go,
        Lang::Java,
        Lang::CSharp,
        Lang::Lua,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Lang::JavaScript => "javascript",
            Lang::TypeScript => "typescript",
            Lang::Tsx => "tsx",
            Lang::Python => "python",
            Lang::Rust => "rust",
            Lang::C => "c",
            Lang::Cpp => "cpp",
            Lang::Go => "go",
            Lang::Java => "java",
            Lang::CSharp => "c_sharp",
            Lang::Lua => "lua",
        }
    }

    pub fn family(self) -> Family {
        match self {
            Lang::JavaScript | Lang::TypeScript | Lang::Tsx => Family::Js,
            Lang::Python => Family::Python,
            Lang::Rust => Family::Rust,
            Lang::C => Family::C,
            Lang::Cpp => Family::Cpp,
            Lang::Go => Family::Go,
            Lang::Java => Family::Java,
            Lang::CSharp => Family::CSharp,
            Lang::Lua => Family::Lua,
        }
    }

    /// 接受语言名或扩展名（不带点），大小写不敏感。
    pub fn from_name(name: &str) -> Option<Lang> {
        match name.trim().trim_start_matches('.').to_ascii_lowercase().as_str() {
            "javascript" | "js" | "jsx" | "mjs" | "cjs" => Some(Lang::JavaScript),
            "typescript" | "ts" | "mts" | "cts" => Some(Lang::TypeScript),
            "tsx" => Some(Lang::Tsx),
            "python" | "py" | "pyi" => Some(Lang::Python),
            "rust" | "rs" => Some(Lang::Rust),
            "c" => Some(Lang::C),
            "cpp" | "cxx" | "cc" | "h" | "hpp" | "hxx" | "hh" | "c++" | "h++" | "cppm" | "ixx" | "mxx" | "cxxm" => Some(Lang::Cpp),
            "go" => Some(Lang::Go),
            "java" => Some(Lang::Java),
            "csharp" | "cs" | "c#" | "c_sharp" => Some(Lang::CSharp),
            "lua" => Some(Lang::Lua),
            _ => None,
        }
    }

    pub fn from_path(path: &Path) -> Option<Lang> {
        let ext = path.extension()?.to_str()?;
        Lang::from_name(ext)
    }

    pub fn ts_language(self) -> Language {
        match self {
            Lang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::C => tree_sitter_c::LANGUAGE.into(),
            Lang::Cpp => tree_sitter_cpp::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
            Lang::Java => tree_sitter_java::LANGUAGE.into(),
            Lang::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            Lang::Lua => tree_sitter_lua::LANGUAGE.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_names_and_extensions() {
        assert_eq!(Lang::from_path(Path::new("src/a.mjs")), Some(Lang::JavaScript));
        assert_eq!(Lang::from_path(Path::new("App.TSX")), Some(Lang::Tsx));
        assert_eq!(Lang::from_path(Path::new("lib.rs")), Some(Lang::Rust));
        assert_eq!(Lang::from_path(Path::new("README.md")), None);
        assert_eq!(Lang::from_name("TypeScript"), Some(Lang::TypeScript));
        assert_eq!(Lang::from_name(".py"), Some(Lang::Python));
    }
}