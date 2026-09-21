# -*- coding: utf-8 -*-
"""ScreenPilot 坐标空间与矩形运算。"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Rect:
    """右、下边界均为开区间的物理像素矩形。"""

    x: int
    y: int
    width: int
    height: int

    @property
    def left(self):
        return self.x

    @property
    def top(self):
        return self.y

    @property
    def right(self):
        return self.x + self.width

    @property
    def bottom(self):
        return self.y + self.height

    @classmethod
    def from_ltrb(cls, left, top, right, bottom):
        return cls(
            int(left),
            int(top),
            max(0, int(right) - int(left)),
            max(0, int(bottom) - int(top)),
        )

    @classmethod
    def from_mapping(cls, value):
        if isinstance(value, cls):
            return value
        if not isinstance(value, dict):
            raise TypeError("矩形必须是 Rect 或包含 x/y/width/height 的对象。")
        return cls(
            int(value["x"]),
            int(value["y"]),
            max(0, int(value["width"])),
            max(0, int(value["height"])),
        )

    def intersect(self, other):
        other = Rect.from_mapping(other)
        left = max(self.left, other.left)
        top = max(self.top, other.top)
        right = min(self.right, other.right)
        bottom = min(self.bottom, other.bottom)
        if right <= left or bottom <= top:
            return Rect(left, top, 0, 0)
        return Rect.from_ltrb(left, top, right, bottom)

    def contains_point(self, x, y):
        return self.left <= int(x) < self.right and self.top <= int(y) < self.bottom

    def to_dict(self, *, space="screenPhysical"):
        return {
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "space": space,
        }


def get_virtual_screen_rect(user32=None):
    """
    获取整个 Windows 虚拟桌面的物理像素边界。

    副屏位于主屏左侧或上方时，x/y 可以为负数。
    """
    if user32 is None:
        import ctypes
        user32 = ctypes.windll.user32

    sm_xvirtualscreen = 76
    sm_yvirtualscreen = 77
    sm_cxvirtualscreen = 78
    sm_cyvirtualscreen = 79
    return Rect(
        int(user32.GetSystemMetrics(sm_xvirtualscreen)),
        int(user32.GetSystemMetrics(sm_yvirtualscreen)),
        int(user32.GetSystemMetrics(sm_cxvirtualscreen)),
        int(user32.GetSystemMetrics(sm_cyvirtualscreen)),
    )


def image_point_to_screen(image_x, image_y, capture_rect):
    """
    把截图图像像素坐标转换为物理屏幕坐标。

    必须使用实际 captureRect，而不是原始 windowRect；窗口部分移出
    虚拟桌面时，两者原点并不相同。
    """
    rect = Rect.from_mapping(capture_rect)
    return int(rect.x + image_x), int(rect.y + image_y)


def screen_point_to_image(screen_x, screen_y, capture_rect):
    """把物理屏幕坐标转换为截图图像坐标。"""
    rect = Rect.from_mapping(capture_rect)
    return int(screen_x - rect.x), int(screen_y - rect.y)


def is_point_on_virtual_screen(x, y, virtual_rect=None):
    """判断物理屏幕点是否落在整个虚拟桌面内。"""
    rect = Rect.from_mapping(virtual_rect) if virtual_rect is not None else get_virtual_screen_rect()
    return rect.contains_point(x, y)


def clipped_capture_rect(window_rect, virtual_rect=None):
    """计算窗口与虚拟桌面的实际可捕获交集。"""
    window = Rect.from_mapping(window_rect)
    virtual = Rect.from_mapping(virtual_rect) if virtual_rect is not None else get_virtual_screen_rect()
    return window.intersect(virtual)