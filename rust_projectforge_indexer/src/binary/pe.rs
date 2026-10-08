//! Windows PE32 / PE32+ (exe, dll, node) 纯静态反序列化器。
//!
//! 零动态加载，零执行，区间有界防御。

use super::demangle::demangle_symbol;
use super::entropy::{calculate_entropy, classify_entropy};
use super::{read_null_terminated_string, BinaryImportModule, BinaryMitigations, BinarySection, BinarySymbol, UniversalBinary};

const MAX_SECTIONS: usize = 96;
const MAX_EXPORTS: usize = 4096;
const MAX_IMPORTS: usize = 256;
const MAX_IMPORT_FUNCS: usize = 256;

/// 二进制节区在 RVA 与磁盘文件偏移之间的映射
#[derive(Clone, Copy)]
struct SectionMapping {
    va_start: u32,
    va_size: u32,
    raw_start: u32,
    raw_size: u32,
}

impl SectionMapping {
    fn rva_to_raw(&self, rva: u32) -> Option<usize> {
        if rva >= self.va_start && rva < self.va_start.saturating_add(self.va_size) {
            let offset_in_sec = rva - self.va_start;
            if offset_in_sec < self.raw_size {
                return Some((self.raw_start.saturating_add(offset_in_sec)) as usize);
            }
        }
        None
    }
}

fn map_rva_to_raw(sections: &[SectionMapping], rva: u32) -> Option<usize> {
    for sec in sections {
        if let Some(raw) = sec.rva_to_raw(rva) {
            return Some(raw);
        }
    }
    None
}

