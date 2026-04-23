# -*- coding: utf-8 -*-
"""
ScreenPilot - VCP 屏幕视觉与操控插件
功能：截图(ScreenCapture)、点击模拟(ClickAt)、UI元素探测(InspectUI)
      支持 DirectX/OpenGL/Vulkan 游戏窗口智能截图（自动学习 DXGI fallback）
"""

import sys
import json
import os
import io
import base64
import time
import re
import traceback
from datetime import datetime

# ============================================================
# Windows DPI 感知声明（必须在任何 Win32 API 调用前执行）
# 不声明的话，GetWindowRect 等 API 在高 DPI 系统上返回缩放后的
# 逻辑坐标，导致截图尺寸不对、点击坐标偏移。
# ============================================================
import ctypes
try:
    # PROCESS_PER_MONITOR_DPI_AWARE = 2
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        # 降级到 SetProcessDPIAware（Vista+）
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


# ============================================================
# 工具函数
# ============================================================

def debug_log(msg):
    """调试日志写入 stderr（不会被主服务读取为 stdout 结果）"""
    sys.stderr.write(f"[ScreenPilot DEBUG] {msg}\n")
    sys.stderr.flush()


def output_result(status, result=None, error=None):
    """将结果以 JSON 打印到 stdout，遵循 VCP 同步插件规范"""
    payload = {"status": status}
    if result is not None:
        payload["result"] = result
    if error is not None:
        payload["error"] = error
    # 使用 UTF-8 直接写入 stdout 字节流，避免编码问题
    json_str = json.dumps(payload, ensure_ascii=False)
    stdout_bytes = json_str.encode("utf-8")
    sys.stdout.buffer.write(stdout_bytes)
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def get_screenshot_dir():
    """获取截图存储目录"""
    env_dir = os.environ.get("SCREENSHOT_DIR", "").strip()
    if env_dir:
        d = env_dir
    else:
        d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots")
    os.makedirs(d, exist_ok=True)
    return d


def normalize_args(args):
    """处理参数同义词和大小写兼容"""
    lower = {k.lower(): v for k, v in args.items()}
    return lower


# ============================================================
# 截图策略学习记忆（capture_strategy.json 持久化）
# ============================================================
# 记住哪些进程需要 DXGI 截图（因为 GDI 截到黑屏），
# 下次直接走 DXGI，省掉一次黑屏检测的开销。
# 格式: { "进程名.exe": { "method": "dxgi", "learned_at": "...", "reason": "..." } }

_STRATEGY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "capture_strategy.json")
_capture_strategy_cache = None  # 内存缓存，避免每次读磁盘


def _load_capture_strategy():
    """加载截图策略缓存"""
    global _capture_strategy_cache
    if _capture_strategy_cache is not None:
        return _capture_strategy_cache
    try:
        if os.path.exists(_STRATEGY_FILE):
            with open(_STRATEGY_FILE, "r", encoding="utf-8") as f:
                _capture_strategy_cache = json.load(f)
                debug_log(f"截图策略已加载: {len(_capture_strategy_cache)} 条记录")
        else:
            _capture_strategy_cache = {}
    except Exception as e:
        debug_log(f"加载截图策略失败: {e}")
        _capture_strategy_cache = {}
    return _capture_strategy_cache


def _save_capture_strategy():
    """持久化截图策略到 JSON 文件"""
    global _capture_strategy_cache
    if _capture_strategy_cache is None:
        return
    try:
        with open(_STRATEGY_FILE, "w", encoding="utf-8") as f:
            json.dump(_capture_strategy_cache, f, ensure_ascii=False, indent=2)
        debug_log(f"截图策略已保存: {_STRATEGY_FILE}")
    except Exception as e:
        debug_log(f"保存截图策略失败: {e}")


def _get_strategy_for_process(process_name):
    """查询某个进程的截图策略，返回 'gdi' / 'dxgi' / None"""
    if not process_name:
        return None
    strategies = _load_capture_strategy()
    entry = strategies.get(process_name.lower())
    if entry:
        return entry.get("method", None)
    return None


def _learn_strategy(process_name, method, reason="auto-detected"):
    """学习并持久化某个进程的截图策略"""
    if not process_name:
        return
    strategies = _load_capture_strategy()
    key = process_name.lower()
    strategies[key] = {
        "method": method,
        "learned_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "reason": reason,
    }
    _capture_strategy_cache.update(strategies)
    _save_capture_strategy()
    debug_log(f"已学习截图策略: {process_name} → {method} (原因: {reason})")


# ============================================================
# 黑屏检测 & DXGI Fallback
# ============================================================

def is_black_image(img, threshold=5):
    """
    检测截图是否为纯黑/近黑（DirectX 截图失败的典型特征）。
    threshold: 平均像素亮度低于此值视为黑屏，默认 5。
    """
    import numpy as np
    arr = np.array(img.convert("RGB"), dtype=np.uint8)
    mean_val = arr.mean()
    debug_log(f"黑屏检测: 平均亮度={mean_val:.1f}, 阈值={threshold}")
    return mean_val < threshold


def capture_dxgi_region(hwnd):
    """
    通过 DXGI（全屏截图+裁剪）截取指定窗口区域。
    pyautogui.screenshot() 底层使用 DXGI Desktop Duplication，
    能正确捕获 DirectX/OpenGL/Vulkan 渲染的内容。
    需要窗口处于前台可见状态。
    """
    import pyautogui
    import win32gui
    import win32con

    # 确保窗口可见且在前台
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            time.sleep(0.3)
        win32gui.SetForegroundWindow(hwnd)
        time.sleep(0.3)  # 等待窗口完全显示
    except Exception as e:
        debug_log(f"DXGI: 置前窗口失败: {e}")

    # 获取窗口在屏幕上的位置
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    w = right - left
    h = bottom - top

    if w <= 0 or h <= 0:
        raise ValueError(f"窗口尺寸无效: {w}x{h}")

    # 全屏截图
    full_img = pyautogui.screenshot()
    screen_w, screen_h = full_img.size

    # 裁剪到窗口区域（确保不越界）
    crop_left = max(0, left)
    crop_top = max(0, top)
    crop_right = min(screen_w, right)
    crop_bottom = min(screen_h, bottom)

    if crop_right <= crop_left or crop_bottom <= crop_top:
        debug_log(f"DXGI: 裁剪区域无效 ({crop_left},{crop_top},{crop_right},{crop_bottom})，返回全屏")
        return full_img

    img = full_img.crop((crop_left, crop_top, crop_right, crop_bottom))
    debug_log(f"DXGI: 截图成功 {img.size}, 窗口区域 ({crop_left},{crop_top})→({crop_right},{crop_bottom})")
    return img


# ============================================================
# 进程名查找窗口
# ============================================================

def _get_process_name_by_hwnd(hwnd):
    """根据 HWND 获取进程名（如 'YuanShen.exe'）"""
    try:
        import win32process
        import win32api
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        # 尝试用 psutil（更可靠）
        try:
            import psutil
            proc = psutil.Process(pid)
            return proc.name()
        except ImportError:
            pass
        # 降级到 Win32 API
        try:
            handle = win32api.OpenProcess(0x0400 | 0x0010, False, pid)  # PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
            exe_path = win32process.GetModuleFileNameEx(handle, 0)
            win32api.CloseHandle(handle)
            return os.path.basename(exe_path)
        except Exception:
            pass
    except Exception as e:
        debug_log(f"获取进程名失败 (HWND:{hwnd}): {e}")
    return None


def find_window_by_process(process_name):
    """
    根据进程名查找窗口（适用于启动器+游戏分离架构）。
    返回 (hwnd, full_title, process_name) 或 (None, None, None)。
    优先返回面积最大的可见窗口（通常是游戏主窗口而非启动器小窗口）。
    """
    import win32gui
    import win32process

    target_pids = set()
    actual_process_name = process_name

    # 方法1: 优先用 psutil（更准确，支持模糊匹配）
    try:
        import psutil
        for proc in psutil.process_iter(['name', 'pid']):
            try:
                pname = proc.info['name']
                if pname and process_name.lower() in pname.lower():
                    target_pids.add(proc.info['pid'])
                    actual_process_name = pname  # 记录真实进程名
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except ImportError:
        debug_log("psutil 未安装，使用 Win32 API 枚举进程（精度较低）")
        # 方法2: 降级到 EnumWindows + GetWindowThreadProcessId
        # 这种方式无法直接按进程名搜索，只能遍历所有窗口后检查

    results = []

    def enum_callback(hwnd, _):
        if not win32gui.IsWindowVisible(hwnd):
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
        except Exception:
            return

        if target_pids and pid not in target_pids:
            return

        # 如果没用 psutil，尝试通过 pid 反查进程名
        if not target_pids:
            pname = _get_process_name_by_hwnd(hwnd)
            if not pname or process_name.lower() not in pname.lower():
                return

        title = win32gui.GetWindowText(hwnd) or ""
        try:
            left, top, right, bottom = win32gui.GetWindowRect(hwnd)
            w = right - left
            h = bottom - top
            if w > 50 and h > 50:  # 过滤掉太小的窗口
                results.append((hwnd, title, w * h, actual_process_name))
        except Exception:
            pass

    win32gui.EnumWindows(enum_callback, None)

    if not results:
        return None, None, None

    # 按面积降序，返回最大的窗口
    results.sort(key=lambda x: x[2], reverse=True)
    hwnd, title, _, pname = results[0]
    return hwnd, title or f"HWND:{hwnd}", pname


