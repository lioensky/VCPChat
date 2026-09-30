#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通用的项目文件目录 .md 生成器 (Universal Project Directory Markdown Generator)
- 零外部依赖，纯 Python 3 标准库，开箱即用、跨平台支持。
- 自动智能跳过：编译构建目录、第三方依赖、Python虚拟环境与运行时缓存、前端Web打包产物、AppData/用户数据及临时日志等。
- 支持最大深度控制、自定义排除/包含、指定文件后缀过滤、只显示目录、空目录裁剪等。
- 生成规范美观的 Markdown 文档（包含文件类型统计表、树状结构图、排除规则明细）。
"""

import os
import sys
import fnmatch
import argparse
from pathlib import Path
from datetime import datetime
from collections import Counter

# 解决 Windows 控制台打印中文可能出现的乱码问题
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# 默认跳过的目录名称集合（匹配时不区分大小写）
DEFAULT_EXCLUDE_DIRS = {
    # ── 版本控制 ──
    ".git", ".svn", ".hg",

    # ── 第三方依赖目录 ──
    "node_modules", "bower_components", "jspm_packages", "vendor",
    ".pnpm-store", ".yarn", "packages", "pods", "carthage",

    # ── Python 虚拟环境、运行时与测试缓存 ──
    "__pycache__", ".venv", "venv", "env", "ENV", ".virtualenv",
    ".tox", ".nox", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".hypothesis", ".pyre", "pip-wheel-metadata", ".ipynb_checkpoints",
    "wheelhouse",

    # ── 编译、构建与二进制生成目录 ──
    "build", "dist", "out", "output", "target", "bin", "obj", "pkg",
    "release", "debug", "x64", "x86", "arm64",
    ".gradle", ".m2",

    # ── 前端 / Web 构建产物与打包缓存 ──
    ".next", ".nuxt", ".output", ".astro", ".svelte-kit", ".docusaurus",
    ".cache", ".parcel-cache", ".turbo", ".vite", ".webpack",
    "storybook-static", "coverage", "htmlcov",

    # ── AppData、用户数据、本地存储与日志 ──
    "appdata", "userdata", "user_data", "data_cache",
    "logs", "temp", "tmp", ".temp", ".tmp",
    "sessions", "local_storage", "indexeddb",

    # ── IDE 与编辑器私有配置 ──
    ".idea", ".vscode", ".vs",
}

# 默认跳过的目录通配符模式（匹配时不区分大小写）
DEFAULT_EXCLUDE_DIR_PATTERNS = [
    "cmake-build-*",
    "*.egg-info",
    "*.dist-info",
    "*.tmp",
]

# 默认跳过的文件通配符模式（匹配时不区分大小写）
DEFAULT_EXCLUDE_FILE_PATTERNS = [
    # 系统缩略图与临时标记
    ".DS_Store", "Thumbs.db", "desktop.ini",
    # 编译中间产物与字节码
    "*.pyc", "*.pyo", "*.pyd",
    "*.o", "*.obj", "*.class", "*.tsbuildinfo",
    # 运行时日志与临时备份
    "*.log", "*.tmp", "*.temp", "*.swp", "*.swo", "*.bak", "*~",
    # 数据库临时文件与锁
    "*.suo", "*.user",
]

# 常见后缀描述映射（用于统计表格中文归类展示）
EXT_CATEGORY_MAP = {
    ".js": "JavaScript",
    ".mjs": "JavaScript (ESM)",
    ".cjs": "JavaScript (CommonJS)",
    ".ts": "TypeScript",
    ".tsx": "TypeScript (React)",
    ".jsx": "JavaScript (React)",
    ".vue": "Vue",
    ".svelte": "Svelte",
    ".html": "HTML",
    ".htm": "HTML",
    ".css": "CSS",
    ".scss": "SCSS/Sass",
    ".sass": "Sass",
    ".less": "Less",
    ".py": "Python",
    ".rs": "Rust",
    ".go": "Go",
    ".c": "C",
    ".cpp": "C++",
    ".cc": "C++",
    ".h": "C/C++ Header",
    ".hpp": "C++ Header",
    ".java": "Java",
    ".kt": "Kotlin",
    ".cs": "C#",
    ".swift": "Swift",
    ".php": "PHP",
    ".rb": "Ruby",
    ".md": "Markdown",
    ".json": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".toml": "TOML",
    ".xml": "XML",
    ".sh": "Shell Script",
    ".bash": "Bash Script",
    ".zsh": "Zsh Script",
    ".bat": "Batch Script",
    ".vbs": "VBScript",
    ".ps1": "PowerShell",
    ".sql": "SQL",
    ".svg": "SVG Vector Image",
    ".png": "PNG Image",
    ".jpg": "JPEG Image",
    ".jpeg": "JPEG Image",
    ".webp": "WebP Image",
    ".gif": "GIF Image",
    ".ico": "Icon",
    ".mp3": "Audio (MP3)",
    ".wav": "Audio (WAV)",
    ".flac": "Audio (FLAC)",
    ".ogg": "Audio (OGG)",
    ".ttf": "TTF Font",
    ".otf": "OTF Font",
    ".woff": "WOFF Font",
    ".woff2": "WOFF2 Font",
    ".txt": "Plain Text",
    ".exe": "EXE 运行时/可执行程序",
}


def load_gitignore_patterns(root_path: Path):
    """解析根目录下的 .gitignore 文件，提取忽略规则"""
    gitignore_file = root_path / ".gitignore"
    patterns = []
    if gitignore_file.is_file():
        try:
            with open(gitignore_file, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    patterns.append(line)
        except Exception:
            pass
    return patterns


class ProjectTreeGenerator:
    def __init__(
        self,
        root_dir: str = ".",
        max_depth: int = None,
        extra_excludes=None,
        include_exts=None,
        dirs_only: bool = False,
        prune_empty: bool = True,
        use_gitignore: bool = True,
        title: str = None,
    ):
        self.root_path = Path(root_dir).resolve()
        self.max_depth = max_depth
        self.dirs_only = dirs_only
        self.prune_empty = prune_empty
        self.use_gitignore = use_gitignore
        self.title = title or f"{self.root_path.name} 项目文件目录结构"

        # 整理默认与自定义排除集合
        self.exclude_dirs = set(d.lower() for d in DEFAULT_EXCLUDE_DIRS)
        self.exclude_dir_patterns = list(DEFAULT_EXCLUDE_DIR_PATTERNS)
        self.exclude_file_patterns = list(DEFAULT_EXCLUDE_FILE_PATTERNS)

        if extra_excludes:
            for item in extra_excludes:
                item_clean = item.strip()
                if not item_clean:
                    continue
                if "/" in item_clean or "\\" in item_clean or "*" in item_clean or "?" in item_clean:
                    self.exclude_dir_patterns.append(item_clean.lower())
                    self.exclude_file_patterns.append(item_clean)
                else:
                    self.exclude_dirs.add(item_clean.lower())
                    self.exclude_file_patterns.append(item_clean)

        # 整理后缀包含筛选
        self.include_exts = None
        if include_exts:
            self.include_exts = set(
                (ext if ext.startswith(".") else f".{ext}").lower()
                for ext in include_exts
            )

        # 加载 .gitignore
        self.gitignore_patterns = []
        if self.use_gitignore:
            self.gitignore_patterns = load_gitignore_patterns(self.root_path)

        # 统计计数
        self.total_dirs = 0
        self.total_files = 0
        self.ext_counter = Counter()

    def should_ignore_dir(self, dir_name: str, dir_path: Path) -> bool:
        """检查目录是否应该被跳过"""
        dir_lower = dir_name.lower()

        # 1. 明确的排除集合
        if dir_lower in self.exclude_dirs:
            return True

        # 2. 通配符模式匹配
        for pattern in self.exclude_dir_patterns:
            if fnmatch.fnmatch(dir_lower, pattern.lower()):
                return True

        # 3. gitignore 规则匹配
        try:
            rel_str = str(dir_path.relative_to(self.root_path)).replace("\\", "/")
        except ValueError:
            rel_str = dir_name

        for pattern in self.gitignore_patterns:
            p = pattern.rstrip("/").lower()
            if fnmatch.fnmatch(dir_lower, p) or fnmatch.fnmatch(rel_str.lower(), p):
                return True

        return False

    def should_ignore_file(self, file_name: str, file_path: Path) -> bool:
        """检查文件是否应该被跳过"""
        file_lower = file_name.lower()

        # 1. 指定白名单后缀过滤
        if self.include_exts is not None:
            ext = file_path.suffix.lower()
            if ext not in self.include_exts:
                return True

        # 2. 通配符模式匹配
        for pattern in self.exclude_file_patterns:
            if fnmatch.fnmatch(file_lower, pattern.lower()):
                return True

        # 3. gitignore 规则匹配
        try:
            rel_str = str(file_path.relative_to(self.root_path)).replace("\\", "/")
        except ValueError:
            rel_str = file_name

        for pattern in self.gitignore_patterns:
            p = pattern.rstrip("/").lower()
            if fnmatch.fnmatch(file_lower, p) or fnmatch.fnmatch(rel_str.lower(), p):
                return True

        return False

    def build_tree_structure(self, current_dir: Path, current_depth: int = 0):
        """递归扫描目录并构建树节点结构"""
        if self.max_depth is not None and current_depth > self.max_depth:
            return None

        try:
            entries = list(os.scandir(current_dir))
        except (PermissionError, FileNotFoundError, OSError):
            return None

        dirs = []
        files = []

        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    entry_path = Path(entry.path)
                    if not self.should_ignore_dir(entry.name, entry_path):
                        dirs.append(entry)
                elif entry.is_file(follow_symlinks=False):
                    if not self.dirs_only:
                        entry_path = Path(entry.path)
                        if not self.should_ignore_file(entry.name, entry_path):
                            files.append(entry)
            except OSError:
                continue

        dirs.sort(key=lambda e: e.name.lower())
        files.sort(key=lambda e: e.name.lower())

        sub_trees = []
        # 若未达最大深度，则继续递归钻取子目录；达最大深度时停止深入子目录，但保留当前目录自身文件
        can_go_deeper = (self.max_depth is None or current_depth < self.max_depth)
        if can_go_deeper:
            for d in dirs:
                subtree = self.build_tree_structure(Path(d.path), current_depth + 1)
                if subtree is not None:
                    if self.prune_empty and subtree["empty"]:
                        continue
                    sub_trees.append(subtree)

        node_empty = (len(files) == 0 and all(st["empty"] for st in sub_trees))

        return {
            "name": current_dir.name if current_depth > 0 else (self.root_path.name or "."),
            "path": current_dir,
            "depth": current_depth,
            "dirs": sub_trees,
            "files": files,
            "empty": node_empty,
        }

    def render_tree(self, node, prefix: str = "", is_last: bool = True) -> list:
        """渲染成标准树状结构文本"""
        lines = []

        if node["depth"] == 0:
            lines.append(f"{node['name']}/")
        else:
            connector = "└── " if is_last else "├── "
            lines.append(f"{prefix}{connector}{node['name']}/")

        self.total_dirs += 1
        child_prefix = prefix + ("    " if is_last else "│   ") if node["depth"] > 0 else ""

        items = []
        for d in node["dirs"]:
            items.append(("dir", d))
        for f in node["files"]:
            items.append(("file", f))

        count = len(items)
        for idx, (kind, item) in enumerate(items):
            last_item = (idx == count - 1)
            if kind == "dir":
                sub_lines = self.render_tree(item, prefix=child_prefix, is_last=last_item)
                lines.extend(sub_lines)
            else:
                f_name = item.name
                f_path = Path(item.path)
                f_ext = f_path.suffix.lower() or "(无扩展名)"
                self.ext_counter[f_ext] += 1
                self.total_files += 1

                f_connector = "└── " if last_item else "├── "
                lines.append(f"{child_prefix}{f_connector}{f_name}")

        return lines

    def generate_markdown(self) -> str:
        """完整生成 Markdown 文本"""
        self.total_dirs = 0
        self.total_files = 0
        self.ext_counter.clear()

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 构建目录树
        root_node = self.build_tree_structure(self.root_path, current_depth=0)
        tree_lines = []
        if root_node:
            tree_lines = self.render_tree(root_node, prefix="", is_last=True)
            # 根节点自身不计入子目录计数
            if self.total_dirs > 0:
                self.total_dirs -= 1

        # 统计表格
        stats_rows = []
        for ext, count in self.ext_counter.most_common():
            cat = EXT_CATEGORY_MAP.get(ext, ext)
            stats_rows.append(f"| {cat} | `{ext}` | {count} |")

        # 排序后的排除关键字
        sorted_excludes = sorted(list(self.exclude_dirs))

        md = []
        md.append(f"# {self.title}\n")
        md.append(f"> 自动生成于：{now_str}  \n")
        md.append(f"> 项目根目录：`{self.root_path}`  \n")
        if self.max_depth is not None:
            md.append(f"> 扫描最大深度：{self.max_depth} 层  \n")
        if self.include_exts:
            ext_list = "、".join(f"`{e}`" for e in sorted(self.include_exts))
            md.append(f"> 筛选文件类型：{ext_list}  \n")
        md.append(f"> 扫描说明：已自动跳过版本控制、编译产物、依赖包、Python虚拟环境与运行时、构建与Web生成目录、AppData/用户数据等。\n")

        md.append("## 文件统计\n")
        md.append(f"- **总目录数**：{self.total_dirs}")
        md.append(f"- **总文件数**：{self.total_files}")
        md.append(f"- **文件类型数**：{len(self.ext_counter)}\n")

        if stats_rows and not self.dirs_only:
            md.append("| 类型 | 扩展名 | 数量 |")
            md.append("| :--- | :--- | ---: |")
            md.extend(stats_rows)
            md.append(f"| **合计** | - | **{self.total_files}** |")
            md.append("")

        md.append("## 目录结构树\n")
        md.append("```text")
        md.extend(tree_lines)
        md.append("```\n")

        md.append("## 排除规则列表\n")
        md.append("<details>")
        md.append("<summary>点击展开查看已排除的目录与文件规则</summary>\n")
        md.append("- **默认跳过目录名称**：")
        md.append("  `" + "`, `".join(sorted_excludes) + "`")
        md.append("- **默认通配符排除**：")
        md.append("  `" + "`, `".join(self.exclude_dir_patterns + self.exclude_file_patterns) + "`")
        if self.use_gitignore and self.gitignore_patterns:
            md.append(f"- **.gitignore 生效规则**：共 {len(self.gitignore_patterns)} 条规则已并入跳过逻辑")
        md.append("</details>\n")

        return "\n".join(md)


def main():
    parser = argparse.ArgumentParser(
        description="通用项目文件目录 .md 生成器 (跳过编译产物、依赖、Python运行时、dist/web产物、appdata等)"
    )
    parser.add_argument(
        "-r", "--root",
        default=".",
        help="目标扫描根目录 (默认为当前目录 .)"
    )
    parser.add_argument(
        "-o", "--output",
        default="PROJECT_STRUCTURE.md",
        help="输出 Markdown 文件路径 (默认: PROJECT_STRUCTURE.md；传入 '-' 则直接输出到终端)"
    )
    parser.add_argument(
        "-L", "--max-depth",
        type=int,
        default=None,
        help="扫描最大深度层级 (默认不限深度)"
    )
    parser.add_argument(
        "-e", "--exclude",
        action="append",
        default=[],
        help="额外排除的目录或文件模式 (可多次使用，如 -e my_cache -e '*.log')"
    )
    parser.add_argument(
        "--ext", "--include-ext",
        dest="include_ext",
        action="append",
        default=[],
        help="只包含指定后缀的文件 (可多次使用，如 --ext .py --ext .js 或 --ext js,ts,py)"
    )
    parser.add_argument(
        "-d", "--dirs-only",
        action="store_true",
        help="仅生成目录树，不包含具体文件"
    )
    parser.add_argument(
        "--keep-empty",
        action="store_true",
        help="保留已被过滤空的目录 (默认会自动裁剪空目录)"
    )
    parser.add_argument(
        "--no-gitignore",
        action="store_true",
        help="不自动解析和应用根目录下的 .gitignore 规则"
    )
    parser.add_argument(
        "-t", "--title",
        default=None,
        help="自定义 Markdown 一级标题"
    )

    args = parser.parse_args()

    # 处理 include_ext 参数可能包含逗号的情况
    include_exts = []
    for item in args.include_ext:
        for sub in item.split(","):
            sub = sub.strip()
            if sub:
                include_exts.append(sub)

    generator = ProjectTreeGenerator(
        root_dir=args.root,
        max_depth=args.max_depth,
        extra_excludes=args.exclude,
        include_exts=include_exts if include_exts else None,
        dirs_only=args.dirs_only,
        prune_empty=not args.keep_empty,
        use_gitignore=not args.no_gitignore,
        title=args.title,
    )

    md_content = generator.generate_markdown()

    if args.output == "-":
        sys.stdout.buffer.write(md_content.encode("utf-8"))
        sys.stdout.buffer.write(b"\n")
    else:
        out_path = Path(args.output).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(md_content)
        print(f"[OK] 成功生成目录结构文档: {out_path}")
        print(f"     统计: {generator.total_dirs} 个目录, {generator.total_files} 个文件, {len(generator.ext_counter)} 种文件类型")


if __name__ == "__main__":
    main()