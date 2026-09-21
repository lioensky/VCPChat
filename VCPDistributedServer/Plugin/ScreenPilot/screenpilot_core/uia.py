# -*- coding: utf-8 -*-
"""Windows UI Automation 探测、短期元素引用与语义动作。"""

import hashlib
import json
import time
import uuid

from .errors import ScreenPilotError

_INTERACTIVE_TYPES = {
    "ButtonControl", "EditControl", "MenuItemControl", "CheckBoxControl",
    "RadioButtonControl", "ComboBoxControl", "HyperlinkControl",
    "ListItemControl", "TreeItemControl", "TabItemControl",
    "SliderControl", "SpinnerControl", "ToolBarControl",
    "MenuBarControl", "DataItemControl", "ScrollBarControl",
}

_TYPE_ALIASES = {
    "button": "ButtonControl",
    "edit": "EditControl",
    "menuitem": "MenuItemControl",
    "checkbox": "CheckBoxControl",
    "radiobutton": "RadioButtonControl",
    "combobox": "ComboBoxControl",
    "hyperlink": "HyperlinkControl",
    "listitem": "ListItemControl",
    "treeitem": "TreeItemControl",
    "tabitem": "TabItemControl",
    "slider": "SliderControl",
    "spinner": "SpinnerControl",
    "toolbar": "ToolBarControl",
    "menubar": "MenuBarControl",
    "dataitem": "DataItemControl",
    "scrollbar": "ScrollBarControl",
}

_ELEMENT_TTL_SECONDS = 120
_ELEMENT_CACHE_LIMIT = 1000
_element_cache = {}


def _safe(getter, default=None):
    try:
        return getter()
    except Exception:
        return default


def _normalize_type(value):
    if not value:
        return None
    normalized = str(value).strip().lower().replace(" ", "")
    if normalized in _TYPE_ALIASES:
        return _TYPE_ALIASES[normalized]
    for candidate in _INTERACTIVE_TYPES:
        if normalized in (candidate.lower(), candidate.lower().replace("control", "")):
            return candidate
    return str(value)


def _runtime_id(control):
    value = _safe(lambda: control.GetRuntimeId(), None)
    if value is None:
        return None
    try:
        return [int(item) for item in value]
    except Exception:
        return list(value) if hasattr(value, "__iter__") else [str(value)]


