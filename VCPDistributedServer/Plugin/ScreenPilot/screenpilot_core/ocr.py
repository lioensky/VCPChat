# -*- coding: utf-8 -*-
"""RapidOCR 常驻引擎、图像预处理与坐标归一化。"""

from .geometry import image_point_to_screen

_engine = None


def get_engine(debug_log=None):
    """延迟初始化 RapidOCR；常驻 Worker 生命周期内复用。"""
    global _engine
    if _engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _engine = RapidOCR()
        if debug_log:
            debug_log("RapidOCR 引擎已初始化")
    return _engine


def run_ocr(img, capture_rect=None, *, scale=None, contrast=1.3,
            sharpen=True, min_confidence=0.0, debug_log=None):
    """
    对 PIL Image 执行 OCR。

    ``capture_rect`` 是图像实际对应的物理屏幕区域；存在时，
    clickablePoint 返回 screenPhysical 坐标。
    """
    import numpy as np
    from PIL import ImageEnhance, ImageFilter

    engine = get_engine(debug_log)
    img_rgb = img.convert("RGB")
    orig_w, orig_h = img_rgb.size

    if scale is None:
        scale = 2.0 if orig_w < 2560 or orig_h < 1440 else 1.0
    scale = max(0.5, min(float(scale), 4.0))

    if scale != 1.0:
        img_rgb = img_rgb.resize(
            (max(1, int(orig_w * scale)), max(1, int(orig_h * scale))),
            resample=3,
        )
    if sharpen:
        img_rgb = img_rgb.filter(ImageFilter.SHARPEN)
    if contrast and float(contrast) != 1.0:
        img_rgb = ImageEnhance.Contrast(img_rgb).enhance(float(contrast))

    result, _ = engine(np.array(img_rgb))
    if not result:
        return []

    blocks = []
    for item in result:
        bbox_points, text, confidence = item
        confidence = float(confidence)
        if confidence < float(min_confidence):
            continue

        xs = [point[0] / scale for point in bbox_points]
        ys = [point[1] / scale for point in bbox_points]
        x_min, x_max = int(min(xs)), int(max(xs))
        y_min, y_max = int(min(ys)), int(max(ys))
        center_x = (x_min + x_max) // 2
        center_y = (y_min + y_max) // 2

        block = {
            "text": text,
            "confidence": round(confidence, 3),
            "boundingBox": {
                "x": x_min,
                "y": y_min,
                "width": x_max - x_min,
                "height": y_max - y_min,
            },
            "imagePoint": {
                "x": center_x,
                "y": center_y,
                "space": "imagePixel",
            },
        }

        if capture_rect:
            screen_x, screen_y = image_point_to_screen(
                center_x, center_y, capture_rect
            )
            block["clickablePoint"] = {
                "x": screen_x,
                "y": screen_y,
                "space": "screenPhysical",
            }
        else:
            block["clickablePoint"] = {
                "x": center_x,
                "y": center_y,
                "space": "imagePixel",
            }
        blocks.append(block)

    return blocks


def reset_engine():
    """供测试或 Worker 重建时显式释放引擎引用。"""
    global _engine
    _engine = None