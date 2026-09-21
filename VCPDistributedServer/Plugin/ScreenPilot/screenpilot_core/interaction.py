# -*- coding: utf-8 -*-
"""统一交互编排、等待和验证工具。"""

import time

from .errors import ScreenPilotError


DEFAULT_CHANNELS = ("uia", "ocr", "image_edit")


def parse_channels(value):
    """解析感知通道列表，并保留稳定顺序。"""
    if value is None or value == "":
        return list(DEFAULT_CHANNELS)
    if isinstance(value, str):
        items = value.replace(">", ",").split(",")
    elif isinstance(value, (list, tuple)):
        items = value
    else:
        raise ScreenPilotError("INVALID_CHANNELS", "channels 必须是字符串或数组。")

    aliases = {
        "ui": "uia",
        "automation": "uia",
        "text": "ocr",
        "vision": "image_edit",
        "visual": "image_edit",
        "imageedit": "image_edit",
        "image-edit": "image_edit",
    }
    result = []
    for item in items:
        normalized = aliases.get(str(item).strip().lower(), str(item).strip().lower())
        if normalized not in DEFAULT_CHANNELS:
            raise ScreenPilotError(
                "INVALID_CHANNEL",
                f"不支持的交互通道：{item}。可用值：uia、ocr、image_edit。",
            )
        if normalized not in result:
            result.append(normalized)
    if not result:
        raise ScreenPilotError("INVALID_CHANNELS", "channels 不能为空。")
    return result


def wait_until(probe, *, timeout_ms=10000, poll_interval_ms=200,
               description="条件", ignore_errors=True):
    """
    轮询 probe，直到其返回真值。

    返回 (value, attempts, elapsed_ms)。超时抛出结构化异常。
    """
    timeout_ms = max(0, min(int(timeout_ms), 600000))
    poll_interval_ms = max(20, min(int(poll_interval_ms), 10000))
    started = time.monotonic()
    attempts = 0
    last_error = None

    while True:
        attempts += 1
        try:
            value = probe()
            if value:
                elapsed = round((time.monotonic() - started) * 1000, 2)
                return value, attempts, elapsed
        except Exception as error:
            last_error = error
            if not ignore_errors:
                raise

        elapsed_ms = (time.monotonic() - started) * 1000
        if elapsed_ms >= timeout_ms:
            details = {
                "description": description,
                "attempts": attempts,
                "elapsedMs": round(elapsed_ms, 2),
            }
            if last_error is not None:
                details["lastError"] = str(last_error)
            raise ScreenPilotError(
                "WAIT_TIMEOUT",
                f"等待{description}超时（{timeout_ms}ms）。",
                retryable=True,
                details=details,
            )
        remaining_ms = timeout_ms - elapsed_ms
        time.sleep(min(poll_interval_ms, remaining_ms) / 1000)


def run_fallback(channels, handlers):
    """
    按通道依次执行定位/动作。

    handler 成功应返回结果；失败可抛异常或返回
    {"status": "error", "error": "..."}。
    """
    attempts = []
    for channel in channels:
        handler = handlers.get(channel)
        if handler is None:
            attempts.append({
                "channel": channel,
                "status": "unavailable",
                "error": "当前动作没有配置该通道。",
            })
            continue

        started = time.monotonic()
        try:
            result = handler()
            elapsed_ms = round((time.monotonic() - started) * 1000, 2)
            if isinstance(result, dict) and result.get("status") == "error":
                attempts.append({
                    "channel": channel,
                    "status": "failed",
                    "elapsedMs": elapsed_ms,
                    "error": str(result.get("error") or "通道执行失败。"),
                    "errorDetails": result.get("errorDetails"),
                })
                continue
            attempts.append({
                "channel": channel,
                "status": "success",
                "elapsedMs": elapsed_ms,
            })
            return result, channel, attempts
        except Exception as error:
            attempts.append({
                "channel": channel,
                "status": "failed",
                "elapsedMs": round((time.monotonic() - started) * 1000, 2),
                "error": str(error),
            })

    raise ScreenPilotError(
        "ALL_CHANNELS_FAILED",
        "所有目标定位通道均失败。",
        retryable=True,
        details={"attempts": attempts},
    )