def _fingerprint(hwnd, info):
    stable = {
        "hwnd": int(hwnd),
        "runtimeId": info.get("runtimeId"),
        "automationId": info.get("automationId"),
        "controlType": info.get("controlType"),
        "name": info.get("name"),
    }
    encoded = json.dumps(stable, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def _sweep_cache():
    now = time.monotonic()
    expired = [
        key for key, value in _element_cache.items()
        if now - value["createdAt"] > _ELEMENT_TTL_SECONDS
    ]
    for key in expired:
        _element_cache.pop(key, None)

    if len(_element_cache) > _ELEMENT_CACHE_LIMIT:
        oldest = sorted(
            _element_cache.items(),
            key=lambda item: item[1]["createdAt"],
        )[:len(_element_cache) - _ELEMENT_CACHE_LIMIT]
        for key, _ in oldest:
            _element_cache.pop(key, None)


def _cache_element(hwnd, control, info):
    _sweep_cache()
    element_id = f"uia:{int(hwnd)}:{uuid.uuid4().hex}"
    _element_cache[element_id] = {
        "createdAt": time.monotonic(),
        "hwnd": int(hwnd),
        "control": control,
        "fingerprint": _fingerprint(hwnd, info),
        "selector": {
            "name": info.get("name"),
            "automationId": info.get("automationId"),
            "controlType": info.get("controlType"),
        },
    }
    return element_id


def _supported_patterns(control):
    probes = {
        "invoke": "GetInvokePattern",
        "toggle": "GetTogglePattern",
        "selectionItem": "GetSelectionItemPattern",
        "expandCollapse": "GetExpandCollapsePattern",
        "value": "GetValuePattern",
        "rangeValue": "GetRangeValuePattern",
        "scroll": "GetScrollPattern",
        "legacyAccessible": "GetLegacyIAccessiblePattern",
    }
    supported = []
    for name, method_name in probes.items():
        method = getattr(control, method_name, None)
        if not callable(method):
            continue
        pattern = _safe(method, None)
        if pattern:
            supported.append(name)
    return supported


def element_info(hwnd, control, depth=0, parent_id=None):
    rect = _safe(lambda: control.BoundingRectangle, None)
    if rect is None:
        return None

    width = int(_safe(lambda: rect.width(), 0) or 0)
    height = int(_safe(lambda: rect.height(), 0) or 0)
    if width <= 0 or height <= 0:
        return None

    left = int(_safe(lambda: rect.left, 0) or 0)
    top = int(_safe(lambda: rect.top, 0) or 0)
    control_type_name = str(_safe(lambda: control.ControlTypeName, "") or "")
    info = {
        "name": str(_safe(lambda: control.Name, "") or ""),
        "automationId": str(_safe(lambda: control.AutomationId, "") or ""),
        "className": str(_safe(lambda: control.ClassName, "") or ""),
        "frameworkId": str(_safe(lambda: control.FrameworkId, "") or ""),
        "controlType": control_type_name.replace("Control", ""),
        "controlTypeName": control_type_name,
        "processId": _safe(lambda: int(control.ProcessId), None),
        "nativeWindowHandle": _safe(lambda: int(control.NativeWindowHandle), 0) or 0,
        "runtimeId": _runtime_id(control),
        "boundingRect": {
            "x": left,
            "y": top,
            "width": width,
            "height": height,
            "space": "screenPhysical",
        },
        "clickablePoint": {
            "x": left + width // 2,
            "y": top + height // 2,
            "space": "screenPhysical",
        },
        "isEnabled": bool(_safe(lambda: control.IsEnabled, False)),
        "isOffscreen": bool(_safe(lambda: control.IsOffscreen, False)),
        "isKeyboardFocusable": bool(_safe(lambda: control.IsKeyboardFocusable, False)),
        "hasKeyboardFocus": bool(_safe(lambda: control.HasKeyboardFocus, False)),
        "helpText": str(_safe(lambda: control.HelpText, "") or ""),
        "accessKey": str(_safe(lambda: control.AccessKey, "") or ""),
        "acceleratorKey": str(_safe(lambda: control.AcceleratorKey, "") or ""),
        "depth": int(depth),
        "parentElementId": parent_id,
    }
    info["supportedPatterns"] = _supported_patterns(control)

    value_pattern = _safe(lambda: control.GetValuePattern(), None)
    if value_pattern:
        value = _safe(lambda: value_pattern.Value, "")
        info["value"] = str(value or "")[:1000]

    info["elementId"] = _cache_element(hwnd, control, info)
    info["fingerprint"] = _fingerprint(hwnd, info)
    return info


def inspect(hwnd, *, max_depth=5, max_items=50, control_type=None,
            include_noninteractive=False, time_budget_ms=3000):
    """遍历窗口 UIA 树并返回结构化元素及截断诊断。"""
    import uiautomation as auto

    root = auto.ControlFromHandle(int(hwnd))
    if root is None:
        raise ScreenPilotError(
            "UIA_WINDOW_UNAVAILABLE",
            f"无法从 HWND:{hwnd} 获取 UI Automation 根元素。",
            retryable=True,
        )

    target_type = _normalize_type(control_type)
    max_depth = max(0, min(int(max_depth), 50))
    max_items = max(1, min(int(max_items), 5000))
    time_budget_ms = max(100, min(int(time_budget_ms), 30000))
    started = time.monotonic()
    elements = []
    visited = 0
    truncated_reason = None
    seen_runtime_ids = set()

    def walk(control, depth, parent_id=None):
        nonlocal visited, truncated_reason
        if truncated_reason or depth > max_depth:
            return
        if (time.monotonic() - started) * 1000 >= time_budget_ms:
            truncated_reason = "timeout"
            return
        if len(elements) >= max_items:
            truncated_reason = "maxItems"
            return

        visited += 1
        runtime_id = _runtime_id(control)
        runtime_key = tuple(runtime_id) if runtime_id else None
        if runtime_key and runtime_key in seen_runtime_ids:
            return
        if runtime_key:
            seen_runtime_ids.add(runtime_key)

        type_name = str(_safe(lambda: control.ControlTypeName, "") or "")
        is_interactive = type_name in _INTERACTIVE_TYPES
        current_parent_id = parent_id

        if (is_interactive or include_noninteractive) and (
            not target_type or type_name.lower() == target_type.lower()
        ):
            info = element_info(hwnd, control, depth, parent_id)
            if info:
                elements.append(info)
                current_parent_id = info["elementId"]

        if depth >= max_depth:
            return

        children = _safe(lambda: control.GetChildren(), []) or []
        for child in children:
            walk(child, depth + 1, current_parent_id)
            if truncated_reason:
                break

    walk(root, 0)
    elapsed_ms = round((time.monotonic() - started) * 1000, 2)
    return {
        "windowTitle": str(_safe(lambda: root.Name, "") or f"HWND:{hwnd}"),
        "elementCount": len(elements),
        "elements": elements,
        "visitedNodes": visited,
        "elapsedMs": elapsed_ms,
        "truncated": truncated_reason is not None,
        "truncatedReason": truncated_reason,
        "maxDepth": max_depth,
        "maxItems": max_items,
    }


def _matches(info, selector):
    if selector.get("name") is not None:
        expected = str(selector["name"]).casefold()
        actual = str(info.get("name") or "").casefold()
        mode = str(selector.get("matchMode") or "exact").lower()
        if mode == "contains":
            if expected not in actual:
                return False
        elif actual != expected:
            return False

    if selector.get("automationId") is not None:
        if str(info.get("automationId") or "") != str(selector["automationId"]):
            return False

    expected_type = _normalize_type(selector.get("controlType"))
    if expected_type and str(info.get("controlTypeName") or "").lower() != expected_type.lower():
        return False

    return True


def resolve_element(hwnd, selector, *, max_depth=12, time_budget_ms=5000):
    """按 elementId 或稳定选择器解析 UIA 控件。"""
    selector = dict(selector or {})
    element_id = selector.get("elementId")

    if element_id:
        _sweep_cache()
        cached = _element_cache.get(str(element_id))
        if cached and cached["hwnd"] == int(hwnd):
            control = cached["control"]
            info = element_info(hwnd, control)
            if info and info["fingerprint"] == cached["fingerprint"]:
                return control, info
            _element_cache.pop(str(element_id), None)

    result = inspect(
        hwnd,
        max_depth=max_depth,
        max_items=5000,
        include_noninteractive=True,
        time_budget_ms=time_budget_ms,
    )
    matches = [item for item in result["elements"] if _matches(item, selector)]
    if not matches:
        raise ScreenPilotError(
            "ELEMENT_NOT_FOUND",
            "未找到符合 UI Automation 选择器的元素。",
            retryable=True,
            details={"selector": selector, "visitedNodes": result["visitedNodes"]},
        )

    index = max(1, int(selector.get("index") or 1))
    if index > len(matches):
        raise ScreenPilotError(
            "ELEMENT_INDEX_OUT_OF_RANGE",
            f"找到 {len(matches)} 个元素，但请求第 {index} 个。",
            details={"selector": selector, "matchCount": len(matches)},
        )

    selected = matches[index - 1]
    cached = _element_cache.get(selected["elementId"])
    if not cached:
        raise ScreenPilotError("ELEMENT_STALE", "UIA 元素引用已经失效。", retryable=True)
    return cached["control"], selected


def perform_action(hwnd, selector, action, value=None):
    """优先使用 UIA Pattern 执行语义动作。"""
    control, info = resolve_element(hwnd, selector)
    normalized = str(action or "invoke").strip().lower()

    if not info.get("isEnabled", True):
        raise ScreenPilotError(
            "ELEMENT_DISABLED",
            f"元素“{info.get('name') or info.get('automationId')}”当前已禁用。",
            retryable=True,
        )

    if normalized in ("invoke", "click"):
        pattern = _safe(lambda: control.GetInvokePattern(), None)
        if pattern:
            pattern.Invoke()
            used = "InvokePattern"
        else:
            legacy = _safe(lambda: control.GetLegacyIAccessiblePattern(), None)
            if legacy:
                legacy.DoDefaultAction()
                used = "LegacyIAccessiblePattern"
            else:
                raise ScreenPilotError(
                    "ACTION_UNSUPPORTED",
                    "目标元素不支持 Invoke 或 LegacyIAccessible 默认动作。",
                    details={"supportedPatterns": info.get("supportedPatterns", [])},
                )
    elif normalized in ("setvalue", "set", "type"):
        pattern = _safe(lambda: control.GetValuePattern(), None)
        if not pattern:
            raise ScreenPilotError("ACTION_UNSUPPORTED", "目标元素不支持 ValuePattern。")
        pattern.SetValue(str(value if value is not None else ""))
        used = "ValuePattern"
    elif normalized == "toggle":
        pattern = _safe(lambda: control.GetTogglePattern(), None)
        if not pattern:
            raise ScreenPilotError("ACTION_UNSUPPORTED", "目标元素不支持 TogglePattern。")
        pattern.Toggle()
        used = "TogglePattern"
    elif normalized in ("select", "selection"):
        pattern = _safe(lambda: control.GetSelectionItemPattern(), None)
        if not pattern:
            raise ScreenPilotError("ACTION_UNSUPPORTED", "目标元素不支持 SelectionItemPattern。")
        pattern.Select()
        used = "SelectionItemPattern"
    elif normalized in ("expand", "collapse"):
        pattern = _safe(lambda: control.GetExpandCollapsePattern(), None)
        if not pattern:
            raise ScreenPilotError("ACTION_UNSUPPORTED", "目标元素不支持 ExpandCollapsePattern。")
        if normalized == "expand":
            pattern.Expand()
        else:
            pattern.Collapse()
        used = "ExpandCollapsePattern"
    elif normalized == "focus":
        control.SetFocus()
        used = "SetFocus"
    else:
        raise ScreenPilotError("INVALID_ACTION", f"不支持的 UIA 动作：{action}")

    return {
        "action": normalized,
        "actionBackend": "uia",
        "pattern": used,
        "element": info,
    }


def clear_element_cache():
    _element_cache.clear()