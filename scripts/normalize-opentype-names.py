"""Create a compatibility copy of a TrueType/OpenType font with normalized names.

This tool never overwrites the source font. By default it only prints the
planned name-table changes. Pass --write to create a new local test copy.

An OS/2 fsType value is reported as a technical embedding flag only. It does
not replace or interpret the font's copyright/license agreement.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

try:
    from fontTools.ttLib import TTFont
except ImportError as error:
    raise SystemExit(
        "缺少 fontTools。请执行：python -m pip install fonttools"
    ) from error


NAME_IDS_TO_REPLACE = {1, 2, 3, 4, 6, 16, 17, 21, 22}
WINDOWS_EN_US = 0x0409
WINDOWS_ZH_CN = 0x0804
MAC_ENGLISH = 0
MAC_SIMPLIFIED_CHINESE = 33

EMBEDDING_FLAGS = {
    0x0000: "Installable embedding",
    0x0002: "Restricted License embedding",
    0x0004: "Preview & Print embedding",
    0x0008: "Editable embedding",
}


def safe_postscript_name(value: str) -> str:
    """Return a conservative ASCII PostScript name."""
    normalized = re.sub(r"[^A-Za-z0-9-]+", "-", value.strip())
    normalized = re.sub(r"-+", "-", normalized).strip("-")
    if not normalized:
        raise ValueError("PostScript 名称转换后为空。")
    return normalized[:63]


def existing_names(font: TTFont, name_id: int) -> list[str]:
    """Read unique Unicode values for one OpenType name ID."""
    values: list[str] = []
    if "name" not in font:
        return values
    for record in font["name"].names:
        if record.nameID != name_id:
            continue
        try:
            value = record.toUnicode().strip()
        except (UnicodeDecodeError, AttributeError):
            continue
        if value and value not in values:
            values.append(value)
    return values


def embedding_description(font: TTFont) -> tuple[int | None, str]:
    """Return the raw fsType and a human-readable technical description."""
    if "OS/2" not in font:
        return None, "No OS/2 table"
    fs_type = int(font["OS/2"].fsType)
    if fs_type in EMBEDDING_FLAGS:
        return fs_type, EMBEDDING_FLAGS[fs_type]
    flags = [
        description
        for bit, description in EMBEDDING_FLAGS.items()
        if bit and fs_type & bit
    ]
    return fs_type, " | ".join(flags) or f"Other flags: 0x{fs_type:04x}"


def set_name(
    font: TTFont,
    name_id: int,
    english: str,
    chinese: str | None = None,
) -> None:
    """Write consistent Windows and Macintosh localized name records."""
    name_table = font["name"]
    chinese_value = chinese or english

    # Windows Unicode records are the most important records for DirectWrite.
    name_table.setName(english, name_id, 3, 1, WINDOWS_EN_US)
    name_table.setName(chinese_value, name_id, 3, 1, WINDOWS_ZH_CN)

    # Platform 3 / encoding 10 allows full Unicode names where supported.
    name_table.setName(english, name_id, 3, 10, WINDOWS_EN_US)
    name_table.setName(chinese_value, name_id, 3, 10, WINDOWS_ZH_CN)

    # Compatibility copies target Windows DirectWrite/Chromium. Do not create
    # legacy Macintosh records: setName defers encoding until font.save(), so a
    # Chinese primary family would fail later under the Mac Roman codec.


def normalized_copy(
    source: Path,
    output: Path,
    family: str,
    localized_family: str,
    postscript_family: str,
    write: bool,
) -> None:
    """Inspect or write one font with a normalized OpenType name table."""
    font = TTFont(str(source), recalcTimestamp=False)
    try:
        if "name" not in font:
            raise ValueError("字体没有 OpenType name 表。")
        if "cmap" not in font or not any(
            table.isUnicode() for table in font["cmap"].tables
        ):
            raise ValueError("字体没有 Unicode cmap，不能只靠名称规范化兼容。")

        fs_type, embedding = embedding_description(font)
        unique_id = f"{family}; Regular; VCP compatibility copy"
        full_name = family
        postscript_name = safe_postscript_name(
            f"{postscript_family}-Regular"
        )

        print(f"源文件：{source}")
        print(f"输出：{output}")
        print(f"fsType：{fs_type}（{embedding}）")
        print(f"旧 family：{' | '.join(existing_names(font, 1)) or '无'}")
        print(f"旧 typographic family：{' | '.join(existing_names(font, 16)) or '无'}")
        print(f"新英文 family：{family}")
        print(f"新中文 family：{localized_family}")
        print(f"新 PostScript：{postscript_name}")

        if not write:
            print("分析完成；未写文件。加入 --write 才会生成兼容副本。")
            return

        # Remove stale family/full-name records across every platform/language.
        font["name"].names = [
            record
            for record in font["name"].names
            if record.nameID not in NAME_IDS_TO_REPLACE
        ]

        set_name(font, 1, family, localized_family)
        set_name(font, 2, "Regular", "Regular")
        set_name(font, 3, unique_id, unique_id)
        set_name(font, 4, full_name, localized_family)
        set_name(font, 6, postscript_name, postscript_name)
        set_name(font, 16, family, localized_family)
        set_name(font, 17, "Regular", "Regular")

        # WWS family/subfamily improve matching in consumers that prefer IDs 21/22.
        set_name(font, 21, family, localized_family)
        set_name(font, 22, "Regular", "Regular")

        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists():
            raise FileExistsError(
                f"输出文件已存在，拒绝覆盖：{output}"
            )
        font.save(str(output), reorderTables=True)
        print(f"已生成兼容副本：{output}")
        print("请先在 Windows 字体预览器核对名称，再安装并重启 Chrome 测试。")
    finally:
        font.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="生成 OpenType 名称表规范化的本地测试副本。",
    )
    parser.add_argument("source", type=Path, help="源 TTF/OTF 文件")
    parser.add_argument(
        "--family",
        required=True,
        help="新的 ASCII/英文 CSS family，例如 VCP Founder LiBian",
    )
    parser.add_argument(
        "--localized-family",
        help="新的中文 family；省略时与 --family 相同",
    )
    parser.add_argument(
        "--postscript-family",
        help="PostScript family；省略时由 --family 生成",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="输出路径；省略时写入 font-compat-output 目录",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="实际生成副本；默认仅分析",
    )
    arguments = parser.parse_args()

    source = arguments.source.resolve()
    if not source.is_file():
        raise SystemExit(f"源字体不存在：{source}")
    if source.suffix.lower() not in {".ttf", ".otf"}:
        raise SystemExit("当前脚本只处理单字体 TTF/OTF，不处理 TTC/OTC。")

    family = arguments.family.strip()
    localized_family = (
        arguments.localized_family.strip()
        if arguments.localized_family
        else family
    )
    postscript_family = (
        arguments.postscript_family.strip()
        if arguments.postscript_family
        else safe_postscript_name(family)
    )

    output = arguments.output
    if output is None:
        output = (
            Path("font-compat-output")
            / f"{safe_postscript_name(postscript_family)}-Regular.ttf"
        )
    output = output.resolve()

    if source == output:
        raise SystemExit("输出路径不能与源字体相同。")

    try:
        normalized_copy(
            source,
            output,
            family,
            localized_family,
            postscript_family,
            arguments.write,
        )
    except Exception as error:
        print(f"转换失败：{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())