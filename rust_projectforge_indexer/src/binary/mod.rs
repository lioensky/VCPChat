//! 全域二进制静态解构统一抽象模型 (UBAM)。
//!
//! 支持 PE32/PE32+ (Windows exe/dll/node), ELF32/ELF64 (Linux so), WebAssembly (wasm)。

pub mod demangle;
pub mod elf;
pub mod entropy;
pub mod pe;
pub mod wasm;

use std::fs::File;
use std::io::Read;
use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinarySection {
    pub name: String,
    pub virtual_address: String,
    pub virtual_size: u64,
    pub raw_offset: u64,
    pub raw_size: u64,
    pub permissions: String,
    pub entropy: f64,
    pub entropy_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinarySymbol {
    pub name: String,
    pub demangled: String,
    pub rva: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryImportModule {
    pub library: String,
    pub functions: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryMitigations {
    pub aslr: bool,
    pub high_entropy_va: bool,
    pub dep: bool,
    pub stack_canary: bool,
    pub control_flow_guard: bool,
    pub relro: Option<String>,
    pub code_signed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UniversalBinary {
    pub is_binary: bool,
    pub format: String,
    pub architecture: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subsystem: Option<String>,
    pub file_size_bytes: u64,
    pub entry_point_rva: String,
    pub image_preferred_base: String,
    pub mitigations: BinaryMitigations,
    pub sections: Vec<BinarySection>,
    pub symbols: Vec<BinarySymbol>,
    pub imports: Vec<BinaryImportModule>,
}

/// 解析任意二进制文件的前 64KB 探测元数据
pub fn parse_binary(path: &Path) -> Result<UniversalBinary, String> {
    let mut file = File::open(path).map_err(|e| format!("无法打开文件: {e}"))?;
    let file_size_bytes = file.metadata().map_err(|e| format!("无法读取元数据: {e}"))?.len();

    // 双阶段探针：读取前 64KB
    let probe_size = file_size_bytes.min(65536) as usize;
    let mut buffer = vec![0u8; probe_size];
    file.read_exact(&mut buffer).map_err(|e| format!("读取探针失败: {e}"))?;

    if buffer.len() >= 2 && buffer[0] == 0x4D && buffer[1] == 0x5A {
        // Windows PE (DOS "MZ")
        return pe::parse_pe(&buffer, file_size_bytes);
    }

    if buffer.len() >= 4 && buffer[0] == 0x7F && buffer[1] == b'E' && buffer[2] == b'L' && buffer[3] == b'F' {
        // Linux ELF
        return elf::parse_elf(&buffer, file_size_bytes);
    }

    if buffer.len() >= 4 && buffer[0] == 0x00 && buffer[1] == b'a' && buffer[2] == b's' && buffer[3] == b'm' {
        // WebAssembly
        return wasm::parse_wasm(&buffer, file_size_bytes);
    }

    Err(format!("未知或不受支持的二进制格式 (Magic: {:02X?})", &buffer[..buffer.len().min(4)]))
}

/// 辅助：从字节切片中安全读取以 0 结尾的 ASCII 字符串
pub(crate) fn read_null_terminated_string(buffer: &[u8], offset: usize, max_len: usize) -> Option<String> {
    if offset >= buffer.len() {
        return None;
    }
    let end = (offset + max_len).min(buffer.len());
    let slice = &buffer[offset..end];
    let null_pos = slice.iter().position(|&b| b == 0).unwrap_or(slice.len());
    String::from_utf8(slice[..null_pos].to_vec()).ok()
}