# ============================================================
# OCR 引擎（延迟加载单例）
# ============================================================

_ocr_engine = None

def get_ocr_engine():
    """延迟加载 RapidOCR 引擎（单例），避免重复初始化"""
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
        debug_log("RapidOCR 引擎已初始化")
    return _ocr_engine


def run_ocr(img, window_rect=None):
    """
    对 PIL Image 运行 OCR，返回检测到的文本块列表。
    每个文本块包含: text, boundingBox, clickablePoint
    如果提供了 window_rect，clickablePoint 会使用屏幕绝对坐标。
    """
    import numpy as np
    from PIL import ImageFilter, ImageEnhance
    engine = get_ocr_engine()

    # 屏幕截图预处理：放大 + 锐化，显著提升小字和中文的识别率
    img_rgb = img.convert("RGB")
    orig_w, orig_h = img_rgb.size
    scale = 1.0

    # 如果图像较小（常见于窗口截图），放大 2 倍
    if orig_w < 2560 or orig_h < 1440:
        scale = 2.0
        img_rgb = img_rgb.resize((int(orig_w * scale), int(orig_h * scale)), resample=3)  # BICUBIC

    # 锐化 + 轻微对比度增强，对抗屏幕抗锯齿
    img_rgb = img_rgb.filter(ImageFilter.SHARPEN)
    img_rgb = ImageEnhance.Contrast(img_rgb).enhance(1.3)

    img_array = np.array(img_rgb)

    result, _ = engine(img_array)
    if not result:
        return []

    text_blocks = []
    for item in result:
        # item: [bbox_points, text, confidence]
        # bbox_points: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] 四个角点
        bbox_points = item[0]
        text = item[1]
        confidence = item[2]

        # 计算轴对齐边界框（OCR 坐标基于放大后的图像，需缩回原图）
        xs = [p[0] / scale for p in bbox_points]
        ys = [p[1] / scale for p in bbox_points]
        x_min, x_max = int(min(xs)), int(max(xs))
        y_min, y_max = int(min(ys)), int(max(ys))

        # 原图内坐标的中心点
        center_x = (x_min + x_max) // 2
        center_y = (y_min + y_max) // 2

        block = {
            "text": text,
            "confidence": round(float(confidence), 3),
            "boundingBox": {
                "x": x_min, "y": y_min,
                "width": x_max - x_min, "height": y_max - y_min
            },
            # 图像内的像素坐标（原图尺寸）
            "imagePoint": {"x": center_x, "y": center_y},
        }

        # 计算屏幕绝对坐标的点击位置
        if window_rect:
            block["clickablePoint"] = {
                "x": window_rect["x"] + center_x,
                "y": window_rect["y"] + center_y
            }
        else:
            # 全屏截图时，图像坐标 = 屏幕坐标
            block["clickablePoint"] = {"x": center_x, "y": center_y}

        text_blocks.append(block)

    return text_blocks


# ============================================================
# ScreenCapture — GDI 截图（原始方法，适用于标准窗口）
# ============================================================

def find_window_by_title(title_keyword):
    """根据标题关键字模糊匹配窗口，返回 (hwnd, full_title)"""
    import win32gui

    results = []

    def enum_callback(hwnd, _):
        if win32gui.IsWindowVisible(hwnd):
            t = win32gui.GetWindowText(hwnd)
            if t and title_keyword.lower() in t.lower():
                results.append((hwnd, t))

    win32gui.EnumWindows(enum_callback, None)
    if not results:
        return None, None
    # 优先返回标题最短的（最匹配的）
    results.sort(key=lambda x: len(x[1]))
    return results[0]


def _capture_window_gdi(hwnd):
    """通过 Win32 GDI API 截取指定窗口的图像，返回 PIL Image（原始方法）"""
    import win32gui
    import win32ui
    import win32con
    from PIL import Image

    # 获取窗口尺寸
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    width = right - left
    height = bottom - top

    if width <= 0 or height <= 0:
        raise ValueError(f"窗口尺寸无效: {width}x{height}")

    # 创建设备上下文
    hwnd_dc = win32gui.GetWindowDC(hwnd)
    mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
    save_dc = mfc_dc.CreateCompatibleDC()

    # 创建位图
    bitmap = win32ui.CreateBitmap()
    bitmap.CreateCompatibleBitmap(mfc_dc, width, height)
    save_dc.SelectObject(bitmap)

    # 使用 PrintWindow 捕获（支持部分遮挡的窗口）
    # PW_RENDERFULLCONTENT = 2, 能截取 DWM 合成的内容
    try:
        result = win32gui.SendMessage(hwnd, win32con.WM_PRINT, save_dc.GetSafeHdc(),
                                       win32con.PRF_CHILDREN | win32con.PRF_CLIENT | win32con.PRF_NONCLIENT)
    except Exception:
        pass

    # 回退到 PrintWindow
    import ctypes
    ctypes.windll.user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), 2)

    # 转换为 PIL Image
    bmp_info = bitmap.GetInfo()
    bmp_bits = bitmap.GetBitmapBits(True)

    img = Image.frombuffer("RGB", (bmp_info["bmWidth"], bmp_info["bmHeight"]),
                           bmp_bits, "raw", "BGRX", 0, 1)

    # 清理资源
    win32gui.DeleteObject(bitmap.GetHandle())
    save_dc.DeleteDC()
    mfc_dc.DeleteDC()
    win32gui.ReleaseDC(hwnd, hwnd_dc)

    return img


# ============================================================
# 智能截图（自动选择 GDI / DXGI，带学习记忆）
# ============================================================

# 记录最近一次截图使用的方法（供上层 cmd 读取报告）
_last_capture_info = {
    "method": None,       # "gdi" / "dxgi" / "fullscreen"
    "process_name": None,
    "learned": False,     # 是否使用了学习到的策略
    "fallback": False,    # 是否触发了 fallback
}


def capture_window_smart(hwnd):
    """
    智能截图：根据学习记忆选择最优截图方式。
    流程：
    1. 查询进程名 → 检查 capture_strategy.json 是否有记录
    2. 如已知该进程需要 DXGI → 直接走 DXGI（跳过 GDI，节省时间）
    3. 如未知 → 先尝试 GDI，检测黑屏 → 黑屏则 fallback 到 DXGI 并学习记忆
    4. 返回 PIL Image
    """
    global _last_capture_info
    _last_capture_info = {
        "method": None, "process_name": None,
        "learned": False, "fallback": False,
    }

    # 获取进程名
    process_name = _get_process_name_by_hwnd(hwnd)
    _last_capture_info["process_name"] = process_name
    debug_log(f"智能截图: HWND={hwnd}, 进程={process_name}")

    # 查询已学习的策略
    known_strategy = _get_strategy_for_process(process_name)

    if known_strategy == "dxgi":
        # 已知该进程需要 DXGI，直接跳过 GDI
        debug_log(f"智能截图: 已学习 {process_name} 需要 DXGI，直接使用")
        _last_capture_info["method"] = "dxgi"
        _last_capture_info["learned"] = True
        try:
            return capture_dxgi_region(hwnd)
        except Exception as e:
            debug_log(f"DXGI 截图失败: {e}，降级到 GDI")
            _last_capture_info["method"] = "gdi"
            _last_capture_info["fallback"] = True
            return _capture_window_gdi(hwnd)

    # 未知策略：先尝试 GDI
    debug_log(f"智能截图: 尝试 GDI 截图...")
    try:
        img = _capture_window_gdi(hwnd)
    except Exception as e:
        debug_log(f"GDI 截图异常: {e}，尝试 DXGI")
        _last_capture_info["method"] = "dxgi"
        _last_capture_info["fallback"] = True
        img = capture_dxgi_region(hwnd)
        _learn_strategy(process_name, "dxgi", reason="GDI 截图异常，自动切换")
        return img

    # 黑屏检测
    if is_black_image(img):
        debug_log(f"智能截图: GDI 截到黑屏！fallback 到 DXGI...")
        _last_capture_info["method"] = "dxgi"
        _last_capture_info["fallback"] = True
        try:
            img_dxgi = capture_dxgi_region(hwnd)
            # 检查 DXGI 结果是否也是黑屏
            if is_black_image(img_dxgi):
                debug_log(f"智能截图: DXGI 也是黑屏（窗口可能最小化或完全遮挡）")
                # 不学习，可能是临时状态
                return img_dxgi
            # DXGI 成功，学习记忆
            _learn_strategy(process_name, "dxgi", reason="GDI 截到黑屏，DXGI 成功")
            return img_dxgi
        except Exception as e:
            debug_log(f"DXGI fallback 也失败: {e}")
            return img  # 返回黑屏的 GDI 结果，总比崩溃好
    else:
        # GDI 成功（非黑屏）
        _last_capture_info["method"] = "gdi"
        # 如果之前没有记录，学习为 GDI（避免下次还要检测）
        if process_name and known_strategy is None:
            _learn_strategy(process_name, "gdi", reason="GDI 截图正常")
        return img


