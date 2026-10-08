//! 跨 ABI 符号解修饰流式状态机。
//!
//! 支持 Rust v0 (`_R`)、Itanium C++ (`_Z`) 与 MSVC C++ (`?`) 的解修饰。

/// 将修饰名（Mangled Name）转换为人类可读的函数/类型签名
pub fn demangle_symbol(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // 1. Rust v0 符号 (RFC 2603)
    if trimmed.starts_with("_R") {
        return format!("{:#}", rustc_demangle::demangle(trimmed));
    }

    // 2. Itanium C++ ABI (GCC / Clang)
    if trimmed.starts_with("_Z") {
        if let Some(demangled) = demangle_itanium(trimmed) {
            return demangled;
        }
    }

    // 3. MSVC C++ ABI
    if trimmed.starts_with('?') {
        if let Some(demangled) = demangle_msvc(trimmed) {
            return demangled;
        }
    }

    // 未知或普通 C 符号直接透传
    trimmed.to_string()
}

/// 快速轻量 Itanium C++ 嵌套命名空间与函数名解构
fn demangle_itanium(raw: &str) -> Option<String> {
    let s = raw.strip_prefix("_Z")?;
    // 处理嵌套名称: _ZN...E
    if let Some(nested) = s.strip_prefix('N') {
        let mut parts = Vec::new();
        let bytes = nested.as_bytes();
        let mut cursor = 0;
        while cursor < bytes.len() {
            if bytes[cursor] == b'E' {
                break;
            }
            if bytes[cursor].is_ascii_digit() {
                let mut len = 0usize;
                while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                    len = len.saturating_mul(10).saturating_add((bytes[cursor] - b'0') as usize);
                    cursor += 1;
                }
                if len > 0 && cursor + len <= bytes.len() {
                    if let Ok(part) = std::str::from_utf8(&bytes[cursor..cursor + len]) {
                        parts.push(part.to_string());
                    }
                    cursor += len;
                } else {
                    break;
                }
            } else {
                // 跳过修饰符
                cursor += 1;
            }
        }
        if !parts.is_empty() {
            return Some(parts.join("::"));
        }
    }

    // 处理简单符号: _Z<len><ident>
    let mut chars = s.chars().peekable();
    let mut len = 0usize;
    while let Some(&d) = chars.peek() {
        if d.is_ascii_digit() {
            len = len.saturating_mul(10).saturating_add((d as u8 - b'0') as usize);
            chars.next();
        } else {
            break;
        }
    }
    if len > 0 {
        let ident: String = chars.take(len).collect();
        if !ident.is_empty() {
            return Some(ident);
        }
    }

    None
}

/// 快速轻量 MSVC C++ 符号提取（提取主要函数名与所属类域）
fn demangle_msvc(raw: &str) -> Option<String> {
    let s = raw.strip_prefix('?')?;
    // MSVC 格式形如 ?name@class@namespace@@...
    let name_part = s.split("@@").next()?;
    let tokens: Vec<&str> = name_part.split('@').filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        return None;
    }
    // 逆序组装：命名空间::类::方法
    let mut reversed = tokens.clone();
    reversed.reverse();
    Some(reversed.join("::"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rust_v0_demangle() {
        let mangled = "_RNvCs1234_7mycrate3foo";
        let res = demangle_symbol(mangled);
        assert!(res.contains("mycrate::foo"));
    }

    #[test]
    fn test_itanium_nested_demangle() {
        let mangled = "_ZN3VCP12RenderEngine13flushPipelineE";
        assert_eq!(demangle_symbol(mangled), "VCP::RenderEngine::flushPipeline");

        let simple = "_Z12init_runtimev";
        assert_eq!(demangle_symbol(simple), "init_runtime");
    }

    #[test]
    fn test_msvc_demangle() {
        let mangled = "?flushPipeline@RenderEngine@VCP@@QEAAXXZ";
        assert_eq!(demangle_symbol(mangled), "VCP::RenderEngine::flushPipeline");

        let simple = "?initModule@@YAHXZ";
        assert_eq!(demangle_symbol(simple), "initModule");
    }

    #[test]
    fn test_passthrough() {
        assert_eq!(demangle_symbol("napi_register_module_v1"), "napi_register_module_v1");
        assert_eq!(demangle_symbol("main"), "main");
    }
}