# -*- coding: utf-8 -*-
"""图生图局部编辑 API 与像素差分定位。"""

import base64
import json
import re
import urllib.error
import urllib.request


def download_image_data(image_source, debug_log=None):
    """从 HTTP URL、data URI 或纯 base64 解码图片。"""
    if image_source.startswith("http"):
        if debug_log:
            debug_log("ClickVisual: 下载局部编辑后的图片...")
        with urllib.request.urlopen(image_source, timeout=60) as response:
            return response.read()
    if image_source.startswith("data:"):
        _, encoded = image_source.split(",", 1)
        return base64.b64decode(encoded.replace("\n", "").replace(" ", ""))
    return base64.b64decode(image_source)


def call_chat_api(api_base, model, api_key, image_data_uri, prompt,
                  debug_log=None):
    """调用 OpenAI 兼容 chat/completions 图生图接口。"""
    url = api_base.rstrip("/")
    url += "/chat/completions" if url.endswith("/v1") else "/v1/chat/completions"
    payload = json.dumps({
        "model": model,
        "stream": False,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data_uri}},
            ],
        }],
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    if debug_log:
        debug_log(f"ClickVisual [chat]: 调用图生图模型 {model} @ {url}")

    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(
            f"Chat API 请求失败 (HTTP {error.code}) URL={url}: {body}"
        ) from error
    except Exception as error:
        raise RuntimeError(f"Chat API 请求异常 URL={url}: {error}") from error

    message = data.get("choices", [{}])[0].get("message", {})
    content = message.get("content", "")
    match = re.search(
        r"!\[.*?\]\((data:image/\w+;base64,[\s\S]*?)\)",
        content,
    )
    if match:
        _, encoded = match.group(1).split(",", 1)
        return base64.b64decode(encoded.replace("\n", "").replace(" ", ""))

    images = message.get("images") or []
    if images:
        image_source = images[0].get("image_url", {}).get("url", "")
        if image_source:
            return download_image_data(image_source, debug_log)

    raise RuntimeError(
        "Chat API 未返回编辑图片。"
        f"模型返回文本: {str(content)[:200]}"
    )


def call_images_api(api_base, model, api_key, image_data_uri, prompt,
                    debug_log=None):
    """调用 images/generations 风格的图生图接口。"""
    url = f"{api_base.rstrip('/')}/images/generations"
    payload = json.dumps({
        "model": model,
        "prompt": prompt,
        "image": image_data_uri,
    }).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    if debug_log:
        debug_log(f"ClickVisual [images]: 调用图生图模型 {model} @ {url}")

    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(
            f"Images API 请求失败 (HTTP {error.code}): {body}"
        ) from error
    except Exception as error:
        raise RuntimeError(f"Images API 请求异常: {error}") from error

    images = data.get("images") or data.get("data")
    if not images:
        raise RuntimeError(
            f"API 未返回图片。响应: {json.dumps(data, ensure_ascii=False)[:300]}"
        )
    source = images[0].get("url") or images[0].get("b64_json")
    if not source:
        raise RuntimeError(
            f"API 返回格式异常: {json.dumps(images[0], ensure_ascii=False)[:200]}"
        )
    return download_image_data(source, debug_log)


def call_edit_api(api_base, model, api_key, api_format, image_data_uri,
                  prompt, debug_log=None):
    """按配置调用图生图局部编辑接口。"""
    if not api_base or not model:
        raise ValueError(
            "ClickVisual 需要配置 VISION_API_BASE_URL 和 VISION_EDIT_MODEL。"
        )
    normalized = str(api_format or "chat").strip().lower()
    if normalized == "chat":
        return call_chat_api(
            api_base, model, api_key, image_data_uri, prompt, debug_log
        )
    return call_images_api(
        api_base, model, api_key, image_data_uri, prompt, debug_log
    )


def find_white_marker(original, edited):
    """
    定位图生图模型新绘制的白色标记。

    返回 (center_x, center_y, bounding_box, painted_percentage)，
    算法保留原有密度峰值策略。
    """
    import numpy as np

    if edited.size != original.size:
        edited = edited.resize(original.size, resample=3)

    original_array = np.array(original.convert("RGB"), dtype=np.uint8)
    edited_array = np.array(edited.convert("RGB"), dtype=np.uint8)
    edited_white = (
        (edited_array[:, :, 0] > 240)
        & (edited_array[:, :, 1] > 240)
        & (edited_array[:, :, 2] > 240)
    )
    original_white = (
        (original_array[:, :, 0] > 240)
        & (original_array[:, :, 1] > 240)
        & (original_array[:, :, 2] > 240)
    )
    mask = edited_white & ~original_white
    count = int(np.sum(mask))
    if count == 0:
        return None

    total = mask.shape[0] * mask.shape[1]
    percentage = round(count / total * 100, 2)
    height, width = mask.shape
    block_size = 30
    block_rows, block_columns = height // block_size, width // block_size

    if block_rows == 0 or block_columns == 0:
        ys, xs = np.where(mask)
        center_x, center_y = int(np.mean(xs)), int(np.mean(ys))
    else:
        trimmed = mask[
            :block_rows * block_size,
            :block_columns * block_size,
        ]
        blocks = trimmed.reshape(
            block_rows, block_size, block_columns, block_size
        )
        density = blocks.sum(axis=(1, 3))
        peak_row, peak_column = np.unravel_index(
            np.argmax(density), density.shape
        )
        margin = 5
        y_start = max(0, (peak_row - margin) * block_size)
        y_end = min(height, (peak_row + margin + 1) * block_size)
        x_start = max(0, (peak_column - margin) * block_size)
        x_end = min(width, (peak_column + margin + 1) * block_size)
        local_ys, local_xs = np.where(mask[y_start:y_end, x_start:x_end])
        if len(local_xs) == 0:
            ys, xs = np.where(mask)
            center_x, center_y = int(np.mean(xs)), int(np.mean(ys))
        else:
            center_x = int(np.mean(local_xs)) + x_start
            center_y = int(np.mean(local_ys)) + y_start

    all_ys, all_xs = np.where(mask)
    box = {
        "x": int(np.min(all_xs)),
        "y": int(np.min(all_ys)),
        "width": int(np.max(all_xs) - np.min(all_xs)),
        "height": int(np.max(all_ys) - np.min(all_ys)),
    }
    return center_x, center_y, box, percentage