def capture_fullscreen():
    """全屏截图，返回 PIL Image"""
    import pyautogui
    global _last_capture_info
    _last_capture_info = {
        "method": "fullscreen", "process_name": None,
        "learned": False, "fallback": False,
    }
    return pyautogui.screenshot()


def image_to_base64(img, fmt="PNG"):
    """将 PIL Image 转为 base64 Data URI"""
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    b64 = base64.b64encode(buf.getvalue()).decode("utf-8")
    mime = "image/png" if fmt.upper() == "PNG" else "image/jpeg"
    return f"data:{mime};base64,{b64}"


# ============================================================
# ScreenCapture 指令
# ============================================================

def cmd_screen_capture(args):
    """执行 ScreenCapture 指令（支持 processName 按进程名查找游戏窗口）"""
    a = normalize_args(args)

    hwnd = a.get("hwnd")
    window_title = a.get("windowtitle") or a.get("window_title") or a.get("title")
    process_name_arg = a.get("processname") or a.get("process_name") or a.get("process")
    save = str(a.get("save", "false")).lower() in ("true", "1", "yes")
    do_ocr = str(a.get("ocr", "false")).lower() in ("true", "1", "yes")
    filename = a.get("filename")

    captured_title = None
    img = None
    window_rect = None  # 窗口在屏幕上的位置，用于坐标换算

    if hwnd:
        hwnd = int(hwnd)
        import win32gui
        captured_title = win32gui.GetWindowText(hwnd) or f"HWND:{hwnd}"
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top}
        img = capture_window_smart(hwnd)
    elif window_title:
        found_hwnd, found_title = find_window_by_title(window_title)
        if found_hwnd is None:
            return {"status": "error", "error": f"未找到标题包含 '{window_title}' 的窗口。请检查窗口是否已打开。"}
        captured_title = found_title
        import win32gui
        left, top, right, bottom = win32gui.GetWindowRect(found_hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top, "hwnd": found_hwnd}
        img = capture_window_smart(found_hwnd)
    elif process_name_arg:
        found_hwnd, found_title, found_pname = find_window_by_process(process_name_arg)
        if found_hwnd is None:
            return {"status": "error", "error": f"未找到进程名包含 '{process_name_arg}' 的窗口。请检查程序是否正在运行。"}
        captured_title = found_title
        import win32gui
        left, top, right, bottom = win32gui.GetWindowRect(found_hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top, "hwnd": found_hwnd}
        img = capture_window_smart(found_hwnd)
    else:
        img = capture_fullscreen()
        captured_title = "全屏截图"

    width, height = img.size
    data_uri = image_to_base64(img)

    text_parts = [
        f"截图成功: {captured_title}",
        f"分辨率: {width} × {height} 像素",
    ]

    # 报告截图方法
    ci = _last_capture_info
    if ci["method"] == "dxgi" and ci["learned"]:
        text_parts.append(f"📌 截图方式: DXGI（已记忆进程 {ci['process_name']} 需要此方式）")
    elif ci["method"] == "dxgi" and ci["fallback"]:
        text_parts.append(f"⚡ 截图方式: DXGI fallback（GDI 黑屏，已自动学习并记忆进程 {ci['process_name']}）")
    elif ci["method"] == "gdi":
        text_parts.append(f"截图方式: GDI (PrintWindow)")

    if window_rect:
        text_parts.append(
            f"窗口屏幕位置: 左上角({window_rect['x']}, {window_rect['y']})  "
            f"尺寸 {window_rect['width']}×{window_rect['height']}"
        )
        text_parts.append(
            "提示: 截图中的像素坐标 + 窗口左上角坐标 = 屏幕绝对坐标，"
            "或在 ClickAt 中使用 relativeToWindow=true + hwnd 直接传窗口相对坐标。"
        )

    # 持久化保存
    saved_path = None
    if save:
        screenshot_dir = get_screenshot_dir()
        if not filename:
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            safe_title = re.sub(r'[<>:"/\\|?*]', '_', (captured_title or "screenshot")[:30])
            filename = f"{safe_title}_{ts}.png"
        save_path = os.path.join(screenshot_dir, filename)
        img.save(save_path, "PNG")
        saved_path = save_path
        text_parts.append(f"已保存到: {save_path}")

    # OCR 文本检测
    ocr_blocks = None
    if do_ocr:
        try:
            ocr_blocks = run_ocr(img, window_rect)
            text_parts.append(f"\nOCR 检测到 {len(ocr_blocks)} 个文本区域:")
            for i, blk in enumerate(ocr_blocks, 1):
                cp = blk["clickablePoint"]
                text_parts.append(
                    f"  [{i}] \"{blk['text']}\" → 点击({cp['x']},{cp['y']}) "
                    f"置信度:{blk['confidence']}"
                )
        except Exception as e:
            debug_log(f"OCR 失败: {e}")
            text_parts.append(f"\nOCR 检测失败: {e}")

    result = {
        "content": [
            {"type": "text", "text": "\n".join(text_parts)},
            {"type": "image_url", "image_url": {"url": data_uri}}
        ],
        "resolution": {"width": width, "height": height},
    }
    if window_rect:
        result["windowRect"] = window_rect
    if saved_path:
        result["savedPath"] = saved_path
    if ocr_blocks is not None:
        result["ocrResults"] = ocr_blocks
    # 附加截图方法信息
    result["captureMethod"] = ci["method"]
    if ci["process_name"]:
        result["processName"] = ci["process_name"]

    return {"status": "success", "result": result}


# ============================================================
# ClickAt 指令（双轨制：前台 pyautogui / 后台 PostMessage）
# ============================================================

# Win32 鼠标消息常量
WM_LBUTTONDOWN   = 0x0201
WM_LBUTTONUP     = 0x0202
WM_LBUTTONDBLCLK = 0x0203
WM_RBUTTONDOWN   = 0x0204
WM_RBUTTONUP     = 0x0205
WM_RBUTTONDBLCLK = 0x0206
WM_MBUTTONDOWN   = 0x0207
WM_MBUTTONUP     = 0x0208
WM_MBUTTONDBLCLK = 0x0209
WM_MOUSEWHEEL    = 0x020A
WM_CHAR          = 0x0102
MK_LBUTTON       = 0x0001
MK_RBUTTON       = 0x0002
MK_MBUTTON       = 0x0010
WHEEL_DELTA      = 120

# 按钮 → (WM_DOWN, WM_UP, WM_DBLCLK, MK_FLAG) 映射
_BUTTON_MSG_MAP = {
    "left":   (WM_LBUTTONDOWN, WM_LBUTTONUP, WM_LBUTTONDBLCLK, MK_LBUTTON),
    "right":  (WM_RBUTTONDOWN, WM_RBUTTONUP, WM_RBUTTONDBLCLK, MK_RBUTTON),
    "middle": (WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MBUTTONDBLCLK, MK_MBUTTON),
}


def _resolve_hwnd(a):
    """
    窗口查找：优先 hwnd → windowTitle → processName。
    返回 (hwnd: int, title: str) 或 (None, None)。
    """
    hwnd = a.get("hwnd")
    if hwnd:
        hwnd = int(hwnd)
        try:
            import win32gui
            title = win32gui.GetWindowText(hwnd) or f"HWND:{hwnd}"
        except Exception:
            title = f"HWND:{hwnd}"
        return hwnd, title

    window_title = a.get("windowtitle") or a.get("window_title") or a.get("title")
    if window_title:
        found_hwnd, found_title = find_window_by_title(window_title)
        if found_hwnd:
            return found_hwnd, found_title
        return None, f"未找到标题包含 '{window_title}' 的窗口"

    # 新增: 支持按进程名查找
    process_name = a.get("processname") or a.get("process_name") or a.get("process")
    if process_name:
        found_hwnd, found_title, _ = find_window_by_process(process_name)
        if found_hwnd:
            return found_hwnd, found_title
        return None, f"未找到进程名包含 '{process_name}' 的窗口"

    return None, None


