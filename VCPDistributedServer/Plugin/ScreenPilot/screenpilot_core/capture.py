# -*- coding: utf-8 -*-
"""截图后端：DXGI Desktop Duplication 与虚拟桌面 ImageGrab fallback。"""

from .geometry import Rect, clipped_capture_rect, get_virtual_screen_rect

_dxcam_camera = None
_dxcam_unavailable_reason = None


def _primary_screen_rect(user32=None):
    """返回主显示器物理像素矩形；dxcam 默认 output_idx=0 使用此坐标空间。"""
    if user32 is None:
        import ctypes
        user32 = ctypes.windll.user32
    return Rect(
        0,
        0,
        int(user32.GetSystemMetrics(0)),
        int(user32.GetSystemMetrics(1)),
    )


def _get_dxcam(debug_log=None):
    """延迟创建并复用 DXGI Desktop Duplication 会话。"""
    global _dxcam_camera, _dxcam_unavailable_reason
    if _dxcam_camera is not None:
        return _dxcam_camera
    if _dxcam_unavailable_reason is not None:
        return None

    try:
        import dxcam
        _dxcam_camera = dxcam.create(output_idx=0, output_color="RGB")
        if debug_log:
            debug_log("DXGI Desktop Duplication (dxcam) 已初始化")
        return _dxcam_camera
    except Exception as error:
        _dxcam_unavailable_reason = str(error)
        if debug_log:
            debug_log(f"DXGI Desktop Duplication 不可用，将使用桌面裁剪: {error}")
        return None


def capture_dxgi(rect, debug_log=None):
    """
    使用 dxcam 截取主显示器区域。

    dxcam 的 region 使用 (left, top, right, bottom)，且默认输出只覆盖
    主显示器。跨显示器或负坐标区域由上层改走 ImageGrab。
    """
    from PIL import Image

    target = Rect.from_mapping(rect)
    primary = _primary_screen_rect()
    if target.width <= 0 or target.height <= 0:
        raise ValueError("DXGI 截图区域为空。")
    if target.intersect(primary) != target:
        raise ValueError("DXGI 默认输出不覆盖该跨屏或负坐标区域。")

    camera = _get_dxcam(debug_log)
    if camera is None:
        raise RuntimeError(
            f"dxcam 不可用: {_dxcam_unavailable_reason or 'unknown reason'}"
        )

    frame = camera.grab(region=(
        target.left,
        target.top,
        target.right,
        target.bottom,
    ))
    if frame is None:
        raise RuntimeError("dxcam 未返回画面帧。")
    return Image.fromarray(frame, mode="RGB")


def capture_virtual_desktop_region(rect, debug_log=None):
    """使用 Pillow ImageGrab 截取虚拟桌面区域，支持负坐标副屏。"""
    from PIL import ImageGrab

    target = Rect.from_mapping(rect)
    virtual = get_virtual_screen_rect()
    capture = target.intersect(virtual)
    if capture.width <= 0 or capture.height <= 0:
        raise ValueError("目标区域完全位于虚拟桌面之外。")

    full_image = ImageGrab.grab(all_screens=True)
    crop_box = (
        capture.left - virtual.left,
        capture.top - virtual.top,
        capture.right - virtual.left,
        capture.bottom - virtual.top,
    )
    image = full_image.crop(crop_box)
    if debug_log:
        debug_log(
            f"虚拟桌面裁剪成功 {image.size}: "
            f"({capture.left},{capture.top})→({capture.right},{capture.bottom})"
        )
    return image, capture


def capture_window_fallback(window_rect, *, prefer_dxgi=True, debug_log=None):
    """
    捕获窗口可见区域。

    返回 (image, capture_rect, backend)。主显示器内优先真正 DXGI；
    跨屏、负坐标或 DXGI 失败时回退 ImageGrab。
    """
    window = Rect.from_mapping(window_rect)
    virtual = get_virtual_screen_rect()
    capture = clipped_capture_rect(window, virtual)
    if capture.width <= 0 or capture.height <= 0:
        raise ValueError("窗口完全位于虚拟桌面之外，无法截图。")

    if prefer_dxgi:
        try:
            return capture_dxgi(capture, debug_log), capture, "dxgi_desktop_duplication"
        except Exception as error:
            if debug_log:
                debug_log(f"DXGI 截图失败，回退虚拟桌面裁剪: {error}")

    image, actual = capture_virtual_desktop_region(capture, debug_log)
    return image, actual, "desktop_crop"


def capture_full_virtual_desktop(debug_log=None):
    """截取完整虚拟桌面，返回 (image, rect, backend)。"""
    from PIL import ImageGrab

    virtual = get_virtual_screen_rect()
    image = ImageGrab.grab(all_screens=True)
    if debug_log:
        debug_log(
            f"完整虚拟桌面截图成功 {image.size}: "
            f"({virtual.x},{virtual.y} {virtual.width}×{virtual.height})"
        )
    return image, virtual, "imagegrab"


def reset_capture_backend():
    """释放进程内截图后端引用，主要供测试与 Worker 重建使用。"""
    global _dxcam_camera, _dxcam_unavailable_reason
    camera = _dxcam_camera
    _dxcam_camera = None
    _dxcam_unavailable_reason = None
    if camera is not None:
        try:
            camera.stop()
        except Exception:
            pass