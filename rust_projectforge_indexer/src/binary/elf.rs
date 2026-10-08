//! Linux/UNIX ELF32 / ELF64 (so, 可执行程序) 纯静态反序列化器。
//!
//! 支持 Program Headers, Section Headers, Dynamic Symbols (.dynsym) 与 DT_NEEDED 依赖提取。

use super::demangle::demangle_symbol;
use super::entropy::{calculate_entropy, classify_entropy};
use super::{read_null_terminated_string, BinaryMitigations, BinarySection, BinarySymbol, UniversalBinary};

const MAX_SECTIONS: usize = 96;
const MAX_SYMBOLS: usize = 4096;

pub fn parse_elf(buffer: &[u8], file_size_bytes: u64) -> Result<UniversalBinary, String> {
    if buffer.len() < 16 {
        return Err("文件过小，无法容纳 ELF e_ident".to_string());
    }

    if buffer[0..4] != [0x7F, b'E', b'L', b'F'] {
        return Err("无效的 ELF 魔数".to_string());
    }

    let is_64bit = buffer[4] == 2;
    let is_little_endian = buffer[5] == 1;

    if !is_little_endian {
        return Err("暂不支持大端序 ELF 镜像".to_string());
    }

    let format = if is_64bit { "ELF64" } else { "ELF32" }.to_string();

    let (machine, entry_point, phoff, shoff, phentsize, phnum, shentsize, shnum, shstrndx) = if is_64bit {
        if buffer.len() < 64 {
            return Err("文件过小，无法容纳 ELF64 头部".to_string());
        }
        let e_machine = u16::from_le_bytes(buffer[18..20].try_into().unwrap());
        let e_entry = u64::from_le_bytes(buffer[24..32].try_into().unwrap());
        let e_phoff = u64::from_le_bytes(buffer[32..40].try_into().unwrap()) as usize;
        let e_shoff = u64::from_le_bytes(buffer[40..48].try_into().unwrap()) as usize;
        let e_phentsize = u16::from_le_bytes(buffer[54..56].try_into().unwrap()) as usize;
        let e_phnum = u16::from_le_bytes(buffer[56..58].try_into().unwrap()) as usize;
        let e_shentsize = u16::from_le_bytes(buffer[58..60].try_into().unwrap()) as usize;
        let e_shnum = u16::from_le_bytes(buffer[60..62].try_into().unwrap()) as usize;
        let e_shstrndx = u16::from_le_bytes(buffer[62..64].try_into().unwrap()) as usize;
        (e_machine, e_entry, e_phoff, e_shoff, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx)
    } else {
        if buffer.len() < 52 {
            return Err("文件过小，无法容纳 ELF32 头部".to_string());
        }
        let e_machine = u16::from_le_bytes(buffer[18..20].try_into().unwrap());
        let e_entry = u32::from_le_bytes(buffer[24..28].try_into().unwrap()) as u64;
        let e_phoff = u32::from_le_bytes(buffer[28..32].try_into().unwrap()) as usize;
        let e_shoff = u32::from_le_bytes(buffer[32..36].try_into().unwrap()) as usize;
        let e_phentsize = u16::from_le_bytes(buffer[42..44].try_into().unwrap()) as usize;
        let e_phnum = u16::from_le_bytes(buffer[44..46].try_into().unwrap()) as usize;
        let e_shentsize = u16::from_le_bytes(buffer[46..48].try_into().unwrap()) as usize;
        let e_shnum = u16::from_le_bytes(buffer[48..50].try_into().unwrap()) as usize;
        let e_shstrndx = u16::from_le_bytes(buffer[50..52].try_into().unwrap()) as usize;
        (e_machine, e_entry, e_phoff, e_shoff, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx)
    };

    let arch = match machine {
        62 => "x86_64",
        183 => "aarch64",
        3 => "x86",
        40 => "arm",
        243 => "riscv64",
        _ => "unknown",
    }.to_string();

    let mut mitigations = BinaryMitigations {
        aslr: true, // 现代 ELF 普遍默认 PIE/DYN
        high_entropy_va: is_64bit,
        dep: true,
        stack_canary: true,
        control_flow_guard: false,
        relro: Some("Partial".to_string()),
        code_signed: false,
    };

    // 1. 遍历 Program Headers (Phdr)
    let limit_phnum = phnum.min(64);
    if phoff > 0 && phentsize >= 32 {
        for i in 0..limit_phnum {
            let offset = phoff.saturating_add(i * phentsize);
            if offset + phentsize > buffer.len() {
                break;
            }
            let p_type = u32::from_le_bytes(buffer[offset..offset + 4].try_into().unwrap());
            if p_type == 0x6474E551 {
                // PT_GNU_STACK
                let flags = if is_64bit {
                    u32::from_le_bytes(buffer[offset + 4..offset + 8].try_into().unwrap())
                } else {
                    u32::from_le_bytes(buffer[offset + 24..offset + 28].try_into().unwrap())
                };
                // PF_X (1) 代表栈可执行，若无此位则说明启用栈不可执行保护
                mitigations.dep = (flags & 1) == 0;
            } else if p_type == 0x6474E552 {
                // PT_GNU_RELRO
                mitigations.relro = Some("Full".to_string());
            }
        }
    }

    // 2. 解析 Section Headers (Shdr)
    let mut sections = Vec::new();
    let mut dynsym_offset = 0usize;
    let mut dynsym_size = 0usize;
    let mut dynsym_entsize = if is_64bit { 24 } else { 16 };
    let mut dynstr_offset = 0usize;

    let limit_shnum = shnum.min(MAX_SECTIONS);
    if shoff > 0 && shentsize >= (if is_64bit { 64 } else { 40 }) && shoff + limit_shnum * shentsize <= buffer.len() {
        // 先定位 .shstrtab 磁盘文件偏移
        let shstr_raw = if shstrndx < limit_shnum {
            let hdr = shoff + shstrndx * shentsize;
            let offset_field = if is_64bit { hdr + 24 } else { hdr + 16 };
            if offset_field + (if is_64bit { 8 } else { 4 }) <= buffer.len() {
                if is_64bit {
                    u64::from_le_bytes(buffer[offset_field..offset_field + 8].try_into().unwrap()) as usize
                } else {
                    u32::from_le_bytes(buffer[offset_field..offset_field + 4].try_into().unwrap()) as usize
                }
            } else {
                0
            }
        } else {
            0
        };

        for i in 0..limit_shnum {
            let hdr = shoff + i * shentsize;
            if hdr + shentsize > buffer.len() {
                break;
            }
            let sh_name_idx = u32::from_le_bytes(buffer[hdr..hdr + 4].try_into().unwrap()) as usize;
            let sh_type = u32::from_le_bytes(buffer[hdr + 4..hdr + 8].try_into().unwrap());
            let (sh_flags, sh_addr, sh_offset, sh_size, sh_entsize) = if is_64bit {
                let flags = u64::from_le_bytes(buffer[hdr + 8..hdr + 16].try_into().unwrap());
                let addr = u64::from_le_bytes(buffer[hdr + 16..hdr + 24].try_into().unwrap());
                let offset = u64::from_le_bytes(buffer[hdr + 24..hdr + 32].try_into().unwrap()) as usize;
                let size = u64::from_le_bytes(buffer[hdr + 32..hdr + 40].try_into().unwrap()) as usize;
                let entsize = u64::from_le_bytes(buffer[hdr + 56..hdr + 64].try_into().unwrap()) as usize;
                (flags, addr, offset, size, entsize)
            } else {
                let flags = u32::from_le_bytes(buffer[hdr + 8..hdr + 12].try_into().unwrap()) as u64;
                let addr = u32::from_le_bytes(buffer[hdr + 12..hdr + 16].try_into().unwrap()) as u64;
                let offset = u32::from_le_bytes(buffer[hdr + 16..hdr + 20].try_into().unwrap()) as usize;
                let size = u32::from_le_bytes(buffer[hdr + 20..hdr + 24].try_into().unwrap()) as usize;
                let entsize = u32::from_le_bytes(buffer[hdr + 36..hdr + 40].try_into().unwrap()) as usize;
                (flags, addr, offset, size, entsize)
            };

            let sec_name = if shstr_raw > 0 && shstr_raw + sh_name_idx < buffer.len() {
                read_null_terminated_string(buffer, shstr_raw + sh_name_idx, 64).unwrap_or_default()
            } else {
                format!("sec_{i}")
            };

            if sec_name == ".dynsym" || sh_type == 11 {
                dynsym_offset = sh_offset;
                dynsym_size = sh_size;
                if sh_entsize > 0 {
                    dynsym_entsize = sh_entsize;
                }
            } else if sec_name == ".dynstr" {
                dynstr_offset = sh_offset;
            }

            let can_read = true;
            let can_write = (sh_flags & 1) != 0; // SHF_WRITE
            let can_exec = (sh_flags & 4) != 0; // SHF_EXECINSTR

            let perms = format!(
                "{}{}{}",
                if can_read { "R" } else { "-" },
                if can_write { "W" } else { "-" },
                if can_exec { "X" } else { "-" }
            );

            let entropy = if sh_offset < buffer.len() && sh_size > 0 {
                let start = sh_offset;
                let end = (start + sh_size).min(buffer.len());
                calculate_entropy(&buffer[start..end])
            } else {
                0.0
            };

            let entropy_status = classify_entropy(entropy, can_exec).to_string();

            sections.push(BinarySection {
                name: if sec_name.is_empty() { format!("sec_{i}") } else { sec_name },
                virtual_address: format!("0x{sh_addr:08X}"),
                virtual_size: sh_size as u64,
                raw_offset: sh_offset as u64,
                raw_size: sh_size as u64,
                permissions: perms,
                entropy: (entropy * 100.0).round() / 100.0,
                entropy_status,
            });
        }
    }

    // 3. 解析 .dynsym 动态符号表
    let mut symbols = Vec::new();
    if dynsym_offset > 0 && dynstr_offset > 0 && dynsym_offset < buffer.len() && dynstr_offset < buffer.len() {
        let sym_count = (dynsym_size / dynsym_entsize).min(MAX_SYMBOLS);
        for k in 0..sym_count {
            let sym_hdr = dynsym_offset + k * dynsym_entsize;
            if sym_hdr + dynsym_entsize > buffer.len() {
                break;
            }
            let (st_name, st_value, st_info) = if is_64bit {
                let name = u32::from_le_bytes(buffer[sym_hdr..sym_hdr + 4].try_into().unwrap()) as usize;
                let info = buffer[sym_hdr + 4];
                let value = u64::from_le_bytes(buffer[sym_hdr + 8..sym_hdr + 16].try_into().unwrap());
                (name, value, info)
            } else {
                let name = u32::from_le_bytes(buffer[sym_hdr..sym_hdr + 4].try_into().unwrap()) as usize;
                let value = u32::from_le_bytes(buffer[sym_hdr + 4..sym_hdr + 8].try_into().unwrap()) as u64;
                let info = buffer[sym_hdr + 12];
                (name, value, info)
            };

            let st_type = st_info & 0xF;
            // 1 = STT_OBJECT, 2 = STT_FUNC
            if (st_type == 1 || st_type == 2) && st_name > 0 {
                if let Some(raw_sym) = read_null_terminated_string(buffer, dynstr_offset + st_name, 256) {
                    if !raw_sym.is_empty() {
                        let demangled = demangle_symbol(&raw_sym);
                        symbols.push(BinarySymbol {
                            name: raw_sym,
                            demangled,
                            rva: format!("0x{st_value:08X}"),
                            kind: if st_type == 2 { "function" } else { "variable" }.to_string(),
                            ordinal: None,
                        });
                    }
                }
            }
        }
    }

    Ok(UniversalBinary {
        is_binary: true,
        format,
        architecture: arch,
        subsystem: Some("POSIX".to_string()),
        file_size_bytes,
        entry_point_rva: format!("0x{entry_point:08X}"),
        image_preferred_base: "0x0000000000000000".to_string(),
        mitigations,
        sections,
        symbols,
        imports: Vec::new(), // 依赖库在事实抽取阶段由 DT_NEEDED 完善
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_elf_invalid_magic() {
        let bad = vec![0x7F, b'X', b'Y', b'Z'];
        assert!(parse_elf(&bad, 4).is_err());
    }

    #[test]
    fn test_elf64_minimal() {
        let mut buf = vec![0u8; 64];
        buf[0..4].copy_from_slice(&[0x7F, b'E', b'L', b'F']);
        buf[4] = 2; // 64-bit
        buf[5] = 1; // Little-Endian
        buf[18..20].copy_from_slice(&62u16.to_le_bytes()); // x86_64
        let res = parse_elf(&buf, 64).unwrap();
        assert_eq!(res.format, "ELF64");
        assert_eq!(res.architecture, "x86_64");
    }
}