#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import sys
import subprocess
import threading
import time
from typing import List, Optional, Tuple


class LinuxDialogHandler:
    """Linux 平台对话框处理器，支持 X11、Wayland 和 TTY 环境"""
    
    # Wayland 原生启动器工具（按优先级排序）
    WAYLAND_LAUNCHERS = [
        'wofi',      # Wayland 通用，支持 layer-shell
        'fuzzel',    # Wayland 友好，快速
        'tofi',      # 极简，快速
        'bemenu',    # 跨平台，支持 Wayland
        'wmenu',     # Wayland 专用菜单
        'rofi',      # 如果编译了 Wayland 支持 (rofi-wayland)
    ]
    
    # X11 专用工具
    X11_TOOLS = [
        'zenity',    # GTK3/GTK4，GNOME 项目
        'kdialog',   # KDE/Qt
        'yad',       # Yet Another Dialog，zenity 增强版
        'qarma',     # zenity 的 Qt 克隆
        'matedialog', # MATE 桌面
        'xmessage',  # X11 基础工具
    ]
    
    # 终端 TUI 工具
    TUI_TOOLS = [
        'fzf',       # 模糊查找器
        'gum',       # Charm 出品的精美 TUI
        'dialog',    # 传统 ncurses 对话框
        'whiptail',  # dialog 的轻量替代
    ]
    
    def __init__(self):
        self.display_type = self._detect_display_server()
        self.desktop_env = self._detect_desktop_environment()
        
    def _detect_display_server(self) -> str:
        """
        检测显示服务器类型
        
        Returns:
            'wayland', 'x11', 'tty', 或 'unknown'
        """
        wayland_display = os.environ.get('WAYLAND_DISPLAY')
        xdg_session_type = os.environ.get('XDG_SESSION_TYPE', '').lower()
        display = os.environ.get('DISPLAY')
        
        # 优先检查 Wayland
        if wayland_display or xdg_session_type == 'wayland':
            return 'wayland'
        
        # 然后检查 X11
        if display or xdg_session_type == 'x11':
            return 'x11'
        
        # TTY 会话
        if xdg_session_type == 'tty' or not (wayland_display or display):
            # 进一步检查是否在 TTY
            try:
                tty = os.ttyname(sys.stdin.fileno())
                if tty.startswith('/dev/tty'):
                    return 'tty'
            except:
                pass
        
        return 'unknown'
    
    def _detect_desktop_environment(self) -> str:
        """检测桌面环境"""
        desktop = os.environ.get('XDG_CURRENT_DESKTOP', '').lower()
        return desktop
    
    def _command_exists(self, command: str) -> bool:
        """检查命令是否存在"""
        try:
            subprocess.run(['which', command], capture_output=True, check=True)
            return True
        except:
            return False
    
    def _is_disable_command(self, text: str) -> bool:
        """检查是否是禁用命令"""
        disable_commands = ["～", "~", "·", "`", "disable"]
        return text.lower() in [c.lower() for c in disable_commands]
    
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
    
    def _build_prompt_text(self, prompt: str, options: List[Tuple[str, str]], 
                          show_hints: bool = True) -> str:
        """构建提示文本"""
        options_text = ""
        if options:
            options_text = "\n\n可选项（按数字键快速选择）:\n"
            for i, (key, content) in enumerate(options, 1):
                options_text += f"{i}. {content}\n"
        
        if show_hints:
            hints = "\n\n[ESC]可取消回复｜输入[~]可禁用本工具"
            return f"{prompt}{options_text}{hints}"
        
        return f"{prompt}{options_text}"
    
    def _process_output(self, output: str, options: List[Tuple[str, str]]) -> str:
        """处理用户输出，检查禁用命令和数字选择"""
        output = output.strip()
        
        if not output:
            return "（对方未回复明确内容）"
        
        # 检查禁用命令
        if self._is_disable_command(output):
            print(f"DEBUG: Disable command detected: {output}", file=sys.stderr)
            return self._get_disable_message()
        
        # 检查数字选择
        if output.isdigit():
            idx = int(output) - 1
            if 0 <= idx < len(options):
                return options[idx][1]
        
        return output
    
    def show_dialog(self, prompt: str, options: List[Tuple[str, str]], 
                   timeout: int = 1200, placeholder: str = "", 
                   title: str = "等待用户回复") -> str:
        """
        主入口：根据显示服务器类型路由到对应实现
        """
        print(f"DEBUG: Linux display type: {self.display_type}, desktop: {self.desktop_env}", 
              file=sys.stderr)
        
        if self.display_type == 'wayland':
            return self._show_wayland_dialog(prompt, options, timeout, placeholder, title)
        elif self.display_type == 'x11':
            return self._show_x11_dialog(prompt, options, timeout, placeholder, title)
        elif self.display_type == 'tty':
            return self._show_tty_dialog(prompt, options, timeout)
        else:
            # 未知环境，尝试所有可用工具
            return self._show_fallback_dialog(prompt, options, timeout, placeholder, title)
    
    # ==================== Wayland 实现 ====================
    
    def _show_wayland_dialog(self, prompt: str, options: List[Tuple[str, str]], 
                            timeout: int, placeholder: str, title: str) -> str:
        """Wayland 环境：优先使用原生 layer-shell 工具"""
        
        # 1. 尝试 Wayland 原生启动器（dmenu 模式）
        for tool in self.WAYLAND_LAUNCHERS:
            if self._command_exists(tool):
                print(f"DEBUG: Using Wayland launcher: {tool}", file=sys.stderr)
                result = self._use_wayland_launcher(tool, prompt, options, timeout)
                if result:
                    return result
        
        # 2. 尝试 vicinea（如果可用）
        if self._command_exists('vicinea'):
            print("DEBUG: Using vicinea", file=sys.stderr)
            return self._use_vicinea(prompt, options, timeout)
        
        # 3. 尝试 XWayland 兼容的 GUI 工具（如果 XWayland 可用）
        if os.environ.get('DISPLAY'):
            for tool in ['zenity', 'kdialog']:
                if self._command_exists(tool):
                    print(f"DEBUG: Falling back to XWayland tool: {tool}", file=sys.stderr)
                    if tool == 'zenity':
                        return self._use_zenity(prompt, options, timeout, title)
                    else:
                        return self._use_kdialog(prompt, options, timeout, title)
        
        # 4. 尝试 TUI 工具（如果在终端中）
        if self._is_in_terminal():
            for tool in self.TUI_TOOLS:
                if self._command_exists(tool):
                    print(f"DEBUG: Falling back to TUI tool: {tool}", file=sys.stderr)
                    return self._use_tui_tool(tool, prompt, options, timeout)
        
        # 5. 最终回退到基础终端输入
        print("DEBUG: Falling back to basic terminal input", file=sys.stderr)
        return self._use_terminal_input(prompt, options, timeout)
    
    def _use_wayland_launcher(self, tool: str, prompt: str, 
                             options: List[Tuple[str, str]], timeout: int) -> Optional[str]:
        """
        使用 Wayland 原生启动器（wofi, fuzzel, tofi, bemenu, wmenu, rofi）
        """
        try:
            # 构建选项列表
            options_input = "\n".join([f"{i}. {content}" 
                                      for i, (key, content) in enumerate(options, 1)])
            
            # 根据工具构建命令
            cmd_map = {
                'wofi': ['wofi', '--dmenu', '--prompt', prompt, '--insensitive'],
                'fuzzel': ['fuzzel', '--dmenu', '--prompt', f"{prompt}: "],
                'tofi': ['tofi', '--dmenu', '--prompt-text', f"{prompt}: "],
                'bemenu': ['bemenu', '-p', prompt, '-i'],  # -i 大小写不敏感
                'wmenu': ['wmenu', '-p', prompt],
                'rofi': ['rofi', '-dmenu', '-p', prompt, '-i'],
            }
            
            base_cmd = cmd_map.get(tool, [tool, '--dmenu'])
            
            # 添加超时支持（如果工具支持）
            if tool == 'wofi' and timeout > 0:
                base_cmd.extend(['--timeout', str(timeout * 1000)])  # wofi 使用毫秒
            
            # 使用线程实现超时控制
            result_container = {"value": None, "completed": False}
            
            def run_launcher():
                try:
                    result = subprocess.run(
                        base_cmd,
                        input=options_input,
                        capture_output=True,
                        text=True,
                        timeout=timeout + 5
                    )
                    if result.returncode == 0:
                        result_container["value"] = result.stdout
                    else:
                        result_container["value"] = ""
                except subprocess.TimeoutExpired:
                    result_container["value"] = ""
                except Exception as e:
                    print(f"DEBUG: {tool} error: {e}", file=sys.stderr)
                    result_container["value"] = None  # 标记为失败，尝试下一个工具
                finally:
                    result_container["completed"] = True
            
            thread = threading.Thread(target=run_launcher)
            thread.daemon = True
            thread.start()
            
            # 等待结果或超时
            start_time = time.time()
            while not result_container["completed"] and (time.time() - start_time) < timeout:
                time.sleep(0.1)
            
            if not result_container["completed"]:
                return "（对方未回复明确内容）"
            
            output = result_container["value"]
            if output is None:
                return None  # 工具执行失败，让上层尝试其他工具
            
            return self._process_output(output, options)
            
        except Exception as e:
            print(f"DEBUG: Wayland launcher {tool} failed: {e}", file=sys.stderr)
            return None
    
    def _use_vicinea(self, prompt: str, options: List[Tuple[str, str]], 
                    timeout: int) -> Optional[str]:
        """
        使用 vicinea - 专为 Wayland 设计的通知/交互工具
        """
        try:
            # vicinea 支持通过通知交互
            # 首先发送带选项的通知
            options_text = " | ".join([f"{i}:{content[:20]}" 
                                      for i, (key, content) in enumerate(options, 1)])
            
            # 使用 vicinea 的菜单模式
            cmd = ['vicinea', '--menu', prompt]
            if options:
                cmd.extend(['--options', options_text])
            
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout
            )
            
            if result.returncode == 0:
                return self._process_output(result.stdout, options)
            else:
                return "（对方未回复明确内容）"
                
        except Exception as e:
            print(f"DEBUG: vicinea error: {e}", file=sys.stderr)
            return None
    
    # ==================== X11 实现 ====================
    
    def _show_x11_dialog(self, prompt: str, options: List[Tuple[str, str]], 
                        timeout: int, placeholder: str, title: str) -> str:
        """X11 环境：使用传统 GUI 工具"""
        
        # 1. 尝试 zenity (GNOME/GTK)
        if self._command_exists('zenity'):
            return self._use_zenity(prompt, options, timeout, title)
        
        # 2. 尝试 kdialog (KDE/Qt)
        if self._command_exists('kdialog'):
            return self._use_kdialog(prompt, options, timeout, title)
        
        # 3. 尝试 yad
        if self._command_exists('yad'):
            return self._use_yad(prompt, options, timeout, title)
        
        # 4. 回退到 TUI 或终端
        if self._is_in_terminal():
            return self._use_tui_tool('dialog', prompt, options, timeout) \
                   or self._use_terminal_input(prompt, options, timeout)
        
        return self._use_terminal_input(prompt, options, timeout)
    
    def _use_zenity(self, prompt: str, options: List[Tuple[str, str]], 
                   timeout: int, title: str) -> str:
        """使用 zenity 显示对话框"""
        try:
            full_prompt = self._build_prompt_text(prompt, options)
            
            # 首先显示选择对话框
            choice_result = subprocess.run([
                'zenity', '--question',
                f'--title={title}',
                f'--text={full_prompt}\n\n点击"是"输入回复，"否"取消回复',
                '--ok-label=输入回复',
                '--cancel-label=取消',
                '--extra-button=禁用工具',
                '--timeout=' + str(timeout)
            ], capture_output=True, text=True, timeout=timeout + 5)
            
            # 检查用户选择
            if choice_result.returncode == 1:  # 禁用工具按钮
                print("DEBUG: User clicked disable button (zenity)", file=sys.stderr)
                return self._get_disable_message()
            elif choice_result.returncode != 0:
                return "（对方未回复明确内容）"
            
            # 显示输入框
            result = subprocess.run([
                'zenity', '--entry',
                f'--title={title}',
                f'--text=请输入您的回复:',
                '--timeout=' + str(timeout)
            ], capture_output=True, text=True, timeout=timeout + 5)
            
            if result.returncode == 0:
                return self._process_output(result.stdout, options)
            else:
                return "（对方未回复明确内容）"
                
        except Exception as e:
            print(f"DEBUG: zenity error: {e}", file=sys.stderr)
            return "（对方未回复明确内容）"
    
    def _use_kdialog(self, prompt: str, options: List[Tuple[str, str]], 
                    timeout: int, title: str) -> str:
        """使用 kdialog 显示对话框"""
        try:
            full_prompt = self._build_prompt_text(prompt, options)
            
            # 使用线程实现超时
            result_container = {"value": None, "completed": False}
            
            def run_kdialog():
                try:
                    # 首先显示选择对话框
                    choice_result = subprocess.run([
                        'kdialog', '--yesnocancel',
                        f'{full_prompt}\n\n点击"是"输入回复，"否"取消回复，"取消"禁用工具',
                        '--title', title,
                        '--yes-label', '输入回复',
                        '--no-label', '取消',
                        '--cancel-label', '禁用工具'
                    ], capture_output=True, text=True)
                    
                    if choice_result.returncode == 2:  # 禁用工具
                        result_container["value"] = self._get_disable_message()
                    elif choice_result.returncode != 0:
                        result_container["value"] = "（对方未回复明确内容）"
                    else:
                        # 显示输入框
                        input_result = subprocess.run([
                            'kdialog', '--inputbox', '请输入您的回复:',
                            '--title', title
                        ], capture_output=True, text=True)
                        
                        if input_result.returncode == 0:
                            result_container["value"] = self._process_output(
                                input_result.stdout, options
                            )
                        else:
                            result_container["value"] = "（对方未回复明确内容）"
                except Exception as e:
                    print(f"DEBUG: kdialog thread error: {e}", file=sys.stderr)
                    result_container["value"] = "（对方未回复明确内容）"
                finally:
                    result_container["completed"] = True
            
            thread = threading.Thread(target=run_kdialog)
            thread.daemon = True
            thread.start()
            
            # 等待超时
            start_time = time.time()
            while not result_container["completed"] and (time.time() - start_time) < timeout:
                time.sleep(0.1)
            
            if not result_container["completed"]:
                return "（对方未回复明确内容）"
            
            return result_container["value"]
            
        except Exception as e:
            print(f"DEBUG: kdialog error: {e}", file=sys.stderr)
            return "（对方未回复明确内容）"
    
    def _use_yad(self, prompt: str, options: List[Tuple[str, str]], 
                timeout: int, title: str) -> str:
        """使用 yad (Yet Another Dialog)"""
        try:
            full_prompt = self._build_prompt_text(prompt, options)
            
            result = subprocess.run([
                'yad', '--entry',
                '--title=' + title,
                '--text=' + full_prompt,
                '--timeout=' + str(timeout),
                '--timeout-indicator=top'
            ], capture_output=True, text=True, timeout=timeout + 5)
            
            if result.returncode == 0:
                return self._process_output(result.stdout, options)
            else:
                return "（对方未回复明确内容）"
                
        except Exception as e:
            print(f"DEBUG: yad error: {e}", file=sys.stderr)
            return "（对方未回复明确内容）"
    
    # ==================== TTY/终端 实现 ====================
    
    def _show_tty_dialog(self, prompt: str, options: List[Tuple[str, str]], 
                        timeout: int) -> str:
        """TTY 环境：使用 TUI 工具或基础输入"""
        
        # 尝试 TUI 工具
        for tool in self.TUI_TOOLS:
            if self._command_exists(tool):
                result = self._use_tui_tool(tool, prompt, options, timeout)
                if result:
                    return result
        
        # 基础终端输入
        return self._use_terminal_input(prompt, options, timeout)
    
    def _use_tui_tool(self, tool: str, prompt: str, 
                     options: List[Tuple[str, str]], timeout: int) -> Optional[str]:
        """使用 TUI 工具（fzf, gum, dialog, whiptail）"""
        try:
            if tool == 'fzf':
                return self._use_fzf(prompt, options, timeout)
            elif tool == 'gum':
                return self._use_gum(prompt, options, timeout)
            elif tool == 'dialog':
                return self._use_dialog(prompt, options, timeout)
            elif tool == 'whiptail':
                return self._use_whiptail(prompt, options, timeout)
        except Exception as e:
            print(f"DEBUG: TUI tool {tool} error: {e}", file=sys.stderr)
            return None
    
    def _use_fzf(self, prompt: str, options: List[Tuple[str, str]], 
                timeout: int) -> Optional[str]:
        """使用 fzf 模糊查找器"""
        try:
            options_input = "\n".join([f"{i}. {content}" 
                                      for i, (key, content) in enumerate(options, 1)])
            
            cmd = ['fzf', '--prompt', f"{prompt}: ", '--header', '按数字或选择条目']
            
            result = subprocess.run(
                cmd,
                input=options_input,
                capture_output=True,
                text=True,
                timeout=timeout
            )
            
            if result.returncode == 0:
                output = result.stdout.strip()
                # 提取数字或内容
                if output and '. ' in output:
                    num = output.split('.')[0]
                    if num.isdigit():
                        idx = int(num) - 1
                        if 0 <= idx < len(options):
                            return options[idx][1]
                return self._process_output(output, options)
            else:
                return "（对方未回复明确内容）"
                
        except Exception as e:
            print(f"DEBUG: fzf error: {e}", file=sys.stderr)
            return None
    
    def _use_gum(self, prompt: str, options: List[Tuple[str, str]], 
                timeout: int) -> Optional[str]:
        """使用 gum (Charm 出品的 TUI 工具)"""
        try:
            if not options:
                # 输入模式
                result = subprocess.run(
                    ['gum', 'input', '--placeholder', prompt],
                    capture_output=True,
                    text=True,
                    timeout=timeout
                )
            else:
                # 选择模式
                options_input = "\n".join([content for _, content in options])
                result = subprocess.run(
                    ['gum', 'choose', '--header', prompt],
                    input=options_input,
                    capture_output=True,
                    text=True,
                    timeout=timeout
                )
            
            if result.returncode == 0:
                return self._process_output(result.stdout, options)
            else:
                return "（对方未回复明确内容）"
                
        except Exception as e:
            print(f"DEBUG: gum error: {e}", file=sys.stderr)
            return None
    
    def _use_dialog(self, prompt: str, options: List[Tuple[str, str]], 
                   timeout: int) -> Optional[str]:
        """使用 dialog (ncurses)"""
        try:
            if options:
                # 菜单模式
                menu_items = []
                for i, (key, content) in enumerate(options, 1):
                    menu_items.extend([str(i), content])
                
                result = subprocess.run([
                    'dialog', '--stdout', '--timeout', str(timeout),
                    '--menu', prompt, '20', '60', str(len(options))
                ] + menu_items, capture_output=True, text=True)
            else:
                # 输入框模式
                result = subprocess.run([
                    'dialog', '--stdout', '--timeout', str(timeout),
                    '--inputbox', prompt, '10', '60'
                ], capture_output=True, text=True)
            
            if result.returncode == 0:
                return self._process_output(result.stdout, options)
            else:
                return "（对方未回复明确内容）"
                
        except Exception as e:
            print(f"DEBUG: dialog error: {e}", file=sys.stderr)
            return None
    
    def _use_whiptail(self, prompt: str, options: List[Tuple[str, str]], 
                     timeout: int) -> Optional[str]:
        """使用 whiptail (dialog 的轻量替代)"""
        try:
            if options:
                menu_items = []
                for i, (key, content) in enumerate(options, 1):
                    menu_items.extend([str(i), content])
                
                result = subprocess.run([
                    'whiptail', '--title', '等待用户回复',
                    '--menu', prompt, '20', '60', str(len(options))
                ] + menu_items, capture_output=True, text=True)
            else:
                result = subprocess.run([
                    'whiptail', '--title', '等待用户回复',
                    '--inputbox', prompt, '10', '60'
                ], capture_output=True, text=True)
            
            if result.returncode == 0:
                return self._process_output(result.stdout, options)
            else:
                return "（对方未回复明确内容）"
                
        except Exception as e:
            print(f"DEBUG: whiptail error: {e}", file=sys.stderr)
            return None
    
    def _use_terminal_input(self, prompt: str, options: List[Tuple[str, str]], 
                           timeout: int) -> str:
        """基础终端输入（最终回退）"""
        try:
            full_prompt = self._build_prompt_text(prompt, options, show_hints=True)
            print(f"\n{full_prompt}", file=sys.stderr)
            print("请在终端中输入回复:", file=sys.stderr)
            
            # 使用线程实现超时输入
            result_container = {"value": None, "completed": False}
            
            def get_input():
                try:
                    result_container["value"] = input().strip()
                except EOFError:
                    result_container["value"] = ""
                except KeyboardInterrupt:
                    result_container["value"] = ""
                finally:
                    result_container["completed"] = True
            
            thread = threading.Thread(target=get_input)
            thread.daemon = True
            thread.start()
            
            # 等待输入或超时
            start_time = time.time()
            while not result_container["completed"] and (time.time() - start_time) < timeout:
                time.sleep(0.1)
            
            if not result_container["completed"]:
                return "（对方未回复明确内容）"
            
            output = result_container["value"]
            return self._process_output(output if output else "", options)
            
        except Exception as e:
            print(f"DEBUG: Terminal input error: {e}", file=sys.stderr)
            return "（对方未回复明确内容）"
    
    # ==================== 通用工具 ====================
    
    def _is_in_terminal(self) -> bool:
        """检查是否在交互式终端中"""
        return sys.stdin.isatty() and sys.stdout.isatty()
    
    def _show_fallback_dialog(self, prompt: str, options: List[Tuple[str, str]], 
                             timeout: int, placeholder: str, title: str) -> str:
        """未知环境：尝试所有可能的工具"""
        
        # 尝试所有 GUI 工具
        all_gui_tools = self.WAYLAND_LAUNCHERS + self.X11_TOOLS
        for tool in all_gui_tools:
            if self._command_exists(tool):
                if tool in ['wofi', 'fuzzel', 'tofi', 'bemenu', 'wmenu', 'rofi']:
                    result = self._use_wayland_launcher(tool, prompt, options, timeout)
                elif tool == 'zenity':
                    result = self._use_zenity(prompt, options, timeout, title)
                elif tool == 'kdialog':
                    result = self._use_kdialog(prompt, options, timeout, title)
                elif tool == 'yad':
                    result = self._use_yad(prompt, options, timeout, title)
                else:
                    continue
                
                if result:
                    return result
        
        # 尝试 TUI 工具
        for tool in self.TUI_TOOLS:
            if self._command_exists(tool):
                result = self._use_tui_tool(tool, prompt, options, timeout)
                if result:
                    return result
        
        # 最终回退
        return self._use_terminal_input(prompt, options, timeout)