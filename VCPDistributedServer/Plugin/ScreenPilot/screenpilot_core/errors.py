# -*- coding: utf-8 -*-
"""ScreenPilot 的结构化错误契约。"""


class ScreenPilotError(Exception):
    """具有稳定错误码、重试建议和诊断信息的插件异常。"""

    def __init__(self, code, message, *, retryable=False, details=None):
        super().__init__(message)
        self.code = str(code or "SCREENPILOT_ERROR")
        self.message = str(message)
        self.retryable = bool(retryable)
        self.details = dict(details or {})

    def to_dict(self):
        payload = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details:
            payload["details"] = self.details
        return payload


def error_payload(error, default_code="SCREENPILOT_ERROR"):
    """把任意异常归一化为稳定的 JSON 结构。"""
    if isinstance(error, ScreenPilotError):
        return error.to_dict()
    return {
        "code": default_code,
        "message": str(error),
        "retryable": False,
    }