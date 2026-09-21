# -*- coding: utf-8 -*-
"""Windows 顶层窗口枚举、筛选与统一目标解析。"""

import os

from .errors import ScreenPilotError
from .geometry import Rect


def process_name_by_hwnd(hwnd):
    """根据 HWND 获取所属进程名。"""
    try:
        import win32api
        import win32process

        _, pid = win32process.GetWindowThreadProcessId(int(hwnd))
        try:
            import psutil
            return psutil.Process(pid).name()
        except Exception:
            pass

        handle = win32api.OpenProcess(0x0400 | 0x0010, False, pid)
        try:
            executable = win32process.GetModuleFileNameEx(handle, 0)
            return os.path.basename(executable)
        finally:
            win32api.CloseHandle(handle)
    except Exception:
        return None


def window_info(hwnd):
    """读取单个窗口的稳定元数据。"""
    import win32gui
    import win32process

    hwnd = int(hwnd)
    if not win32gui.IsWindow(hwnd):
        raise ScreenPilotError(
            "INVALID_HWND",
            f"HWND:{hwnd} 不是有效窗口。",
            retryable=True,
        )

    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    _, pid = win32process.GetWindowThreadProcessId(hwnd)
    return {
        "hwnd": hwnd,
        "title": win32gui.GetWindowText(hwnd) or f"HWND:{hwnd}",
        "processId": int(pid),
        "processName": process_name_by_hwnd(hwnd),
        "className": win32gui.GetClassName(hwnd) or "",
        "visible": bool(win32gui.IsWindowVisible(hwnd)),
        "minimized": bool(win32gui.IsIconic(hwnd)),
        "windowRect": Rect.from_ltrb(left, top, right, bottom).to_dict(),
    }


def enumerate_windows(*, title=None, process_name=None, pid=None,
                      class_name=None, visible_only=True, min_size=1):
    """枚举并筛选顶层窗口，返回按匹配质量和面积排序的候选。"""
    import win32gui
    import win32process

    title_query = str(title or "").casefold()
    process_query = str(process_name or "").casefold()
    class_query = str(class_name or "").casefold()
    target_pid = int(pid) if pid not in (None, "") else None
    candidates = []

    process_pids = set()
    exact_process_pids = set()
    if process_query:
        try:
            import psutil
            for process in psutil.process_iter(["pid", "name"]):
                try:
                    name = str(process.info.get("name") or "")
                    folded = name.casefold()
                    if process_query in folded:
                        process_pids.add(int(process.info["pid"]))
                        if folded == process_query:
                            exact_process_pids.add(int(process.info["pid"]))
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
        except ImportError:
            pass

    def callback(hwnd, _):
        try:
            if visible_only and not win32gui.IsWindowVisible(hwnd):
                return
            actual_title = win32gui.GetWindowText(hwnd) or ""
            actual_class = win32gui.GetClassName(hwnd) or ""
            _, actual_pid = win32process.GetWindowThreadProcessId(hwnd)

            if target_pid is not None and int(actual_pid) != target_pid:
                return
            if title_query and title_query not in actual_title.casefold():
                return
            if class_query and class_query not in actual_class.casefold():
                return
            if process_query:
                if process_pids:
                    if int(actual_pid) not in process_pids:
                        return
                else:
                    actual_process = process_name_by_hwnd(hwnd)
                    if not actual_process or process_query not in actual_process.casefold():
                        return

            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            rect = Rect.from_ltrb(left, top, right, bottom)
            if rect.width < min_size or rect.height < min_size:
                return

            score = 0
            reasons = []
            if title_query:
                if actual_title.casefold() == title_query:
                    score += 100
                    reasons.append("exactTitle")
                else:
                    score += 60
                    reasons.append("containsTitle")
            if process_query:
                if int(actual_pid) in exact_process_pids:
                    score += 100
                    reasons.append("exactProcessName")
                else:
                    score += 60
                    reasons.append("containsProcessName")
            if target_pid is not None:
                score += 100
                reasons.append("exactPid")
            if class_query:
                if actual_class.casefold() == class_query:
                    score += 80
                    reasons.append("exactClassName")
                else:
                    score += 40
                    reasons.append("containsClassName")

            candidates.append({
                "hwnd": int(hwnd),
                "title": actual_title or f"HWND:{hwnd}",
                "processId": int(actual_pid),
                "processName": process_name_by_hwnd(hwnd),
                "className": actual_class,
                "visible": bool(win32gui.IsWindowVisible(hwnd)),
                "minimized": bool(win32gui.IsIconic(hwnd)),
                "windowRect": rect.to_dict(),
                "area": rect.width * rect.height,
                "score": score,
                "matchReasons": reasons,
            })
        except Exception:
            return

    win32gui.EnumWindows(callback, None)
    candidates.sort(
        key=lambda item: (item["score"], item["area"]),
        reverse=True,
    )
    return candidates


def resolve_window(args, *, required=False):
    """
    按 hwnd → title → processName → pid/className 解析窗口。

    返回 (selected, candidates)；未提供条件且 required=False 时返回
    (None, [])。
    """
    normalized = {str(key).lower(): value for key, value in dict(args or {}).items()}
    hwnd = normalized.get("hwnd")
    if hwnd not in (None, ""):
        selected = window_info(int(hwnd))
        selected["selectionReason"] = "explicitHwnd"
        return selected, [selected]

    title = (
        normalized.get("windowtitle")
        or normalized.get("window_title")
        or normalized.get("title")
    )
    process_name = (
        normalized.get("processname")
        or normalized.get("process_name")
        or normalized.get("process")
    )
    pid = normalized.get("pid") or normalized.get("processid")
    class_name = normalized.get("classname") or normalized.get("class_name")

    if not any(value not in (None, "") for value in (title, process_name, pid, class_name)):
        if required:
            raise ScreenPilotError(
                "WINDOW_SELECTOR_REQUIRED",
                "必须提供 hwnd、windowTitle、processName、pid 或 className。",
            )
        return None, []

    candidates = enumerate_windows(
        title=title,
        process_name=process_name,
        pid=pid,
        class_name=class_name,
        min_size=1,
    )
    if not candidates:
        raise ScreenPilotError(
            "WINDOW_NOT_FOUND",
            "未找到符合条件的窗口。",
            retryable=True,
            details={
                "windowTitle": title,
                "processName": process_name,
                "pid": pid,
                "className": class_name,
            },
        )

    selected = dict(candidates[0])
    selected["selectionReason"] = "+".join(
        selected.get("matchReasons") or ["largestArea"]
    )
    return selected, candidates