#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys
import base64
import json
import os
import platform
import subprocess
from pathlib import Path
from typing import Dict, List, Optional, Tuple


class UserInputHandler:
    def __init__(self):
        self.system = platform.system().lower()
        self.result = None
        self.cancelled = False
        
    def show_input_dialog(self, prompt: str, options: List[Tuple[str, str]], timeout: int = 1200, placeholder: str = "", title: str = "等待用户回复") -> str:
        """
        显示输入对话框
        
        Args:
            prompt: 提示信息
            options: 选项列表，格式为 [(key, content), ...]
            timeout: 超时时间（秒）
            placeholder: 输入框默认内容（会被全选）
            title: 对话框标题
            
        Returns:
            用户输入的内容，或特殊状态字符串
        """
        if self.system == "darwin":  # macOS
            return self._show_macos_dialog(prompt, options, timeout, placeholder, title)
        elif self.system == "windows":  # Windows
            return self._show_windows_dialog(prompt, options, timeout, placeholder, title)
        else:  # Linux and others
            # 导入并委托给 Linux 专用模块
            from linux_dialog import LinuxDialogHandler
            handler = LinuxDialogHandler()
            return handler.show_dialog(prompt, options, timeout, placeholder, title)
    
    def _show_macos_dialog(self, prompt: str, options: List[Tuple[str, str]], timeout: int, placeholder: str = "", title: str = "等待用户回复") -> str:
        """macOS 使用 AppleScript 显示对话框，支持占位符和禁用Cmd+.快捷键"""
        try:
            # 构建选项文本
            options_text = ""
            if options:
                options_text = "\\n\\n可选项（按数字键快速选择）:\\n"
                for i, (key, content) in enumerate(options, 1):
                    # 转义特殊字符
                    escaped_content = content.replace('"', '\\"').replace('\\', '\\\\').replace('\n', '\\n')
                    options_text += f"{i}. {escaped_content}\\n"
            
            # 转义提示文本和占位符中的特殊字符
            escaped_prompt = prompt.replace('"', '\\"').replace('\\', '\\\\').replace('\n', '\\n')
            escaped_placeholder = placeholder.replace('"', '\\"').replace('\\', '\\\\').replace('\n', '\\n')
            
            # 构建完整提示文本，添加快捷键说明
            full_prompt = f"{escaped_prompt}{options_text}\\n\\n[ESC]可取消回复｜[～]可禁用本工具"
            
            print(f"DEBUG: Executing AppleScript for macOS dialog with timeout {timeout}s, placeholder: '{placeholder}'", file=sys.stderr)
            
            # 转义标题中的特殊字符
            escaped_title = title.replace('"', '\\"').replace('\\', '\\\\').replace('\n', '\\n')
            
            # 使用带有禁用按钮的AppleScript
            basic_script = f'display dialog "{full_prompt}" default answer "{escaped_placeholder}" with title "{escaped_title}" buttons {{"取消", "禁用", "确定"}} default button "确定" cancel button "取消" giving up after {timeout}'
            
            # 执行 AppleScript
            result = subprocess.run(
                ['osascript', '-e', basic_script],
                capture_output=True,
                text=True,
                timeout=timeout + 10
            )
            
            print(f"DEBUG: AppleScript result - returncode: {result.returncode}, stdout: '{result.stdout.strip()}', stderr: '{result.stderr.strip()}'", file=sys.stderr)
            
            if result.returncode == 0:
                # 解析输出，格式通常是 "button returned:确定, text returned:用户输入, gave up:false"
                output = result.stdout.strip()
                
                # 检查是否超时
                if "gave up:true" in output:
                    print("DEBUG: Dialog timed out (gave up:true)", file=sys.stderr)
                    return "（对方未回复明确内容）"
                
                # 检查用户是否点击了"禁用"按钮
                if "button returned:禁用" in output:
                    print("DEBUG: User clicked disable button", file=sys.stderr)
                    return self._get_disable_message()
                
                if "text returned:" in output:
                    # 提取用户输入的文本
                    text_part = output.split("text returned:")[1]
                    # 移除可能的后续部分（如 ", gave up:false"）
                    if "," in text_part:
                        text_part = text_part.split(",")[0]
                    text_part = text_part.strip()
                    
                    # 检查是否是特殊的禁用命令
                    if self._is_disable_command(text_part):
                        print("DEBUG: Disable command detected in text input", file=sys.stderr)
                        return self._get_disable_message()
                    
                    if not text_part:
                        return "（对方未回复明确内容）"
                    
                    # 检查是否是数字选择
                    if text_part.isdigit() and 1 <= int(text_part) <= len(options):
                        return options[int(text_part) - 1][1]
                    
                    return text_part
                    
            elif result.returncode == 1:
                # 检查是否是用户取消或超时
                stderr_output = result.stderr.strip()
                if "用户已取消" in stderr_output or "User canceled" in stderr_output or "(-128)" in stderr_output:
                    print("DEBUG: User cancelled the dialog", file=sys.stderr)
                    return "（对方未回复明确内容）"
                elif "timeout" in stderr_output.lower() or "giving up" in stderr_output.lower():
                    print("DEBUG: Dialog timed out", file=sys.stderr)
                    return "（对方未回复明确内容）"
                else:
                    print(f"DEBUG: AppleScript failed with return code 1, stderr: {stderr_output}", file=sys.stderr)
                    return "（对方未回复明确内容）"
            else:
                print(f"DEBUG: AppleScript failed with return code {result.returncode}", file=sys.stderr)
                if result.stderr:
                    print(f"DEBUG: AppleScript stderr: {result.stderr}", file=sys.stderr)
                return "（对方未回复明确内容）"
                
        except subprocess.TimeoutExpired:
            print("DEBUG: AppleScript subprocess timeout", file=sys.stderr)
            return "（对方未回复明确内容）"
        except Exception as e:
            print(f"DEBUG: macOS dialog error: {e}", file=sys.stderr)
            return "（对方未回复明确内容）"
    
    def _show_windows_dialog(self, prompt: str, options: List[Tuple[str, str]], timeout: int, placeholder: str = "", title: str = "等待用户回复") -> str:
        """Windows 单卡片 WPF；用户内容只通过 UTF-8 JSON stdin 传递。"""
        no_reply = "（对方未回复明确内容）"
        if timeout <= 0:
            return no_reply
        from dialog_theme import read_dialog_theme
        payload = json.dumps({
            "prompt": prompt, "options": options, "timeout": timeout,
            "placeholder": placeholder, "title": title,
            "theme": read_dialog_theme(),
        }, ensure_ascii=False)
        # 使用系统 Windows PowerShell，避免 PATH 中的同名程序；WPF 需要 STA。
        executable = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) /
                         "System32/WindowsPowerShell/v1.0/powershell.exe")
        script = str(Path(__file__).with_name("windows_dialog.ps1"))
        bootstrap = "$ProgressPreference='SilentlyContinue'; & ([scriptblock]::Create([IO.File]::ReadAllText('" + script.replace("'", "''") + "', [Text.Encoding]::UTF8)))"
        encoded = base64.b64encode(bootstrap.encode("utf-16-le")).decode("ascii")
        try:
            result = subprocess.run(
                [executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-STA",
                 "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
                input=payload, capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=timeout + 5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if result.returncode != 0:
                print(f"Windows dialog failed: {result.stderr.strip()}", file=sys.stderr)
                return no_reply
            response = json.loads(result.stdout.strip())
            kind = response.get("kind")
            if kind == "disable":
                return self._get_disable_message()
            if kind == "option":
                text = response.get("text")
                return text if any(text == content for _, content in options) else no_reply
            if kind != "text":
                return no_reply
            output = response.get("text", "").strip()
            if not output:
                return no_reply
            if self._is_disable_command(output):
                return self._get_disable_message()
            if output.isdigit() and 1 <= int(output) <= len(options):
                return options[int(output) - 1][1]
            return output
        except subprocess.TimeoutExpired:
            # run() kills and waits for this direct GUI process; no orphan dialog thread.
            print("Windows reply dialog timed out and was reaped", file=sys.stderr)
            return no_reply
        except Exception as e:
            print(f"Windows dialog error: {e}", file=sys.stderr)
            return no_reply
    
    def _is_disable_command(self, text: str) -> bool:
        """检查是否是禁用命令"""
        disable_commands = ["～", "~", "·", "`", "disable"]
        return text.lower() in disable_commands
    
    def _get_disable_message(self) -> str:
        """返回禁用工具的系统提示词"""
        return """[System Warning] The user has explicitly disabled the WaitingForUrReply tool.

Critical System Constraints:
 1. From now on, you must not use the WaitingForUrReply tool for the remainder of this conversation.
 2. Do not ask the user whether to wait for a reply.
 3. Do not mention or imply the use of this tool.
 4. Continue the conversation directly without pausing for user input.
 5. If user confirmation is needed, ask directly in your reply instead of using the tool.

The user has clearly requested not to be interrupted. Please respect this choice and proceed with the conversation as normal."""


def parse_options(params: Dict) -> List[Tuple[str, str]]:
    """解析选项参数"""
    options = []
    for i in range(1, 10):  # 支持 option01 到 option09
        option_key = f"option{i:02d}"
        if option_key in params:
            content = params[option_key]
            if content and content.strip():
                options.append((str(i), content.strip()))
    return options


def main():
    try:
        # 读取标准输入
        input_data = sys.stdin.read().strip()
        
        # 解析JSON参数
        try:
            params = json.loads(input_data)
        except json.JSONDecodeError:
            # 如果不是JSON，尝试作为简单字符串处理
            params = {"prompt": input_data}
        
        # 提取参数
        prompt = params.get("prompt", "请输入您的回复:")
        timeout = int(params.get("timeout", os.getenv("DEFAULT_TIMEOUT", 1200)))
        placeholder = params.get("placeholder", "")
        title = params.get("title", "等待用户回复")
        
        # 解析选项
        options = parse_options(params)
        
        # 创建输入处理器
        handler = UserInputHandler()
        
        # 显示对话框并获取用户输入
        user_input = handler.show_input_dialog(prompt, options, timeout, placeholder, title)
        
        # 返回结果
        result = {
            "status": "success",
            "result": user_input
        }
        
        print(json.dumps(result, ensure_ascii=False), file=sys.stdout)
        sys.exit(0)
        
    except Exception as e:
        # 错误处理
        error_result = {
            "status": "error",
            "error": f"WaitingForUrReply Plugin Error: {str(e)}"
        }
        print(json.dumps(error_result, ensure_ascii=False), file=sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()