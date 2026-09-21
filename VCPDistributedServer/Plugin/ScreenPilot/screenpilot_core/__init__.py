# -*- coding: utf-8 -*-
"""ScreenPilot 可复用核心模块。"""

from .errors import ScreenPilotError, error_payload
from .geometry import (
    Rect,
    get_virtual_screen_rect,
    image_point_to_screen,
    is_point_on_virtual_screen,
)

__all__ = [
    "ScreenPilotError",
    "error_payload",
    "Rect",
    "get_virtual_screen_rect",
    "image_point_to_screen",
    "is_point_on_virtual_screen",
]