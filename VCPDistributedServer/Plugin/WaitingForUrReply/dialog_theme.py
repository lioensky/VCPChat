"""One-shot VChat CSS palette snapshot; no GUI or third-party dependencies."""
import json
import re
import sys
from pathlib import Path


def _rgb(value):
    value = value.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", value):
        return tuple(int(c * 2, 16) for c in value[1:]), 1.0
    if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return tuple(int(value[i:i + 2], 16) for i in (1, 3, 5)), 1.0
    match = re.fullmatch(r"(rgb|rgba)\(([^()]+)\)", value, re.I)
    if match:
        parts = [float(p.strip()) for p in match[2].split(",")]
        if len(parts) != (4 if match[1].lower() == "rgba" else 3):
            raise ValueError("Invalid color components")
        if not all(0 <= c <= 255 for c in parts[:3]):
            raise ValueError("Invalid RGB")
        alpha = parts[3] if len(parts) == 4 else 1.0
        if not 0 <= alpha <= 1:
            raise ValueError("Invalid alpha")
        return tuple(round(c) for c in parts[:3]), alpha
    raise ValueError("Unsupported CSS color")


def read_dialog_theme(root=None):
    """Return only validated opaque #RRGGBB colors; failures keep WPF defaults."""
    try:
        # Plugin lives at <VChat>/VCPDistributedServer/Plugin/WaitingForUrReply.
        root = Path(root) if root is not None else Path(__file__).resolve().parents[3]
        settings = json.loads((root / "AppData/settings.json").read_text(encoding="utf-8-sig"))
        mode = settings.get("currentThemeMode", "dark")
        if mode == "system":
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                               r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
                mode = "light" if winreg.QueryValueEx(key, "AppsUseLightTheme")[0] else "dark"
        if mode not in ("light", "dark"):
            mode = "dark"
        css = (root / "styles/themes.css").read_text(encoding="utf-8-sig")
        css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        values = {}
        # Deliberately limited to global palettes, not descendant/component rules.
        for selectors, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css):
            selectors = [s.strip() for s in selectors.split(",")]
            base = any(s in (":root", "body") for s in selectors)
            dark = any(re.fullmatch(r"""body\[data-vcp-theme\s*=\s*['"]dark['"]\]""", s) for s in selectors)
            light = any(s == "body.light-theme" or
                        re.fullmatch(r"""body\[data-vcp-theme\s*=\s*['"]light['"]\]""", s)
                        for s in selectors)
            if not (base or (light if mode == "light" else dark)):
                continue
            values.update(re.findall(r"(--[\w-]+)\s*:\s*([^;{}]+)\s*;", body))

        def resolve(name, seen=()):
            if name in seen or len(seen) > 16:
                raise ValueError("Cyclic CSS variable")
            value = values[name].strip()
            value = re.sub(r"\s*!important\s*$", "", value)
            alias = re.fullmatch(r"var\(\s*(--[\w-]+)\s*\)", value)
            return resolve(alias[1], (*seen, name)) if alias else value

        base_rgb, _ = _rgb(resolve("--primary-bg"))

        def color(name):
            rgb, alpha = _rgb(resolve(name))
            # Opaque card: alpha blends against the theme, not the desktop wallpaper.
            rgb = tuple(round(c * alpha + b * (1 - alpha)) for c, b in zip(rgb, base_rgb))
            return "#" + "".join(f"{c:02X}" for c in rgb)

        mapping = {
            "#141E1B": "--primary-bg", "#202D29": "--accent-bg",
            "#0D1613": "--input-bg", "#EDF3F1": "--primary-text",
            "#D5E1DC": "--primary-text", "#B7C7C2": "--secondary-text",
            "#8AA297": "--secondary-text", "#627B6F": "--placeholder-text",
            "#35483F": "--border-color", "#34483F": "--border-color",
            "#86E5BA": "--highlight-text", "#10251A": "--text-on-accent",
        }
        palette = {}
        for old, variable in mapping.items():
            try:
                palette[old] = color(variable)
            except (KeyError, ValueError):
                # Optional tokens fall back to other theme tokens before old defaults.
                fallback = {"--placeholder-text": "--secondary-text",
                            "--input-bg": "--tertiary-bg",
                            "--text-on-accent": "--vcp-ui-on-accent"}.get(variable)
                if fallback:
                    try:
                        palette[old] = color(fallback)
                    except (KeyError, ValueError):
                        pass
        return palette
    except (OSError, ValueError, ImportError, KeyError) as error:
        print(f"Dialog theme fallback: {error}", file=sys.stderr)
        return {}