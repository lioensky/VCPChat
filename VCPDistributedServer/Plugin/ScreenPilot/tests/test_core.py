# -*- coding: utf-8 -*-
"""ScreenPilot 核心纯函数回归测试。"""

import time
import unittest

from PIL import Image, ImageDraw

from screenpilot_core.errors import ScreenPilotError, error_payload
from screenpilot_core.geometry import (
    Rect,
    clipped_capture_rect,
    image_point_to_screen,
    is_point_on_virtual_screen,
    screen_point_to_image,
)
from screenpilot_core.image_edit import find_white_marker
from screenpilot_core.interaction import parse_channels, run_fallback, wait_until


class GeometryTests(unittest.TestCase):
    def test_negative_virtual_screen_coordinates(self):
        virtual = Rect(-1920, -200, 3840, 1280)
        self.assertTrue(is_point_on_virtual_screen(-1900, -100, virtual))
        self.assertTrue(is_point_on_virtual_screen(1919, 1079, virtual))
        self.assertFalse(is_point_on_virtual_screen(-1921, 0, virtual))
        self.assertFalse(is_point_on_virtual_screen(1920, 0, virtual))

    def test_capture_rect_clips_offscreen_window(self):
        virtual = Rect(0, 0, 1920, 1080)
        window = Rect(-100, 50, 800, 600)
        capture = clipped_capture_rect(window, virtual)
        self.assertEqual(capture, Rect(0, 50, 700, 600))
        self.assertEqual(image_point_to_screen(20, 30, capture), (20, 80))
        self.assertEqual(screen_point_to_image(20, 80, capture), (20, 30))

    def test_rect_edges_are_half_open(self):
        rect = Rect(-10, -10, 20, 20)
        self.assertTrue(rect.contains_point(-10, -10))
        self.assertTrue(rect.contains_point(9, 9))
        self.assertFalse(rect.contains_point(10, 9))
        self.assertFalse(rect.contains_point(9, 10))


class ErrorTests(unittest.TestCase):
    def test_structured_error_payload(self):
        error = ScreenPilotError(
            "ELEMENT_NOT_FOUND",
            "missing",
            retryable=True,
            details={"selector": {"name": "OK"}},
        )
        self.assertEqual(error_payload(error), {
            "code": "ELEMENT_NOT_FOUND",
            "message": "missing",
            "retryable": True,
            "details": {"selector": {"name": "OK"}},
        })


class InteractionTests(unittest.TestCase):
    def test_channel_aliases_preserve_order(self):
        self.assertEqual(
            parse_channels("automation > text > vision"),
            ["uia", "ocr", "image_edit"],
        )

    def test_fallback_uses_next_channel(self):
        def failed():
            return {"status": "error", "error": "not found"}

        result, channel, attempts = run_fallback(
            ["uia", "ocr"],
            {
                "uia": failed,
                "ocr": lambda: {"status": "success", "result": "clicked"},
            },
        )
        self.assertEqual(channel, "ocr")
        self.assertEqual(result["result"], "clicked")
        self.assertEqual(
            [attempt["status"] for attempt in attempts],
            ["failed", "success"],
        )

    def test_wait_until_returns_attempt_metadata(self):
        state = {"count": 0}

        def probe():
            state["count"] += 1
            return "ready" if state["count"] >= 3 else None

        value, attempts, elapsed = wait_until(
            probe,
            timeout_ms=1000,
            poll_interval_ms=20,
            description="测试条件",
        )
        self.assertEqual(value, "ready")
        self.assertEqual(attempts, 3)
        self.assertGreaterEqual(elapsed, 0)

    def test_wait_timeout_is_structured(self):
        started = time.monotonic()
        with self.assertRaises(ScreenPilotError) as context:
            wait_until(
                lambda: None,
                timeout_ms=60,
                poll_interval_ms=20,
                description="永不满足",
            )
        self.assertEqual(context.exception.code, "WAIT_TIMEOUT")
        self.assertTrue(context.exception.retryable)
        self.assertGreaterEqual(time.monotonic() - started, 0.04)


class ImageEditTests(unittest.TestCase):
    def test_white_marker_location(self):
        original = Image.new("RGB", (200, 120), (20, 30, 40))
        edited = original.copy()
        draw = ImageDraw.Draw(edited)
        draw.ellipse((80, 40, 100, 60), fill=(255, 255, 255))

        result = find_white_marker(original, edited)
        self.assertIsNotNone(result)
        center_x, center_y, box, percentage = result
        self.assertLessEqual(abs(center_x - 90), 2)
        self.assertLessEqual(abs(center_y - 50), 2)
        self.assertGreater(box["width"], 0)
        self.assertGreater(box["height"], 0)
        self.assertGreater(percentage, 0)

    def test_existing_white_area_is_ignored(self):
        original = Image.new("RGB", (60, 60), (255, 255, 255))
        edited = original.copy()
        self.assertIsNone(find_white_marker(original, edited))


if __name__ == "__main__":
    unittest.main()