def _screen_to_client(hwnd, screen_x, screen_y):
    """
    将屏幕绝对坐标转换为窗口客户区坐标。
    PostMessage 的鼠标消息需要客户区坐标。
    """
    import win32gui
    client_x, client_y = win32gui.ScreenToClient(hwnd, (screen_x, screen_y))
    return client_x, client_y


def _post_click(hwnd, client_x, client_y, button="left", clicks=1):
    """
    通过 PostMessage 向目标窗口发送鼠标点击事件（不移动物理光标）。
    坐标为客户区坐标。
    """
    user32 = ctypes.windll.user32
    msg_down, msg_up, msg_dblclk, mk_flag = _BUTTON_MSG_MAP[button]

    # lParam: 低16位=x, 高16位=y（客户区坐标）
    lParam = ((client_y & 0xFFFF) << 16) | (client_x & 0xFFFF)

    for i in range(clicks):
        if clicks == 2 and i == 1:
            # 第二次点击发送双击消息
            user32.PostMessageW(hwnd, msg_dblclk, mk_flag, lParam)
            time.sleep(0.02)
            user32.PostMessageW(hwnd, msg_up, 0, lParam)
        else:
            user32.PostMessageW(hwnd, msg_down, mk_flag, lParam)
            time.sleep(0.02)
            user32.PostMessageW(hwnd, msg_up, 0, lParam)
        if i < clicks - 1:
            time.sleep(0.05)


def cmd_click_at(args):
    """
    执行 ClickAt 指令（双轨制）
    - 前台模式（默认）: pyautogui.click()，物理移动光标
    - 后台模式（background=true）: PostMessage，不移动光标
    """
    import pyautogui
    a = normalize_args(args)

    x = a.get("x")
    y = a.get("y")
    if x is None or y is None:
        return {"status": "error", "error": "必须提供 x 和 y 坐标参数。"}

    x = int(x)
    y = int(y)
    button = str(a.get("button", "left")).lower()
    clicks = int(a.get("clicks", 1))
    # 双轨开关
    background = str(a.get("background") or a.get("bg") or "false").lower() in ("true", "1", "yes")
    # relativeToWindow: 当为 true 时，(x,y) 被视为窗口内相对坐标
    relative_to_window = str(a.get("relativetowindow") or a.get("relative_to_window") or a.get("relative") or "false").lower() in ("true", "1", "yes")

    if button not in ("left", "right", "middle"):
        return {"status": "error", "error": f"无效的button参数: '{button}'，可选值: left, right, middle。"}

    # ── 双轨：后台模式（PostMessage，不劫持鼠标） ──
    if background:
        hwnd, title = _resolve_hwnd(a)
        if hwnd is None:
            return {"status": "error", "error": f"后台模式（background）必须提供 hwnd 或 windowTitle 来指定目标窗口。{title or ''}"}

        import win32gui

        if relative_to_window:
            win_left, win_top, _, _ = win32gui.GetWindowRect(hwnd)
            screen_x = win_left + x
            screen_y = win_top + y
            client_x, client_y = _screen_to_client(hwnd, screen_x, screen_y)
            coord_desc = f"窗口相对({x},{y}) → 客户区({client_x},{client_y})"
        else:
            client_x, client_y = _screen_to_client(hwnd, x, y)
            coord_desc = f"屏幕绝对({x},{y}) → 客户区({client_x},{client_y})"

        _post_click(hwnd, client_x, client_y, button=button, clicks=clicks)

        result_text = (
            f"[后台模式] 已向窗口 \"{title}\" (HWND:{hwnd}) 发送 {button} 键点击 {clicks} 次。\n"
            f"坐标: {coord_desc}\n"
            f"鼠标光标未移动。"
        )
        return {"status": "success", "result": result_text}

    # ── 双轨：前台模式（pyautogui，原有行为） ──
    coord_mode = "屏幕绝对"
    hwnd = a.get("hwnd")

    if hwnd:
        hwnd = int(hwnd)
        try:
            import win32gui
            import win32con
            if win32gui.IsIconic(hwnd):
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            win32gui.SetForegroundWindow(hwnd)
            time.sleep(0.3)

            if relative_to_window:
                win_left, win_top, _, _ = win32gui.GetWindowRect(hwnd)
                orig_x, orig_y = x, y
                x = win_left + x
                y = win_top + y
                coord_mode = f"窗口相对({orig_x},{orig_y}) → 屏幕绝对"
        except Exception as e:
            debug_log(f"SetForegroundWindow failed: {e}")
            if relative_to_window:
                return {"status": "error", "error": f"无法获取窗口位置进行坐标转换: {e}"}
    elif relative_to_window:
        return {"status": "error", "error": "使用 relativeToWindow 时必须同时提供 hwnd 参数。"}

    screen_w, screen_h = pyautogui.size()
    if x < 0 or x >= screen_w or y < 0 or y >= screen_h:
        return {
            "status": "error",
            "error": f"最终屏幕坐标 ({x}, {y}) 超出屏幕范围 ({screen_w}×{screen_h})。"
        }

    pyautogui.click(x, y, button=button, clicks=clicks)

    result_text = f"已在{coord_mode}坐标 ({x}, {y}) 执行 {button} 键点击 {clicks} 次。"
    if hwnd:
        result_text += f"\n(已先将窗口 HWND:{hwnd} 置于前台)"

    return {
        "status": "success",
        "result": result_text
    }


# ============================================================
# InspectUI 指令
# ============================================================

def cmd_inspect_ui(args):
    """执行 InspectUI 指令 — 通过 Windows UI Automation 获取窗口内可交互元素"""
    import uiautomation as auto
    a = normalize_args(args)

    hwnd = a.get("hwnd")
    window_title = a.get("windowtitle") or a.get("window_title") or a.get("title")
    control_type_filter = a.get("controltype") or a.get("control_type") or a.get("type")
    max_depth = int(a.get("maxdepth") or a.get("max_depth") or 5)
    max_items = int(a.get("maxitems") or a.get("max_items") or 50)

    # 找到目标窗口
    target_window = None
    actual_title = None

    if hwnd:
        hwnd = int(hwnd)
        target_window = auto.ControlFromHandle(hwnd)
        if target_window:
            actual_title = target_window.Name or f"HWND:{hwnd}"
    elif window_title:
        # 通过 win32gui 精确查找
        found_hwnd, found_title = find_window_by_title(window_title)
        if found_hwnd:
            target_window = auto.ControlFromHandle(found_hwnd)
            actual_title = found_title
    else:
        return {"status": "error", "error": "必须提供 windowTitle 或 hwnd 参数来指定要检查的窗口。"}

    if target_window is None:
        return {"status": "error", "error": f"未找到目标窗口。搜索条件: title='{window_title}', hwnd={hwnd}"}

    # 定义要收集的可交互控件类型
    interactive_types = {
        "ButtonControl", "EditControl", "MenuItemControl", "CheckBoxControl",
        "RadioButtonControl", "ComboBoxControl", "HyperlinkControl",
        "ListItemControl", "TreeItemControl", "TabItemControl",
        "SliderControl", "SpinnerControl", "ToolBarControl",
        "MenuBarControl", "DataItemControl", "ScrollBarControl"
    }

    # 控件类型名映射（用于筛选）
    type_name_map = {
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
    }

    # 解析用户的控件类型筛选
    filter_control_class = None
    if control_type_filter:
        cf = control_type_filter.lower().replace(" ", "")
        if cf in type_name_map:
            filter_control_class = type_name_map[cf]
        elif cf + "control" in {t.lower() for t in interactive_types}:
            # 直接匹配如 "ButtonControl"
            for t in interactive_types:
                if t.lower() == cf + "control" or t.lower() == cf:
                    filter_control_class = t
                    break
        else:
            filter_control_class = control_type_filter  # 原样传递，后续匹配

    # 递归遍历 UI 树
    elements = []

    def walk(control, depth):
        if depth > max_depth or len(elements) >= max_items:
            return

        control_type_name = control.ControlTypeName

        # 检查是否是可交互元素
        is_interactive = control_type_name in interactive_types

        if is_interactive:
            # 如果有筛选条件，检查是否匹配
            if filter_control_class:
                if control_type_name.lower() != filter_control_class.lower():
                    pass  # 不添加，但继续遍历子元素
                else:
                    add_element(control, control_type_name)
            else:
                add_element(control, control_type_name)

        # 遍历子元素
        if depth < max_depth and len(elements) < max_items:
            try:
                children = control.GetChildren()
                for child in children:
                    if len(elements) >= max_items:
                        break
                    walk(child, depth + 1)
            except Exception:
                pass

    def add_element(control, control_type_name):
        if len(elements) >= max_items:
            return
        try:
            rect = control.BoundingRectangle
            # 某些不可见元素的 rect 全为 0
            if rect.width() <= 0 and rect.height() <= 0:
                return

            name = control.Name or ""
            # 计算中心点作为可点击坐标
            center_x = rect.left + rect.width() // 2
            center_y = rect.top + rect.height() // 2

            elem_info = {
                "name": name,
                "controlType": control_type_name.replace("Control", ""),
                "boundingRect": {
                    "x": rect.left,
                    "y": rect.top,
                    "width": rect.width(),
                    "height": rect.height()
                },
                "clickablePoint": {"x": center_x, "y": center_y},
                "isEnabled": control.IsEnabled,
            }

            # 尝试获取值（对编辑框等有用）
            try:
                vp = control.GetValuePattern()
                if vp:
                    elem_info["value"] = vp.Value[:100] if vp.Value else ""
            except Exception:
                pass

            elements.append(elem_info)
        except Exception as e:
            debug_log(f"跳过元素: {e}")

    walk(target_window, 0)

    # 构建结果
    text_lines = [
        f"UI Automation 检查结果: {actual_title}",
        f"找到 {len(elements)} 个可交互元素" + (f" (类型筛选: {control_type_filter})" if control_type_filter else ""),
        f"遍历深度: {max_depth}",
        "",
    ]
    for i, elem in enumerate(elements, 1):
        cp = elem["clickablePoint"]
        br = elem["boundingRect"]
        text_lines.append(
            f"  [{i}] {elem['controlType']}: \"{elem['name']}\" "
            f"@ 点击坐标({cp['x']}, {cp['y']}) "
            f"区域({br['x']},{br['y']} {br['width']}×{br['height']})"
            + (f" 值=\"{elem.get('value', '')}\"" if elem.get("value") else "")
            + (" [已禁用]" if not elem.get("isEnabled", True) else "")
        )

    return {
        "status": "success",
        "result": {
            "content": [
                {"type": "text", "text": "\n".join(text_lines)}
            ],
            "windowTitle": actual_title,
            "elementCount": len(elements),
            "elements": elements,
        }
    }