/// 解析 PE 二进制缓冲区（前 64KB 探测切片）
pub fn parse_pe(buffer: &[u8], file_size_bytes: u64) -> Result<UniversalBinary, String> {
    if buffer.len() < 0x40 {
        return Err("文件过小，无法容纳 DOS 头部".to_string());
    }

    // 1. 读取 e_lfanew (偏移 0x3C，4 字节)
    let e_lfanew = u32::from_le_bytes(buffer[0x3C..0x40].try_into().unwrap()) as usize;
    if e_lfanew < 0x40 || e_lfanew.saturating_add(24) > buffer.len() {
        return Err(format!("畸形 e_lfanew 偏移 (0x{e_lfanew:X})"));
    }

    // 2. 校验 PE 签名 "PE\0\0" (0x00004550)
    let pe_sig = &buffer[e_lfanew..e_lfanew + 4];
    if pe_sig != [0x50, 0x45, 0x00, 0x00] {
        return Err("无效的 PE 签名".to_string());
    }

    let file_header_offset = e_lfanew + 4;
    let machine = u16::from_le_bytes(buffer[file_header_offset..file_header_offset + 2].try_into().unwrap());
    let declared_sections = u16::from_le_bytes(buffer[file_header_offset + 2..file_header_offset + 4].try_into().unwrap()) as usize;
    let num_sections = declared_sections.min(MAX_SECTIONS);
    let size_of_optional_header = u16::from_le_bytes(buffer[file_header_offset + 16..file_header_offset + 18].try_into().unwrap()) as usize;
    let characteristics = u16::from_le_bytes(buffer[file_header_offset + 18..file_header_offset + 20].try_into().unwrap());

    let _is_dll = (characteristics & 0x2000) != 0;
    let opt_header_offset = file_header_offset + 20;

    if opt_header_offset.saturating_add(size_of_optional_header) > buffer.len() {
        return Err("OptionalHeader 越界".to_string());
    }

    let opt_magic = u16::from_le_bytes(buffer[opt_header_offset..opt_header_offset + 2].try_into().unwrap());
    let is_pe32_plus = opt_magic == 0x20B; // 64-bit PE32+
    let is_pe32 = opt_magic == 0x10B; // 32-bit PE32

    if !is_pe32_plus && !is_pe32 {
        return Err(format!("未知的 OptionalHeader Magic: 0x{opt_magic:04X}"));
    }

    let arch = match machine {
        0x8664 => "x86_64",
        0x014C => "x86",
        0xAA64 => "aarch64",
        _ => "unknown",
    }.to_string();

    let format = if is_pe32_plus { "PE32+" } else { "PE32" }.to_string();

    // 3. 读取 OptionalHeader 字段
    let entry_point_rva = u32::from_le_bytes(buffer[opt_header_offset + 16..opt_header_offset + 20].try_into().unwrap());
    let (image_base_str, subsystem_val, dll_char_val, data_dirs_offset) = if is_pe32_plus {
        let base = u64::from_le_bytes(buffer[opt_header_offset + 24..opt_header_offset + 32].try_into().unwrap());
        let sub = u16::from_le_bytes(buffer[opt_header_offset + 68..opt_header_offset + 70].try_into().unwrap());
        let dll_char = u16::from_le_bytes(buffer[opt_header_offset + 70..opt_header_offset + 72].try_into().unwrap());
        (format!("0x{base:016X}"), sub, dll_char, opt_header_offset + 112)
    } else {
        let base = u32::from_le_bytes(buffer[opt_header_offset + 28..opt_header_offset + 32].try_into().unwrap());
        let sub = u16::from_le_bytes(buffer[opt_header_offset + 68..opt_header_offset + 70].try_into().unwrap());
        let dll_char = u16::from_le_bytes(buffer[opt_header_offset + 70..opt_header_offset + 72].try_into().unwrap());
        (format!("0x{base:08X}"), sub, dll_char, opt_header_offset + 96)
    };

    let subsystem = match subsystem_val {
        2 => Some("WindowsGUI".to_string()),
        3 => Some("WindowsCUI".to_string()),
        _ => None,
    };

    let mitigations = BinaryMitigations {
        aslr: (dll_char_val & 0x0040) != 0,
        high_entropy_va: (dll_char_val & 0x0020) != 0,
        dep: (dll_char_val & 0x0100) != 0,
        stack_canary: true, // PE 普遍内置 /GS 默认开启
        control_flow_guard: (dll_char_val & 0x4000) != 0,
        relro: None,
        code_signed: false, // 简化，证书表存在性在下文探测
    };

    // 4. 解析 Data Directories (Directory 0 = Export, Directory 1 = Import, Directory 4 = Security)
    let (export_rva, import_rva, has_cert) = if data_dirs_offset.saturating_add(8 * 5) <= buffer.len() {
        let exp_rva = u32::from_le_bytes(buffer[data_dirs_offset..data_dirs_offset + 4].try_into().unwrap());
        let imp_rva = u32::from_le_bytes(buffer[data_dirs_offset + 8..data_dirs_offset + 12].try_into().unwrap());
        let cert_raw = u32::from_le_bytes(buffer[data_dirs_offset + 32..data_dirs_offset + 36].try_into().unwrap());
        (exp_rva, imp_rva, cert_raw != 0)
    } else {
        (0, 0, false)
    };

    let mut final_mitigations = mitigations;
    final_mitigations.code_signed = has_cert;

    // 5. 遍历 Section Headers
    let sections_start = opt_header_offset + size_of_optional_header;
    let mut sections = Vec::with_capacity(num_sections);
    let mut mappings = Vec::with_capacity(num_sections);

    for i in 0..num_sections {
        let sec_offset = sections_start.saturating_add(i * 40);
        if sec_offset.saturating_add(40) > buffer.len() {
            break;
        }

        let name_bytes = &buffer[sec_offset..sec_offset + 8];
        let null_pos = name_bytes.iter().position(|&b| b == 0).unwrap_or(8);
        let sec_name = String::from_utf8_lossy(&name_bytes[..null_pos]).trim().to_string();

        let virt_size = u32::from_le_bytes(buffer[sec_offset + 8..sec_offset + 12].try_into().unwrap());
        let virt_addr = u32::from_le_bytes(buffer[sec_offset + 12..sec_offset + 16].try_into().unwrap());
        let raw_size = u32::from_le_bytes(buffer[sec_offset + 16..sec_offset + 20].try_into().unwrap());
        let raw_offset = u32::from_le_bytes(buffer[sec_offset + 20..sec_offset + 24].try_into().unwrap());
        let sec_char = u32::from_le_bytes(buffer[sec_offset + 36..sec_offset + 40].try_into().unwrap());

        let can_read = (sec_char & 0x4000_0000) != 0;
        let can_write = (sec_char & 0x8000_0000) != 0;
        let can_exec = (sec_char & 0x2000_0000) != 0;

        let perms = format!(
            "{}{}{}",
            if can_read { "R" } else { "-" },
            if can_write { "W" } else { "-" },
            if can_exec { "X" } else { "-" }
        );

        // 计算该节区在探针切片中的香农熵
        let entropy = if (raw_offset as usize) < buffer.len() && raw_size > 0 {
            let start = raw_offset as usize;
            let end = (start + raw_size as usize).min(buffer.len());
            calculate_entropy(&buffer[start..end])
        } else {
            0.0
        };

        let entropy_status = classify_entropy(entropy, can_exec).to_string();

        mappings.push(SectionMapping {
            va_start: virt_addr,
            va_size: virt_size,
            raw_start: raw_offset,
            raw_size,
        });

        sections.push(BinarySection {
            name: if sec_name.is_empty() { format!("sec_{i}") } else { sec_name },
            virtual_address: format!("0x{virt_addr:08X}"),
            virtual_size: virt_size as u64,
            raw_offset: raw_offset as u64,
            raw_size: raw_size as u64,
            permissions: perms,
            entropy: (entropy * 100.0).round() / 100.0,
            entropy_status,
        });
    }

    // 6. 解析 EAT 导出符号
    let mut symbols = Vec::new();
    if export_rva != 0 {
        if let Some(exp_raw) = map_rva_to_raw(&mappings, export_rva) {
            if exp_raw.saturating_add(40) <= buffer.len() {
                let num_functions = u32::from_le_bytes(buffer[exp_raw + 20..exp_raw + 24].try_into().unwrap()) as usize;
                let num_names = u32::from_le_bytes(buffer[exp_raw + 24..exp_raw + 28].try_into().unwrap()) as usize;
                let functions_rva = u32::from_le_bytes(buffer[exp_raw + 28..exp_raw + 32].try_into().unwrap());
                let names_rva = u32::from_le_bytes(buffer[exp_raw + 32..exp_raw + 36].try_into().unwrap());
                let ordinals_rva = u32::from_le_bytes(buffer[exp_raw + 36..exp_raw + 40].try_into().unwrap());
                let ordinal_base = u32::from_le_bytes(buffer[exp_raw + 16..exp_raw + 20].try_into().unwrap());

                let limit_names = num_names.min(MAX_EXPORTS);
                if let (Some(names_raw), Some(ords_raw), Some(funcs_raw)) = (
                    map_rva_to_raw(&mappings, names_rva),
                    map_rva_to_raw(&mappings, ordinals_rva),
                    map_rva_to_raw(&mappings, functions_rva),
                ) {
                    for j in 0..limit_names {
                        if names_raw + j * 4 + 4 > buffer.len() || ords_raw + j * 2 + 2 > buffer.len() {
                            break;
                        }
                        let name_str_rva = u32::from_le_bytes(buffer[names_raw + j * 4..names_raw + j * 4 + 4].try_into().unwrap());
                        let ordinal_index = u16::from_le_bytes(buffer[ords_raw + j * 2..ords_raw + j * 2 + 2].try_into().unwrap()) as usize;

                        let func_rva = if funcs_raw + ordinal_index * 4 + 4 <= buffer.len() && ordinal_index < num_functions {
                            u32::from_le_bytes(buffer[funcs_raw + ordinal_index * 4..funcs_raw + ordinal_index * 4 + 4].try_into().unwrap())
                        } else {
                            0
                        };

                        if let Some(str_raw) = map_rva_to_raw(&mappings, name_str_rva) {
                            if let Some(raw_name) = read_null_terminated_string(buffer, str_raw, 256) {
                                let demangled = demangle_symbol(&raw_name);
                                symbols.push(BinarySymbol {
                                    name: raw_name,
                                    demangled,
                                    rva: format!("0x{func_rva:08X}"),
                                    kind: "export".to_string(),
                                    ordinal: Some(ordinal_base.saturating_add(ordinal_index as u32)),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // 7. 解析 IAT 依赖库
    let mut imports = Vec::new();
    if import_rva != 0 {
        if let Some(mut desc_raw) = map_rva_to_raw(&mappings, import_rva) {
            let mut import_count = 0;
            while desc_raw.saturating_add(20) <= buffer.len() && import_count < MAX_IMPORTS {
                let original_first_thunk = u32::from_le_bytes(buffer[desc_raw..desc_raw + 4].try_into().unwrap());
                let name_rva = u32::from_le_bytes(buffer[desc_raw + 12..desc_raw + 16].try_into().unwrap());
                let first_thunk = u32::from_le_bytes(buffer[desc_raw + 16..desc_raw + 20].try_into().unwrap());

                // 全 0 为结束哨兵
                if original_first_thunk == 0 && name_rva == 0 && first_thunk == 0 {
                    break;
                }

                if let Some(lib_raw) = map_rva_to_raw(&mappings, name_rva) {
                    if let Some(lib_name) = read_null_terminated_string(buffer, lib_raw, 128) {
                        let thunk_rva = if original_first_thunk != 0 { original_first_thunk } else { first_thunk };
                        let mut funcs = Vec::new();
                        if let Some(mut thunk_raw) = map_rva_to_raw(&mappings, thunk_rva) {
                            let thunk_size = if is_pe32_plus { 8 } else { 4 };
                            let mut func_count = 0;
                            while thunk_raw.saturating_add(thunk_size) <= buffer.len() && func_count < MAX_IMPORT_FUNCS {
                                let val = if is_pe32_plus {
                                    u64::from_le_bytes(buffer[thunk_raw..thunk_raw + 8].try_into().unwrap())
                                } else {
                                    u32::from_le_bytes(buffer[thunk_raw..thunk_raw + 4].try_into().unwrap()) as u64
                                };
                                if val == 0 {
                                    break;
                                }
                                // 最高位为 1 代表按序号导入
                                let is_ordinal = if is_pe32_plus { (val & 0x8000_0000_0000_0000) != 0 } else { (val & 0x8000_0000) != 0 };
                                if is_ordinal {
                                    funcs.push(format!("Ordinal_{}", val & 0xFFFF));
                                } else {
                                    let hint_name_rva = (val & 0x7FFF_FFFF) as u32;
                                    if let Some(hint_raw) = map_rva_to_raw(&mappings, hint_name_rva) {
                                        // Hint (2 字节) + Name
                                        if let Some(fn_name) = read_null_terminated_string(buffer, hint_raw + 2, 128) {
                                            funcs.push(fn_name);
                                        }
                                    }
                                }
                                thunk_raw += thunk_size;
                                func_count += 1;
                            }
                        }
                        imports.push(BinaryImportModule {
                            library: lib_name,
                            functions: funcs,
                        });
                    }
                }

                desc_raw += 20;
                import_count += 1;
            }
        }
    }

    Ok(UniversalBinary {
        is_binary: true,
        format,
        architecture: arch,
        subsystem,
        file_size_bytes,
        entry_point_rva: format!("0x{entry_point_rva:08X}"),
        image_preferred_base: image_base_str,
        mitigations: final_mitigations,
        sections,
        symbols,
        imports,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pe_too_small() {
        let small = vec![0x4Du8, 0x5A];
        assert!(parse_pe(&small, 2).is_err());
    }

    #[test]
    fn test_pe_invalid_signature() {
        let mut buf = vec![0u8; 128];
        buf[0] = 0x4D;
        buf[1] = 0x5A;
        buf[0x3C] = 0x40; // e_lfanew = 0x40
        // 没有写入 "PE\0\0"
        assert!(parse_pe(&buf, 128).is_err());
    }
}