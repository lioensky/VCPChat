"""Inspect Windows font registry entries and OpenType naming/coverage metadata."""

from __future__ import annotations

import argparse
import json
import os
import sys
import winreg
from pathlib import Path
from typing import Any

try:
    from fontTools.ttLib import TTCollection, TTFont
except ImportError as error:
    raise SystemExit(
        "缺少 fontTools。请执行：python -m pip install fonttools"
    ) from error


REGISTRY_ROOTS = (
    (
        winreg.HKEY_LOCAL_MACHINE,
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
        "HKLM",
    ),
    (
        winreg.HKEY_CURRENT_USER,
        r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
        "HKCU",
    ),
)

NAME_IDS = {
    1: "family",
    2: "subfamily",
    4: "fullName",
    6: "postScriptName",
    16: "typographicFamily",
    17: "typographicSubfamily",
}

PROBE_TEXTS = {
    "simplifiedChinese": "中文字体测试简体门龙",
    "traditionalChinese": "國體龍門測試",
    "latin": "ABCabc",
    "digits": "0123",
    "japanese": "日本語かなカナ",
    "korean": "한글시험",
}


def registry_entries() -> list[dict[str, str]]:
    """Return font registrations from machine-wide and per-user roots."""
    entries: list[dict[str, str]] = []
    windows_fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"

    for hive, key_path, root_name in REGISTRY_ROOTS:
        try:
            with winreg.OpenKey(hive, key_path) as key:
                value_count = winreg.QueryInfoKey(key)[1]
                for index in range(value_count):
                    display_name, raw_path, _value_type = winreg.EnumValue(key, index)
                    font_path = Path(os.path.expandvars(str(raw_path)))
                    if not font_path.is_absolute():
                        font_path = windows_fonts / font_path
                    entries.append(
                        {
                            "registryRoot": root_name,
                            "registryName": str(display_name),
                            "fontFile": str(font_path),
                        }
                    )
        except OSError as error:
            print(f"警告：无法读取 {root_name} 字体注册表：{error}", file=sys.stderr)

    return entries


def name_values(font: TTFont, name_id: int) -> list[dict[str, Any]]:
    """Read every localized value for an OpenType name ID."""
    values: list[dict[str, Any]] = []
    seen: set[tuple[str, int, int, int]] = set()

    if "name" not in font:
        return values

    for record in font["name"].names:
        if record.nameID != name_id:
            continue
        try:
            value = record.toUnicode().strip()
        except (UnicodeDecodeError, AttributeError):
            continue
        identity = (value, record.platformID, record.platEncID, record.langID)
        if not value or identity in seen:
            continue
        seen.add(identity)
        values.append(
            {
                "value": value,
                "platformId": record.platformID,
                "encodingId": record.platEncID,
                "languageId": f"0x{record.langID:04x}",
            }
        )

    return values


def unicode_codepoints(font: TTFont) -> set[int]:
    """Collect all Unicode codepoints declared by every cmap table."""
    if "cmap" not in font:
        return set()
    return {
        codepoint
        for table in font["cmap"].tables
        if table.isUnicode()
        for codepoint in table.cmap
    }


def coverage_report(codepoints: set[int]) -> dict[str, Any]:
    """Measure representative script coverage without rendering the font."""
    probes = {
        label: {
            "text": text,
            "supported": "".join(
                character for character in text if ord(character) in codepoints
            ),
            "missing": "".join(
                character for character in text if ord(character) not in codepoints
            ),
            "complete": all(ord(character) in codepoints for character in text),
        }
        for label, text in PROBE_TEXTS.items()
    }
    return {
        "probes": probes,
        "cjkUnifiedIdeographs": sum(
            codepoint in codepoints for codepoint in range(0x4E00, 0xA000)
        ),
        "cjkExtensionA": sum(
            codepoint in codepoints for codepoint in range(0x3400, 0x4DC0)
        ),
        "totalUnicodeCodepoints": len(codepoints),
    }


def css_family_candidates(names: dict[str, list[dict[str, Any]]]) -> list[str]:
    """Order likely CSS family identifiers by OpenType naming semantics."""
    candidates: list[str] = []
    for category in ("typographicFamily", "family", "fullName", "postScriptName"):
        for item in names.get(category, []):
            value = item["value"]
            if value not in candidates:
                candidates.append(value)
    return candidates


def inspect_face(
    font: TTFont,
    entry: dict[str, str],
    face_index: int,
) -> dict[str, Any]:
    """Inspect one face from a TTF/OTF/TTC/OTC file."""
    names = {
        label: name_values(font, name_id)
        for name_id, label in NAME_IDS.items()
    }
    codepoints = unicode_codepoints(font)
    return {
        **entry,
        "faceIndex": face_index,
        "names": names,
        "cssFamilyCandidates": css_family_candidates(names),
        "coverage": coverage_report(codepoints),
    }


def inspect_entry(entry: dict[str, str]) -> list[dict[str, Any]]:
    """Inspect all faces represented by one registry entry."""
    font_path = Path(entry["fontFile"])
    if not font_path.is_file():
        return [{**entry, "error": "字体文件不存在或当前用户不可读取"}]

    try:
        suffix = font_path.suffix.lower()
        if suffix in {".ttc", ".otc"}:
            collection = TTCollection(str(font_path), lazy=True)
            return [
                inspect_face(font, entry, index)
                for index, font in enumerate(collection.fonts)
            ]

        font = TTFont(str(font_path), lazy=True)
        try:
            return [inspect_face(font, entry, 0)]
        finally:
            font.close()
    except Exception as error:  # Font files can be malformed or unsupported.
        return [{**entry, "error": f"{type(error).__name__}: {error}"}]


def matches_filter(entry: dict[str, str], query: str) -> bool:
    """Match a case-insensitive query against registry name and file path."""
    if not query:
        return True
    haystack = f"{entry['registryName']}\n{entry['fontFile']}".casefold()
    return query.casefold() in haystack


def summarize(records: list[dict[str, Any]]) -> None:
    """Print a concise UTF-8 summary suitable for redirected terminal output."""
    for record in records:
        print(f"\n[{record.get('registryRoot')}] {record.get('registryName')}")
        print(f"  文件：{record.get('fontFile')}")
        if record.get("error"):
            print(f"  错误：{record['error']}")
            continue

        candidates = record.get("cssFamilyCandidates", [])
        print(f"  CSS 候选：{' | '.join(candidates) or '未找到'}")
        coverage = record["coverage"]
        simplified = coverage["probes"]["simplifiedChinese"]
        traditional = coverage["probes"]["traditionalChinese"]
        print(
            "  覆盖："
            f"简体测试={'完整' if simplified['complete'] else '不完整'}，"
            f"繁体测试={'完整' if traditional['complete'] else '不完整'}，"
            f"CJK 基本区={coverage['cjkUnifiedIdeographs']} 字"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="调查 Windows 注册字体的真实 OpenType 名称和字形覆盖范围。"
    )
    parser.add_argument(
        "query",
        nargs="?",
        default="",
        help="可选过滤词，例如“蒙纳”“方正”或字体文件名。",
    )
    parser.add_argument(
        "--output",
        default="ScriptoriumModules/font-name-diagnostics.json",
        help="UTF-8 JSON 报告路径。",
    )
    arguments = parser.parse_args()

    selected = [
        entry
        for entry in registry_entries()
        if matches_filter(entry, arguments.query)
    ]
    records = [
        record
        for entry in selected
        for record in inspect_entry(entry)
    ]

    output_path = Path(arguments.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    summarize(records)
    print(f"\n已写入 {output_path}，共 {len(records)} 个字体 face。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())