# ============================================================
# ClickText 指令
# ============================================================

def _resolve_capture_target(a):
    """
    通用截图目标解析（供 ClickText / ClickVisual 共用）。
    按优先级: hwnd → windowTitle → processName → 全屏
    返回 (img, hwnd, window_rect, captured_title)
    """
    hwnd = a.get("hwnd")
    window_title = a.get("windowtitle") or a.get("window_title") or a.get("title")
    process_name = a.get("processname") or a.get("process_name") or a.get("process")

    if hwnd:
        hwnd = int(hwnd)
        import win32gui
        captured_title = win32gui.GetWindowText(hwnd) or f"HWND:{hwnd}"
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top}
        img = capture_window_smart(hwnd)
        return img, hwnd, window_rect, captured_title

    if window_title:
        found_hwnd, found_title = find_window_by_title(window_title)
        if found_hwnd is None:
            return None, None, None, f"未找到标题包含 '{window_title}' 的窗口。"
        import win32gui
        left, top, right, bottom = win32gui.GetWindowRect(found_hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top}
        img = capture_window_smart(found_hwnd)
        return img, found_hwnd, window_rect, found_title

    if process_name:
        found_hwnd, found_title, _ = find_window_by_process(process_name)
        if found_hwnd is None:
            return None, None, None, f"未找到进程名包含 '{process_name}' 的窗口。"
        import win32gui
        left, top, right, bottom = win32gui.GetWindowRect(found_hwnd)
        window_rect = {"x": left, "y": top, "width": right - left, "height": bottom - top}
        img = capture_window_smart(found_hwnd)
        return img, found_hwnd, window_rect, found_title

    # 全屏
    img = capture_fullscreen()
    return img, None, None, "全屏"


def cmd_click_text(args):
    """
    执行 ClickText 指令:
    截图 → OCR → 找到匹配文本 → 自动点击其中心坐标
    """
    import pyautogui
    a = normalize_args(args)

    target_text = a.get("text") or a.get("target") or a.get("label")
    if not target_text:
        return {"status": "error", "error": "必须提供 text 参数指定要点击的文本内容。"}

    button = str(a.get("button", "left")).lower()
    clicks = int(a.get("clicks", 1))
    match_mode = str(a.get("matchmode") or a.get("match_mode") or a.get("match") or "fuzzy").lower()
    index = int(a.get("index") or a.get("nth") or 1)  # 第几个匹配（从1开始）

    # 1. 截图（通用解析，支持 hwnd/windowTitle/processName/全屏）
    img, hwnd, window_rect, captured_title = _resolve_capture_target(a)
    if img is None:
        return {"status": "error", "error": captured_title}  # captured_title 此时是错误信息

    # 2. OCR
    try:
        ocr_blocks = run_ocr(img, window_rect)
    except Exception as e:
        return {"status": "error", "error": f"OCR 检测失败: {e}"}

    if not ocr_blocks:
        return {"status": "error", "error": "截图中未检测到任何文本。"}

    # 3. 查找匹配文本
    def strip_noise(s):
        """去除空格、标点和特殊符号，只留下字母数字和 CJK 文字"""
        return re.sub(r'[\s\u3000!-/:-@\[-`{-~\u2000-\u206f\u3000-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2010-\u2027\u2030-\u205e\u00a0-\u00bf]', '', s)

    matches = []
    target_lower = target_text.lower()
    target_stripped = strip_noise(target_lower)
    for blk in ocr_blocks:
        blk_text = blk["text"]
        blk_lower = blk_text.lower()
        blk_stripped = strip_noise(blk_lower)
        if match_mode == "exact":
            if blk_lower == target_lower:
                matches.append(blk)
        elif match_mode == "startswith":
            if blk_lower.startswith(target_lower):
                matches.append(blk)
        elif match_mode == "contains":
            if target_lower in blk_lower:
                matches.append(blk)
        else:  # fuzzy (默认) — 去掉空格和标点后做 contains 匹配
            if target_stripped and target_stripped in blk_stripped:
                matches.append(blk)

    if not matches:
        # 返回所有检测到的文本帮助用户调试
        all_texts = [f'"{b["text"]}"' for b in ocr_blocks[:20]]
        return {
            "status": "error",
            "error": f"未找到包含 '{target_text}' 的文本。\n检测到的文本: {', '.join(all_texts)}"
        }

    # 选择第 index 个匹配
    if index > len(matches):
        return {
            "status": "error",
            "error": f"找到 {len(matches)} 个匹配 '{target_text}' 的文本，但请求的是第 {index} 个。"
        }
    selected = matches[index - 1]
    click_x = selected["clickablePoint"]["x"]
    click_y = selected["clickablePoint"]["y"]

    # 4. 如果有 hwnd 先置前窗口
    if hwnd:
        try:
            import win32gui
            import win32con
            if win32gui.IsIconic(int(hwnd)):
                win32gui.ShowWindow(int(hwnd), win32con.SW_RESTORE)
            win32gui.SetForegroundWindow(int(hwnd))
            time.sleep(0.3)
        except Exception as e:
            debug_log(f"SetForegroundWindow failed: {e}")

    # 5. 安全检查
    screen_w, screen_h = pyautogui.size()
    if click_x < 0 or click_x >= screen_w or click_y < 0 or click_y >= screen_h:
        return {
            "status": "error",
            "error": f"文本 '{selected['text']}' 的坐标 ({click_x}, {click_y}) 超出屏幕范围。"
        }

    # 6. 执行点击
    pyautogui.click(click_x, click_y, button=button, clicks=clicks)

    result_text = (
        f"已点击文本 \"{selected['text']}\"\n"
        f"屏幕坐标: ({click_x}, {click_y})\n"
        f"匹配模式: {match_mode}，第 {index}/{len(matches)} 个匹配\n"
        f"来源: {captured_title}"
    )

    return {
        "status": "success",
        "result": {
            "content": [{"type": "text", "text": result_text}],
            "clickedText": selected["text"],
            "clickedPoint": {"x": click_x, "y": click_y},
            "totalMatches": len(matches),
            "allOcrTexts": [b["text"] for b in ocr_blocks],
        }
    }


# ============================================================
# ClickVisual 指令 — 视觉语义点击（通过图像编辑模型定位）
# ============================================================

