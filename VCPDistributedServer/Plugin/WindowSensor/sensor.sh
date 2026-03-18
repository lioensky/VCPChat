#!/bin/bash
# VCP Linux Window Sensor - Bash + jq 极速版
# 依赖: jq, wmctrl (X11/Xwayland) 或 hyprctl (Hyprland)

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"CONFIG_FILE="$DIR/plugin-config.json"
--- 1. 默认配置 ---
NODE_NAME="LinuxNode"
正则格式的忽略/优先列表
IGNORE_APPS="polybar|rofi|waybar|krunner|plasmashell|systemsettings|desktop_window"PRIORITY_APPS="chrome|firefox|msedge|code|devenv|qq|wechat|vcpchat|electron|kitty|alacritty|gnome-terminal|konsole"
尝试读取配置
if [ -f "$CONFIG_FILE" ] && command -v jq &> /dev/null; then    parsed_node=$(jq -r '.NodeName // empty' "$CONFIG_FILE")    [ -n "$parsed_node" ] && NODE_NAME="$parsed_node"
parsed_ignore=$(jq -r '.IgnoreApps | join("|") // empty' "$CONFIG_FILE" 2>/dev/null)
[ -n "$parsed_ignore" ] && IGNORE_APPS="$parsed_ignore"

fi
--- 2. 获取窗口数据 (格式: PID|PROC_NAME|WID|TITLE) ---
WINDOWS=""
路由 A: 尝试 Hyprland (Wayland)
if [ -n "$HYPRLAND_INSTANCE_SIGNATURE" ] || command -v hyprctl &> /dev/null; then    WINDOWS=$(hyprctl clients -j 2>/dev/null | jq -r '.[] | select(.hidden==false and .mapped==true) | "(.pid)|(.class)|(.address)|(.title)"')fi
路由 B: 尝试 wmctrl (X11 / Xwayland)
if [ -z "$WINDOWS" ] && command -v wmctrl &> /dev/null; then    # wmctrl -lp 输出: WID Desktop PID Machine Title    while read -r wid desktop pid machine title; do        if [ "$desktop" != "-1" ] && [ "$pid" != "0" ]; then            proc_name=$(cat "/proc/$pid/comm" 2>/dev/null || echo "Unknown")            WINDOWS+="$pid|$proc_name|$wid|$title"$'\n'        fi    done <<< "$(wmctrl -lp 2>/dev/null)"fi
--- 3. 数据分类与处理 ---
HIGH_PRIORITY=""OTHER_APPS=""HIGH_COUNT=0OTHER_COUNT=0SUMMARY_APPS=""
逐行解析窗口
while IFS='|' read -r pid proc_name wid title; do    [ -z "$pid" ] && continue
# 过滤 IgnoreApps (忽略大小写)
if echo "$proc_name" | grep -qiE "$IGNORE_APPS"; then
    continue
fi

info="[$pid] $proc_name : $title (ID: $wid)"

# 匹配优先级
if echo "$proc_name" | grep -qiE "$PRIORITY_APPS"; then
    HIGH_PRIORITY+="$info"$'\n'
    HIGH_COUNT=$((HIGH_COUNT + 1))
    SUMMARY_APPS+="$proc_name"$'\n'
else
    OTHER_APPS+="$info"$'\n'
    OTHER_COUNT=$((OTHER_COUNT + 1))
fi

done <<< "$WINDOWS"
--- 4. 构建文本层 ---
DETAILED="【节点 ${NODE_NAME} 窗口深度感知数据】"$'\n'"--- 核心交互进程 ---"if [ $HIGH_COUNT -gt 0 ]; then    DETAILED+=$'\n'"$(echo "$HIGH_PRIORITY" | sed '/^$/d')"else    DETAILED+=$'\n'"(无)"fi
DETAILED+=$'\n'"--- 其他活跃窗口 ---"if [ $OTHER_COUNT -gt 0 ]; then    DETAILED+=$'\n'"$(echo "$OTHER_APPS" | sed '/^$/d' | head -n 15)"    if [ $OTHER_COUNT -gt 15 ]; then        DETAILED+=$'\n'"... (及其它 $((OTHER_COUNT - 15)) 个窗口)"    fielse    DETAILED+=$'\n'"(无)"fi
SUMMARY="【节点 ${NODE_NAME} 窗口简报】"if [ $HIGH_COUNT -gt 0 ]; then    unique_apps=$(echo "$SUMMARY_APPS" | sed '/^$/d' | sort -u | tr '\n' ',' | sed 's/,$//')    SUMMARY+=$'\n'"活跃应用: $unique_apps"else    SUMMARY+=$'\n'"活跃应用: (无明显核心交互应用)"fi
SLEEP_TEXT="[节点 ${NODE_NAME} 窗口感知雷达已就绪，当前语境无需展开]"
--- 5. jq 安全封包输出 (完全免疫转义问题) ---
jq -n -c   --arg name "WindowSense_$NODE_NAME"   --arg desc "获取当前电脑正在运行的有窗口进程列表，用于了解用户正在看什么软件，比如浏览器、游戏或代码编辑器等。检测窗口、进程名、标题、应用。"   --arg detailed "$DETAILED"   --arg summary "$SUMMARY"   --arg sleep "$SLEEP_TEXT" '{  "vcp_dynamic_fold": true,  "fold_name": $name,  "plugin_description": $desc,  "fold_blocks": [    { "threshold": 0.7, "content": $detailed },    { "threshold": 0.4, "content": $summary },    { "threshold": 0.0, "content": $sleep }  ]}'