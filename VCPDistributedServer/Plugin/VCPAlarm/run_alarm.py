# -*- coding: utf-8 -*-
# run_alarm.py - The background process for the VCP Alarm Plugin
#
# This script requires third-party libraries. Please install them using pip:
# pip install dateparser pygame Pillow
#
import sys
import os
import time
import datetime
import tkinter as tk
from tkinter import ttk
from PIL import Image, ImageTk, ImageDraw, ImageFilter
import dateparser
import pygame
import math
import textwrap

class AlarmWindow:
    def __init__(self, root, image_path, audio_path, reminder_text=""):
        self.root = root
        self.root.title("VCP Alarm")
        self.reminder_text = (reminder_text or "").strip()
        
        # 设置主题
        self.set_theme()
        
        # Windows 透明色设置
        self.transparent_color = '#010101'  # 使用纯黑色作为透明色
        
        # 窗口设置
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.config(bg=self.transparent_color)
        self.root.attributes("-transparentcolor", self.transparent_color)
        
        # 窗口尺寸：存在提醒事项时适当增高，为正文留出展示空间
        self.window_width = 320
        self.window_height = 560 if self.reminder_text else 480
        
        # 动画变量
        self.angle = 0
        self.scale = 1.0
        self.opacity_step = 0
        
        # 加载图片
        self.load_agent_image(image_path)
        
        # 创建圆角窗口背景
        self.create_rounded_window()
        
        # 创建UI元素
        self.create_ui_elements()
        
        # 居中显示
        self.center_window()
        
        # 播放声音
        self.play_sound(audio_path)
        
        # 启动动画
        self.animate()
        self.update_time()
        self.fade_in()

    def set_theme(self):
        """根据一天中的时间设置颜色主题。"""
        now = datetime.datetime.now()
        is_day = 6 <= now.hour < 18
        
        if is_day:
            # Light Theme
            self.theme = {
                "bg": (240, 240, 240, 255),
                "main_bg_hex": "#f0f0f0",
                "text": "#333333",
                "time_text": "#000000",
                "date_text": "#666666",
                "accent": "#3498db",
                "button_bg": "#3498db",
                "button_hover": "#2980b9",
                "button_text": "#ffffff",
                "gradient_color": (52, 152, 219, 20),
                "shadow": (180, 180, 180, 20),
                "image_border": (52, 152, 219, 100)
            }
        else:
            # Dark Theme
            self.theme = {
                "bg": (45, 45, 58, 255),
                "main_bg_hex": "#2d2d3a",
                "text": "#ffffff",
                "time_text": "#ffffff",
                "date_text": "#9a9aaa",
                "accent": "#8a74f9",
                "button_bg": "#8a74f9",
                "button_hover": "#7860e8",
                "button_text": "#ffffff",
                "gradient_color": (138, 116, 249, 25),
                "shadow": (0, 0, 0, 20),
                "image_border": (138, 116, 249, 100)
            }

    def create_rounded_window(self):
        """创建带圆角和阴影的现代窗口背景 - Windows优化版"""
        # 添加阴影边距
        shadow_size = 15
        total_width = self.window_width + shadow_size * 2
        total_height = self.window_height + shadow_size * 2
        
        # 创建完整的背景图片（包含阴影和圆角）
        background = Image.new('RGB', (total_width, total_height), self.transparent_color)
        
        # 创建阴影层（RGBA用于透明度）
        shadow_layer = Image.new('RGBA', (total_width, total_height), (0, 0, 0, 0))
        shadow_draw = ImageDraw.Draw(shadow_layer)
        
        # 绘制多层阴影
        for i in range(shadow_size):
            alpha = int(self.theme["shadow"][3] * (1 - i / shadow_size))
            offset = shadow_size - i
            shadow_draw.rounded_rectangle(
                [offset, offset, total_width - offset, total_height - offset],
                radius=20,
                fill=(self.theme["shadow"][0], self.theme["shadow"][1], self.theme["shadow"][2], alpha)
            )
        
        # 模糊阴影
        shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(8))
        
        # 创建主窗口背景
        main_bg = Image.new('RGBA', (total_width, total_height), (0, 0, 0, 0))
        main_draw = ImageDraw.Draw(main_bg)
        
        # 绘制圆角矩形主体
        main_draw.rounded_rectangle(
            [shadow_size, shadow_size,
             total_width - shadow_size, total_height - shadow_size],
            radius=20,
            fill=self.theme["bg"]
        )
        
        # 添加顶部渐变效果
        gradient = Image.new('RGBA', (total_width, total_height), (0, 0, 0, 0))
        grad_draw = ImageDraw.Draw(gradient)
        
        gradient_height = 150
        for i in range(gradient_height):
            if i < shadow_size or i > total_height - shadow_size:
                continue
            ratio = i / gradient_height
            alpha = int(self.theme["gradient_color"][3] * (1 - ratio))
            grad_draw.line(
                [(shadow_size, i), (total_width - shadow_size, i)],
                fill=(self.theme["gradient_color"][0], self.theme["gradient_color"][1], self.theme["gradient_color"][2], alpha)
            )
        
        # 合成所有层
        final_bg = Image.new('RGB', (total_width, total_height), self.transparent_color)
        
        # 转换为RGB模式合成
        shadow_rgb = Image.new('RGB', (total_width, total_height), self.transparent_color)
        shadow_rgb.paste(shadow_layer, (0, 0), shadow_layer)
        
        main_rgb = Image.new('RGB', (total_width, total_height), self.transparent_color)
        main_rgb.paste(main_bg, (0, 0), main_bg)
        
        gradient_rgb = Image.new('RGB', (total_width, total_height), self.transparent_color)
        gradient_rgb.paste(gradient, (0, 0), gradient)
        
        # 合成最终图片
        final_bg = Image.blend(final_bg, shadow_rgb, 0.8)
        final_bg = Image.blend(final_bg, main_rgb, 1.0)
        final_bg = Image.blend(final_bg, gradient_rgb, 0.6)
        
        # 创建Canvas显示背景
        self.bg_photo = ImageTk.PhotoImage(final_bg)
        self.canvas = tk.Canvas(
            self.root,
            width=total_width,
            height=total_height,
            bg=self.transparent_color,
            highlightthickness=0
        )
        self.canvas.pack()
        self.canvas.create_image(0, 0, image=self.bg_photo, anchor='nw')
        
        # 主容器Frame
        self.main_frame = tk.Frame(
            self.canvas,
            bg=self.theme["main_bg_hex"],
            highlightthickness=0
        )
        self.canvas.create_window(
            shadow_size,
            shadow_size,
            window=self.main_frame,
            anchor='nw',
            width=self.window_width,
            height=self.window_height
        )
        
        # 绑定Canvas拖动
        self.canvas.bind("<ButtonPress-1>", self.start_move)
        self.canvas.bind("<ButtonRelease-1>", self.stop_move)
        self.canvas.bind("<B1-Motion>", self.do_move)

    def load_agent_image(self, image_path):
        """加载并处理代理图片"""
        try:
            img = Image.open(image_path).convert("RGBA")
            
            # 图片尺寸
            size = 140
            img.thumbnail((size, size), Image.Resampling.LANCZOS)
            
            # 获取实际尺寸
            actual_width, actual_height = img.size
            
            # 创建圆形遮罩
            mask = Image.new('L', (size, size), 0)
            mask_draw = ImageDraw.Draw(mask)
            mask_draw.ellipse([0, 0, size, size], fill=255)
            
            # 创建输出图片
            output = Image.new('RGBA', (size, size), (0, 0, 0, 0))
            # 居中粘贴
            offset_x = (size - actual_width) // 2
            offset_y = (size - actual_height) // 2
            output.paste(img, (offset_x, offset_y))
            output.putalpha(mask)
            
            # 添加发光边框
            border_size = size + 10
            final_img = Image.new('RGBA', (border_size, border_size), (0, 0, 0, 0))
            
            # 绘制外圈发光效果
            border_draw = ImageDraw.Draw(final_img)
            for i in range(3):
                offset = i
                alpha = 100 - i * 30
                border_draw.ellipse(
                    [offset, offset, border_size - offset, border_size - offset],
                    outline=(self.theme["image_border"][0], self.theme["image_border"][1], self.theme["image_border"][2], alpha),
                    width=2
                )
            
            # 粘贴主图片
            final_img.paste(output, (5, 5), output)
            
            self.original_pil_image = final_img
            self.image_size = border_size
            
        except Exception as e:
            print(f"Error loading image: {e}", file=sys.stderr)
            self.original_pil_image = None

    def create_ui_elements(self):
        """创建UI元素"""
        # 顶部装饰条
        top_accent = tk.Frame(self.main_frame, bg=self.theme["accent"], height=3)
        top_accent.pack(fill='x')
        
        # 图片容器
        if self.original_pil_image:
            image_container = tk.Frame(
                self.main_frame,
                bg=self.theme["main_bg_hex"],
                width=180,
                height=180
            )
            image_container.pack(pady=(20, 0))
            image_container.pack_propagate(False)
            
            self.agent_image = ImageTk.PhotoImage(self.original_pil_image)
            self.image_label = tk.Label(
                image_container,
                image=self.agent_image,
                bg=self.theme["main_bg_hex"],
                borderwidth=0
            )
            self.image_label.place(relx=0.5, rely=0.5, anchor='center')
            self.bind_drag_events(self.image_label)
        
        # 时间显示
        self.time_label = tk.Label(
            self.main_frame,
            text=datetime.datetime.now().strftime("%H:%M:%S"),
            font=("Segoe UI Light", 42, "bold"),
            bg=self.theme["main_bg_hex"],
            fg=self.theme["time_text"]
        )
        self.time_label.pack(pady=(15, 5))
        self.bind_drag_events(self.time_label)
        
        # 日期显示
        weekday_cn = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
        weekday = weekday_cn[datetime.datetime.now().weekday()]
        date_text = datetime.datetime.now().strftime(f"%Y年%m月%d日 {weekday}")
        
        date_label = tk.Label(
            self.main_frame,
            text=date_text,
            font=("Microsoft YaHei UI", 11),
            bg=self.theme["main_bg_hex"],
            fg=self.theme["date_text"]
        )
        date_label.pack(pady=(0, 15))
        self.bind_drag_events(date_label)
        
        # 消息标签
        message_label = tk.Label(
            self.main_frame,
            text="⏰ 时间到了！",
            font=("Microsoft YaHei UI", 20, "bold"),
            bg=self.theme["main_bg_hex"],
            fg=self.theme["accent"]
        )
        message_label.pack(pady=(10, 8 if self.reminder_text else 15))
        self.bind_drag_events(message_label)

        if self.reminder_text:
            self.create_reminder_card()

        # 自定义按钮
        self.create_custom_button()
        
        # 绑定主Frame拖动
        self.bind_drag_events(self.main_frame)

    def create_reminder_card(self):
        """创建提醒事项卡片，用于优雅展示可选的预输入文本。"""
        card_width = 260
        card_height = 78
        wrapped_text = textwrap.fill(self.reminder_text, width=18)

        card_container = tk.Frame(
            self.main_frame,
            bg=self.theme["main_bg_hex"],
            width=card_width,
            height=card_height
        )
        card_container.pack(pady=(0, 14))
        card_container.pack_propagate(False)
        self.bind_drag_events(card_container)

        card_canvas = tk.Canvas(
            card_container,
            width=card_width,
            height=card_height,
            bg=self.theme["main_bg_hex"],
            highlightthickness=0
        )
        card_canvas.pack(fill="both", expand=True)
        self.bind_drag_events(card_canvas)

        card_canvas.create_rounded_rectangle(
            1, 1, card_width - 1, card_height - 1,
            radius=18,
            fill=self.theme["main_bg_hex"],
            outline=self.theme["accent"],
            width=1
        )
        card_canvas.create_text(
            18, 16,
            text="提醒事项",
            anchor="nw",
            font=("Microsoft YaHei UI", 9, "bold"),
            fill=self.theme["accent"]
        )
        card_canvas.create_text(
            card_width // 2,
            49,
            text=wrapped_text,
            anchor="center",
            font=("Microsoft YaHei UI", 12),
            fill=self.theme["text"],
            width=card_width - 34,
            justify="center"
        )

    def create_custom_button(self):
        """创建自定义样式按钮"""
        button_container = tk.Frame(self.main_frame, bg=self.theme["main_bg_hex"])
        button_container.pack(pady=(0, 15))
        
        # 创建按钮画布
        btn_width, btn_height = 220, 52
        self.close_button = tk.Canvas(
            button_container,
            width=btn_width,
            height=btn_height,
            bg=self.theme["main_bg_hex"],
            highlightthickness=0
        )
        self.close_button.pack()
        
        # 绘制圆角按钮背景
        self.button_bg = self.close_button.create_rounded_rectangle(
            2, 2, btn_width - 2, btn_height - 2,
            radius=26,
            fill=self.theme["button_bg"],
            outline=''
        )
        
        # 按钮文字
        self.button_text = self.close_button.create_text(
            btn_width // 2, btn_height // 2,
            text="关闭闹钟",
            font=("Microsoft YaHei UI", 15, "bold"),
            fill=self.theme["button_text"]
        )
        
        # 绑定事件
        self.close_button.bind('<Button-1>', lambda e: self.close())
        self.close_button.bind('<Enter>', self.on_button_hover)
        self.close_button.bind('<Leave>', self.on_button_leave)

    def bind_drag_events(self, widget):
        """绑定拖动事件"""
        widget.bind("<ButtonPress-1>", self.start_move)
        widget.bind("<ButtonRelease-1>", self.stop_move)
        widget.bind("<B1-Motion>", self.do_move)

    def start_move(self, event):
        self.x = event.x
        self.y = event.y

    def stop_move(self, event):
        self.x = None
        self.y = None

    def do_move(self, event):
        deltax = event.x - self.x
        deltay = event.y - self.y
        x = self.root.winfo_x() + deltax
        y = self.root.winfo_y() + deltay
        self.root.geometry(f"+{x}+{y}")

    def on_button_hover(self, event):
        """按钮悬停效果"""
        self.close_button.itemconfig(self.button_bg, fill=self.theme["button_hover"])
        self.root.config(cursor="hand2")

    def on_button_leave(self, event):
        """按钮离开效果"""
        self.close_button.itemconfig(self.button_bg, fill=self.theme["button_bg"])
        self.root.config(cursor="")

    def animate(self):
        """呼吸动画效果"""
        if not self.original_pil_image:
            self.root.after(30, self.animate)
            return
            
        # 平滑呼吸效果
        self.scale = 1.0 + 0.06 * math.sin(self.angle)
        self.angle += 0.06
        
        if self.angle > 2 * math.pi:
            self.angle = 0

        try:
            new_size = int(self.image_size * self.scale)
            resized_image = self.original_pil_image.resize(
                (new_size, new_size),
                Image.Resampling.LANCZOS
            )
            self.agent_image = ImageTk.PhotoImage(resized_image)
            self.image_label.config(image=self.agent_image)
        except:
            pass

        self.root.after(30, self.animate)

    def update_time(self):
        """更新时间显示"""
        current_time = datetime.datetime.now().strftime("%H:%M:%S")
        self.time_label.config(text=current_time)
        self.root.after(1000, self.update_time)

    def fade_in(self):
        """淡入动画"""
        if self.opacity_step < 20:
            self.opacity_step += 1
            try:
                self.root.attributes('-alpha', self.opacity_step / 20)
            except:
                pass
            self.root.after(15, self.fade_in)

    def play_sound(self, audio_path):
        """播放声音"""
        try:
            pygame.mixer.init()
            pygame.mixer.music.load(audio_path)
            pygame.mixer.music.play(loops=-1)
        except Exception as e:
            print(f"Error playing sound: {e}", file=sys.stderr)

    def close(self):
        """关闭窗口"""
        try:
            pygame.mixer.music.stop()
            pygame.mixer.quit()
        except:
            pass
        self.root.destroy()

    def center_window(self):
        """窗口居中"""
        self.root.update_idletasks()
        
        # 获取实际窗口大小（包含阴影）
        total_width = self.canvas.winfo_reqwidth()
        total_height = self.canvas.winfo_reqheight()
        
        # 计算居中位置
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        x = (screen_width - total_width) // 2
        y = (screen_height - total_height) // 2
        
        # 设置窗口位置和大小
        self.root.geometry(f'{total_width}x{total_height}+{x}+{y}')
        self.root.attributes('-alpha', 0)  # 初始透明