def call_vision_edit_api(original_base64, prompt):
    """
    调用图像编辑 API，发送原图和编辑指令，返回编辑后的图像字节。
    支持两种 API 格式：
    - chat: OpenAI 兼容的 /v1/chat/completions（Gemini 3 Pro 等）
    - images: SiliconFlow 的 /images/generations（Qwen-Image-Edit 等）
    """
    import urllib.request
    import urllib.error

    api_base = os.environ.get("VISION_API_BASE_URL", "").strip()
    model = os.environ.get("VISION_EDIT_MODEL", "").strip()
    api_key = os.environ.get("VISION_API_KEY", "").strip()
    api_format = os.environ.get("VISION_API_FORMAT", "chat").strip().lower()

    if not api_base or not model or not api_key:
        raise ValueError(
            "ClickVisual 需要配置 VISION_API_BASE_URL, VISION_EDIT_MODEL, VISION_API_KEY。"
            "请在 config.env 中填写。"
        )

    if api_format == "chat":
        return _call_chat_completions_api(api_base, model, api_key, original_base64, prompt)
    else:
        return _call_images_generations_api(api_base, model, api_key, original_base64, prompt)


def _call_chat_completions_api(api_base, model, api_key, image_data_uri, prompt):
    """
    通过 /v1/chat/completions 调用图像编辑（Gemini / OpenAI 格式）
    请求中图片作为 message content 的 image_url 部分发送。
    返回图片字节。
    """
    import urllib.request
    import urllib.error

    url = api_base.rstrip('/')
    if url.endswith('/v1'):
        url += '/chat/completions'
    else:
        url += '/v1/chat/completions'

    payload = json.dumps({
        "model": model,
        "stream": False,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_uri}}
                ]
            }
        ]
    })

    req = urllib.request.Request(
        url,
        data=payload.encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    debug_log(f"ClickVisual [chat]: 调用 {model} @ {url}")

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Chat API 请求失败 (HTTP {e.code}) URL={url}: {body}")
    except Exception as e:
        raise RuntimeError(f"Chat API 请求异常 URL={url}: {e}")

    # 解析返回的图片：从 message.content 中提取 markdown base64 图片
    message = resp_data.get("choices", [{}])[0].get("message", {})
    content = message.get("content", "")

    # 匹配 markdown 图片: ![...](data:image/xxx;base64,...)
    img_match = re.search(r'!\[.*?\]\((data:image/\w+;base64,[\s\S]*?)\)', content)
    if img_match:
        data_uri = img_match.group(1)
        _, b64_part = data_uri.split(",", 1)
        return base64.b64decode(b64_part.replace("\n", "").replace(" ", ""))

    # 备用: 从 message.images 数组获取
    if message.get("images") and len(message["images"]) > 0:
        img_url = message["images"][0].get("image_url", {}).get("url", "")
        if img_url:
            return _download_image_data(img_url)

    raise RuntimeError(
        f"Chat API 未返回图片。可能触发了安全审核。"
        f"模型返回的文本: {content[:200]}"
    )


def _call_images_generations_api(api_base, model, api_key, image_data_uri, prompt):
    """
    通过 /images/generations 调用图像编辑（SiliconFlow / Qwen 格式）
    """
    import urllib.request
    import urllib.error

    url = f"{api_base.rstrip('/')}/images/generations"

    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "image": image_data_uri,
    })

    req = urllib.request.Request(
        url,
        data=payload.encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    debug_log(f"ClickVisual [images]: 调用 {model} @ {url}")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"Images API 请求失败 (HTTP {e.code}): {body}")
    except Exception as e:
        raise RuntimeError(f"Images API 请求异常: {e}")

    images = resp_data.get("images") or resp_data.get("data")
    if not images or len(images) == 0:
        raise RuntimeError(f"API 未返回图片。响应: {json.dumps(resp_data, ensure_ascii=False)[:300]}")

    img_item = images[0]
    img_url = img_item.get("url") or img_item.get("b64_json")
    if not img_url:
        raise RuntimeError(f"API 返回格式异常: {json.dumps(img_item, ensure_ascii=False)[:200]}")

    return _download_image_data(img_url)


def _download_image_data(img_url):
    """从 URL 或 data URI 或纯 base64 下载/解码图片数据"""
    import urllib.request
    if img_url.startswith("http"):
        debug_log(f"ClickVisual: 下载编辑后图片...")
        with urllib.request.urlopen(img_url, timeout=60) as img_resp:
            return img_resp.read()
    elif img_url.startswith("data:"):
        _, b64_part = img_url.split(",", 1)
        return base64.b64decode(b64_part.replace("\n", "").replace(" ", ""))
    else:
        return base64.b64decode(img_url)


def find_white_circle(img_original, img_edited):
    """
    在编辑后的图片中找到模型画上的白色圆。
    使用密度峰值定位法：先找白色像素最密集的区域（=圆所在位置），
    再在该区域内计算质心。抗散布噪点能力强。
    返回 (center_x, center_y, bounding_box, painted_pct) 或 None
    """
    import numpy as np

    # 确保两图尺寸一致
    if img_edited.size != img_original.size:
        img_edited = img_edited.resize(img_original.size, resample=3)

    arr_orig = np.array(img_original.convert("RGB"), dtype=np.uint8)
    arr_edit = np.array(img_edited.convert("RGB"), dtype=np.uint8)

    # 纯白色检测：R > 240, G > 240, B > 240
    edit_is_white = (
        (arr_edit[:, :, 0] > 240) &
        (arr_edit[:, :, 1] > 240) &
        (arr_edit[:, :, 2] > 240)
    )

    # 原图中已经是白色的区域（排除，避免白色背景干扰）
    orig_is_white = (
        (arr_orig[:, :, 0] > 240) &
        (arr_orig[:, :, 1] > 240) &
        (arr_orig[:, :, 2] > 240)
    )

    # 模型新画上的白色 = 编辑图是白色 且 原图不是白色
    painted_mask = edit_is_white & ~orig_is_white

    painted_count = int(np.sum(painted_mask))
    total_pixels = painted_mask.shape[0] * painted_mask.shape[1]

    if painted_count == 0:
        return None

    painted_pct = round(painted_count / total_pixels * 100, 2)

    # === 密度峰值定位法 ===
    # 把图切成小块，找白色像素最密集的块（= 圆的位置）
    h, w = painted_mask.shape
    block = 30  # 每块 30×30 像素
    bh, bw = h // block, w // block

    if bh == 0 or bw == 0:
        # 图片太小，直接用全局质心
        ys, xs = np.where(painted_mask)
        center_x = int(np.mean(xs))
        center_y = int(np.mean(ys))
    else:
        # 计算每个块的白色像素密度
        trimmed = painted_mask[:bh * block, :bw * block]
        blocks = trimmed.reshape(bh, block, bw, block)
        density = blocks.sum(axis=(1, 3))

        # 找到密度最高的块
        peak_by, peak_bx = np.unravel_index(np.argmax(density), density.shape)

        # 在峰值块周围 5 块范围内计算精确质心（只算圆的像素）
        margin = 5
        y_start = max(0, (peak_by - margin) * block)
        y_end = min(h, (peak_by + margin + 1) * block)
        x_start = max(0, (peak_bx - margin) * block)
        x_end = min(w, (peak_bx + margin + 1) * block)

        local_mask = painted_mask[y_start:y_end, x_start:x_end]
        local_ys, local_xs = np.where(local_mask)

        if len(local_xs) == 0:
            # 降级到全局质心
            ys, xs = np.where(painted_mask)
            center_x = int(np.mean(xs))
            center_y = int(np.mean(ys))
        else:
            center_x = int(np.mean(local_xs)) + x_start
            center_y = int(np.mean(local_ys)) + y_start

    # 边界框（基于圆的局部区域）
    ys_all, xs_all = np.where(painted_mask)
    bbox = {
        "x": int(np.min(xs_all)), "y": int(np.min(ys_all)),
        "width": int(np.max(xs_all) - np.min(xs_all)),
        "height": int(np.max(ys_all) - np.min(ys_all)),
    }

    return center_x, center_y, bbox, painted_pct