# 为 Canvas 添加圆角矩形绘制方法
def create_rounded_rectangle(self, x1, y1, x2, y2, radius=25, **kwargs):
    """绘制平滑的圆角矩形"""
    points = []
    steps = 30  # 增加步数使圆角更平滑
    
    # 右上角
    for i in range(steps + 1):
        angle = math.pi / 2 * i / steps
        points.extend([
            x2 - radius + radius * math.sin(angle),
            y1 + radius - radius * math.cos(angle)
        ])
    
    # 右下角
    for i in range(steps + 1):
        angle = math.pi / 2 * i / steps
        points.extend([
            x2 - radius + radius * math.cos(angle),
            y2 - radius + radius * math.sin(angle)
        ])
    
    # 左下角
    for i in range(steps + 1):
        angle = math.pi / 2 * i / steps
        points.extend([
            x1 + radius - radius * math.sin(angle),
            y2 - radius + radius * math.cos(angle)
        ])
    
    # 左上角
    for i in range(steps + 1):
        angle = math.pi / 2 * i / steps
        points.extend([
            x1 + radius - radius * math.cos(angle),
            y1 + radius - radius * math.sin(angle)
        ])
    
    return self.create_polygon(points, **kwargs, smooth=True)

# 添加方法到Canvas类
tk.Canvas.create_rounded_rectangle = create_rounded_rectangle

def main(time_description, audio_path, image_path, reminder_text=""):
    target_dt = dateparser.parse(time_description, settings={'PREFER_DATES_FROM': 'future'})

    if not target_dt:
        print(f"Error: Could not understand the time description: '{time_description}'", file=sys.stderr)
        return

    now = datetime.datetime.now()
    wait_seconds = (target_dt - now).total_seconds()

    if wait_seconds < 0:
        print(f"Warning: Parsed time '{target_dt}' is in the past. Alarm will not be set.", file=sys.stderr)
        return
        
    time.sleep(wait_seconds)

    root = tk.Tk()
    app = AlarmWindow(root, image_path, audio_path, reminder_text)
    root.mainloop()

if __name__ == "__main__":
    if len(sys.argv) not in (4, 5):
        print(f"Usage: {sys.argv[0]} <time_description> <audio_path> <image_path> [reminder_text]", file=sys.stderr)
        sys.exit(1)

    _, time_desc, audio, image, *optional_args = sys.argv
    reminder = optional_args[0] if optional_args else ""
    main(time_desc, audio, image, reminder)