def cmd_click_visual(args):
    """
    执行 ClickVisual 指令:
    截图 → 发送到图像编辑模型(涂色) → 像素差异定位 → 自动点击
    """
    import pyautogui
    from PIL import Image
    a = normalize_args(args)

    description = a.get("description") or a.get("target") or a.get("desc") or a.get("text")
    if not description:
        return {"status": "error", "error": "必须提供 description 参数描述要点击的视觉元素。"}

    button = str(a.get("button", "left")).lower()
    clicks = int(a.get("clicks", 1))

    # 1. 截图（通用解析，支持 hwnd/windowTitle/processName/全屏）
    img, hwnd, window_rect, captured_title = _resolve_capture_target(a)
    if img is None:
        return {"status": "error", "error": captured_title}

    # 2. 原图转 base64
    original_data_uri = image_to_base64(img, fmt="PNG")
    debug_log(f"ClickVisual: 截图完成 {img.size}, 准备调用图像编辑模型...")

    # 3. 构建涂色指令：让模型用白色圆盖住目标
    edit_prompt = (
        f"请在图中找到「{description}」的精确位置，"
        f"然后在它的正中心画一个纯白色(#FFFFFF)实心圆，"
        f"圆的大小刚好能完全覆盖住或者标记目标正中心即可，不要画太大。"
        f"圆心必须对准目标的中心。其他区域保持不变。"
    )

    # 4. 调用图像编辑 API
    try:
        edited_bytes = call_vision_edit_api(original_data_uri, edit_prompt)
    except Exception as e:
        return {"status": "error", "error": f"图像编辑 API 调用失败: {e}"}

    # 5. 解析编辑后的图片
    try:
        edited_img = Image.open(io.BytesIO(edited_bytes)).convert("RGB")
    except Exception as e:
        return {"status": "error", "error": f"无法解析 API 返回的图片: {e}"}

    # 5.5 保存调试图片（原图 + 编辑后）
    debug_dir = os.path.join(get_screenshot_dir(), "debug")
    os.makedirs(debug_dir, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    orig_path = os.path.join(debug_dir, f"clickvisual_{ts}_original.png")
    edit_path = os.path.join(debug_dir, f"clickvisual_{ts}_edited.png")
    img.save(orig_path, "PNG")
    edited_img_resized = edited_img.resize(img.size, resample=3) if edited_img.size != img.size else edited_img
    edited_img_resized.save(edit_path, "PNG")
    debug_log(f"ClickVisual: 调试图片已保存 → {debug_dir}")

    # 6. 在编辑后的图中找白色圆球
    paint_result = find_white_circle(img, edited_img)

    if paint_result is None:
        return {
            "status": "error",
            "error": f"在编辑后的图中未检测到白色圆球，模型可能没有正确标记 '{description}'。\n调试图片已保存: {debug_dir}"
        }

    img_center_x, img_center_y, bbox, painted_pct = paint_result

    # 安全检查：白色区域不能太大
    if painted_pct > 30:
        return {
            "status": "error",
            "error": f"白色区域占比 {painted_pct}% 过大，模型可能画错了。\n调试图片已保存: {debug_dir}"
        }

    debug_log(f"ClickVisual: 找到白色圆球 质心=({img_center_x},{img_center_y}) 占比={painted_pct}%")

    # 7. 计算屏幕坐标（确保是 Python 原生 int，避免 numpy int64 序列化问题）
    if window_rect:
        click_x = int(window_rect["x"] + img_center_x)
        click_y = int(window_rect["y"] + img_center_y)
    else:
        click_x = int(img_center_x)
        click_y = int(img_center_y)

    # 8. 置前窗口并点击
    if hwnd:
        try:
            import win32gui
            import win32con
            if win32gui.IsIconic(int(hwnd)):
                win32gui.ShowWindow(int(hwnd), win32con.SW_RESTORE)
            win32gui.SetForegroundWindow(int(hwnd))
            time.sleep(0.3)
        except Exception as e:
            debug_log(f"SetForegroundWindow failed: {e}")

    screen_w, screen_h = pyautogui.size()
    if click_x < 0 or click_x >= screen_w or click_y < 0 or click_y >= screen_h:
        return {
            "status": "error",
            "error": f"计算出的坐标 ({click_x}, {click_y}) 超出屏幕范围 ({screen_w}×{screen_h})。"
        }

    pyautogui.click(click_x, click_y, button=button, clicks=clicks)

    result_text = (
        f"已通过视觉定位点击: \"{description}\"\n"
        f"屏幕坐标: ({click_x}, {click_y})\n"
        f"涂色区域: ({bbox['x']},{bbox['y']}) {bbox['width']}×{bbox['height']} "
        f"占比 {painted_pct}%\n"
        f"来源: {captured_title}"
    )

    return {
        "status": "success",
        "result": {
            "content": [{"type": "text", "text": result_text}],
            "clickedPoint": {"x": click_x, "y": click_y},
            "paintedRegion": bbox,
            "paintedPercentage": painted_pct,
        }
    }


# ============================================================
# TypeText 指令（双轨制：前台剪贴板 / 后台 PostMessage WM_CHAR）
# ============================================================

def cmd_type_text(args):
    """
    执行 TypeText 指令（双轨制）
    - 前台模式（默认）: 通过剪贴板粘贴输入，支持全Unicode/中文
    - 后台模式（有 hwnd/windowTitle）: PostMessage WM_CHAR，不劫持键盘焦点
    """
    a = normalize_args(args)

    text = a.get("text") or a.get("content") or a.get("value")
    if not text:
        return {"status": "error", "error": "必须提供 text 参数指定要输入的文本内容。"}

    text = str(text)
    # 是否在输入后按回车
    press_enter = str(a.get("enter") or a.get("pressenter") or a.get("submit") or "false").lower() in ("true", "1", "yes")

    # 双轨窗口查找
    hwnd, title = _resolve_hwnd(a)

    # ── 双轨：后台模式（PostMessage WM_CHAR，不劫持键盘） ──
    if hwnd:
        user32 = ctypes.windll.user32

        for ch in text:
            user32.PostMessageW(hwnd, WM_CHAR, ord(ch), 0)
            time.sleep(0.005)  # 微小延迟避免丢字

        if press_enter:
            VK_RETURN = 0x0D
            WM_KEYDOWN = 0x0100
            WM_KEYUP = 0x0101
            user32.PostMessageW(hwnd, WM_KEYDOWN, VK_RETURN, 0x001C0001)
            time.sleep(0.02)
            user32.PostMessageW(hwnd, WM_KEYUP, VK_RETURN, 0xC01C0001)

        result_text = (
            f"[后台模式] 已向窗口 \"{title}\" (HWND:{hwnd}) 发送文本输入。\n"
            f"输入内容: \"{text[:100]}{'...' if len(text) > 100 else ''}\"\n"
            f"字符数: {len(text)}"
            + ("\n已按下回车键" if press_enter else "")
            + "\n键盘焦点未被劫持。"
        )
        return {"status": "success", "result": result_text}

    # ── 双轨：前台模式（剪贴板粘贴，支持全Unicode） ──
    import pyautogui

    # 保存原始剪贴板内容，输入后恢复
    try:
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            old_clipboard = win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
        except Exception:
            old_clipboard = None
        win32clipboard.CloseClipboard()
    except Exception:
        old_clipboard = None

    # 将文本写入剪贴板
    try:
        import win32clipboard
        win32clipboard.OpenClipboard()
        win32clipboard.EmptyClipboard()
        win32clipboard.SetClipboardText(text, win32clipboard.CF_UNICODETEXT)
        win32clipboard.CloseClipboard()
    except Exception as e:
        return {"status": "error", "error": f"无法写入剪贴板: {e}"}

    # Ctrl+V 粘贴
    pyautogui.hotkey('ctrl', 'v')
    time.sleep(0.1)

    # 按回车
    if press_enter:
        pyautogui.press('enter')

    # 恢复原始剪贴板内容
    try:
        import win32clipboard
        time.sleep(0.05)
        win32clipboard.OpenClipboard()
        win32clipboard.EmptyClipboard()
        if old_clipboard is not None:
            win32clipboard.SetClipboardText(old_clipboard, win32clipboard.CF_UNICODETEXT)
        win32clipboard.CloseClipboard()
    except Exception:
        pass  # 恢复失败不影响主流程

    result_text = (
        f"已通过剪贴板粘贴输入文本。\n"
        f"输入内容: \"{text[:100]}{'...' if len(text) > 100 else ''}\"\n"
        f"字符数: {len(text)}"
        + ("\n已按下回车键" if press_enter else "")
    )
    return {"status": "success", "result": result_text}


# ============================================================
# ScrollAt 指令（双轨制：前台 pyautogui / 后台 SendMessage）
# ============================================================

def cmd_scroll_at(args):
    """
    执行 ScrollAt 指令（双轨制）
    - 前台模式（无 hwnd/windowTitle）: pyautogui.scroll()，简单快速但劫持鼠标位置
    - 后台模式（有 hwnd 或 windowTitle）: SendMessage WM_MOUSEWHEEL，不劫持鼠标
    """
    import pyautogui
    a = normalize_args(args)

    direction = str(a.get("direction") or a.get("dir") or "").lower()
    if direction not in ("up", "down"):
        return {"status": "error", "error": "必须提供 direction 参数，可选值: up, down。"}

    amount = int(a.get("amount") or a.get("clicks") or a.get("delta") or 3)
    x = a.get("x")
    y = a.get("y")

    # 尝试查找目标窗口（双轨查找）
    hwnd, title = _resolve_hwnd(a)

    # 滚动量：向上为正，向下为负（标准 Windows 滚轮逻辑）
    scroll_delta = amount * WHEEL_DELTA if direction == "up" else -(amount * WHEEL_DELTA)

    # ── 双轨：后台模式（SendMessage WM_MOUSEWHEEL，不劫持鼠标） ──
    if hwnd:
        import win32gui

        if x is not None and y is not None:
            screen_x, screen_y = int(x), int(y)
        else:
            rect = win32gui.GetWindowRect(hwnd)
            screen_x = (rect[0] + rect[2]) // 2
            screen_y = (rect[1] + rect[3]) // 2

        # WM_MOUSEWHEEL 的坐标是屏幕坐标（不是客户区坐标！这是个特例）
        wParam = (scroll_delta << 16) & 0xFFFFFFFF
        lParam = ((screen_y & 0xFFFF) << 16) | (screen_x & 0xFFFF)

        user32 = ctypes.windll.user32
        user32.SendMessageW(hwnd, WM_MOUSEWHEEL, wParam, lParam)

        dir_text = "向上" if direction == "up" else "向下"
        result_text = (
            f"[后台模式] 已向窗口 \"{title}\" (HWND:{hwnd}) 发送滚轮{dir_text} {amount} 个刻度。\n"
            f"滚动位置: 屏幕坐标({screen_x}, {screen_y})\n"
            f"鼠标光标未移动。"
        )
        return {"status": "success", "result": result_text}

    # ── 双轨：前台模式（pyautogui，直接在当前光标或指定位置滚动） ──
    if x is not None and y is not None:
        screen_x, screen_y = int(x), int(y)
        pyautogui_clicks = amount if direction == "up" else -amount
        pyautogui.moveTo(screen_x, screen_y)
        pyautogui.scroll(pyautogui_clicks)
        dir_text = "向上" if direction == "up" else "向下"
        result_text = f"已在屏幕坐标 ({screen_x}, {screen_y}) 处{dir_text}滚动 {amount} 个刻度。"
    else:
        pyautogui_clicks = amount if direction == "up" else -amount
        pyautogui.scroll(pyautogui_clicks)
        dir_text = "向上" if direction == "up" else "向下"
        result_text = f"已在当前鼠标位置{dir_text}滚动 {amount} 个刻度。"

    return {"status": "success", "result": result_text}


# ============================================================
# 指令分发与串行调用
# ============================================================

# ============================================================
# QueryWindows 指令（调用 WindowSensor 更新实时窗口状态）
# ============================================================

def cmd_query_windows(args):
    """
    执行 QueryWindows 指令:
    主动调用 WindowSensor 的 sensor.ps1 获取当前最新的窗口信息
    """
    import subprocess
    import os
    
    current_dir = os.path.dirname(os.path.abspath(__file__))
    sensor_path = os.path.join(current_dir, "..", "WindowSensor", "sensor.ps1")
    
    if not os.path.exists(sensor_path):
        return {"status": "error", "error": f"找不到 sensor.ps1 脚本: {sensor_path}"}
        
    try:
        result = subprocess.run(
            ["powershell", "-ExecutionPolicy", "Bypass", "-NoProfile", "-File", sensor_path],
            capture_output=True,
            text=False,
            timeout=10
        )
        
        if result.returncode != 0:
            err_msg = result.stderr.decode("utf-8", errors="replace")
            return {"status": "error", "error": f"执行 sensor.ps1 失败 (退出码 {result.returncode}): {err_msg}"}
            
        output = result.stdout.decode("utf-8", errors="replace").strip()
        
        if not output:
             return {"status": "error", "error": "执行 sensor.ps1 成功，但未返回任何输出。"}
             
        try:
            parsed_data = json.loads(output)
        except json.JSONDecodeError as e:
            return {"status": "error", "error": f"解析 sensor.ps1 输出失败: {e}\n输出内容: {output[:200]}"}
            
        detailed_text = "成功获取窗口状态"
        if "fold_blocks" in parsed_data:
            for block in parsed_data["fold_blocks"]:
                if block.get("threshold") == 0.7:
                    detailed_text = block.get("content", detailed_text)
                    break
                    
        return {
            "status": "success",
            "result": {
                "content": [{"type": "text", "text": detailed_text}],
                "sensorData": parsed_data
            }
        }
    except subprocess.TimeoutExpired:
        return {"status": "error", "error": "执行 sensor.ps1 超时。"}
    except Exception as e:
        return {"status": "error", "error": f"调用 sensor.ps1 异常: {e}"}


COMMAND_MAP = {
    "querywindows": cmd_query_windows,
    "query": cmd_query_windows,
    "getwindows": cmd_query_windows,
    "screencapture": cmd_screen_capture,
    "capture": cmd_screen_capture,
    "screenshot": cmd_screen_capture,
    "clickat": cmd_click_at,
    "click": cmd_click_at,
    "inspectui": cmd_inspect_ui,
    "inspect": cmd_inspect_ui,
    "uiinspect": cmd_inspect_ui,
    "clicktext": cmd_click_text,
    "textclick": cmd_click_text,
    "clickvisual": cmd_click_visual,
    "visualclick": cmd_click_visual,
    "scrollat": cmd_scroll_at,
    "scroll": cmd_scroll_at,
    "typetext": cmd_type_text,
    "type": cmd_type_text,
    "inputtext": cmd_type_text,
}


def dispatch_command(command, params):
    """根据 command 名调度到对应函数"""
    cmd_key = command.lower().replace("_", "").replace("-", "")
    handler = COMMAND_MAP.get(cmd_key)
    if handler is None:
        return {"status": "error", "error": f"未知指令: '{command}'。可用指令: ScreenCapture, ClickAt, ClickText, ClickVisual, InspectUI, ScrollAt, TypeText, QueryWindows"}
    return handler(params)


def process_request(request):
    """处理请求，支持单个和串行批量调用"""

    # 检测串行调用模式: command1, command2, ...
    serial_keys = sorted([k for k in request.keys() if re.match(r'^command\d+$', k)],
                         key=lambda k: int(re.search(r'\d+', k).group()))

    if serial_keys:
        # 串行批量模式
        results = []
        for i, cmd_key in enumerate(serial_keys):
            # 串行指令间插入 1 秒延迟，等待界面载入/刷新
            if i > 0:
                debug_log(f"串行指令间延迟 1 秒，等待界面刷新...")
                time.sleep(1)

            idx = re.search(r'\d+', cmd_key).group()
            command = request[cmd_key]

            # 提取该命令对应的参数（带相同数字后缀的 key）
            params = {}
            suffix = idx
            for k, v in request.items():
                if k == cmd_key:
                    continue
                if k.endswith(suffix) and k != cmd_key:
                    # 去掉数字后缀得到参数名
                    param_name = k[:-len(suffix)]
                    params[param_name] = v

            result = dispatch_command(command, params)
            results.append({
                "commandIndex": int(idx),
                "command": command,
                "result": result
            })

        # 汇总串行结果 — 始终返回 success（VCP 只认 success/error）
        # 每步的成功/失败信息写在 content 和 serialResults 里
        success_count = sum(1 for r in results if r["result"].get("status") == "success")
        total = len(results)
        summary_parts = []
        for r in results:
            s = r["result"].get("status", "unknown")
            icon = "✅" if s == "success" else "❌"
            summary_parts.append(f"  {icon} 指令{r['commandIndex']}({r['command']}): {s}")

        header = f"串行执行完成: {success_count}/{total} 成功"
        return {
            "status": "success",
            "result": {
                "content": [
                    {"type": "text", "text": header + "\n" + "\n".join(summary_parts)}
                ],
                "serialResults": results,
                "totalCommands": total,
                "successCount": success_count,
            }
        }

    # 单指令模式
    command = request.get("command")
    if not command:
        return {"status": "error", "error": "缺少 command 参数。可用指令: ScreenCapture, ClickAt, InspectUI, QueryWindows, etc."}

    # 移除 command 键，剩余的都作为参数
    params = {k: v for k, v in request.items() if k != "command"}
    return dispatch_command(command, params)


# ============================================================
# 主入口
# ============================================================

def main():
    try:
        # 从 stdin 读取 JSON 输入
        raw_input = sys.stdin.readline().strip()
        if not raw_input:
            output_result("error", error="没有收到任何输入。请通过 stdin 发送 JSON 参数。")
            sys.exit(1)

        request = json.loads(raw_input)
        debug_log(f"收到请求: {json.dumps(request, ensure_ascii=False)[:200]}")

        result = process_request(request)

        output_result(result.get("status", "success"),
                      result=result.get("result"),
                      error=result.get("error"))

    except json.JSONDecodeError as e:
        output_result("error", error=f"JSON 解析失败: {e}")
        sys.exit(1)
    except Exception as e:
        debug_log(f"未捕获异常: {traceback.format_exc()}")
        output_result("error", error=f"插件执行异常: {str(e)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
