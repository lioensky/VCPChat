import sys
import json
import re
import subprocess

# --- 配置 ---
DEVICE_NAME = "米家台灯Pro"

# 参数名 -> mijiaAPI 属性名（顺序即执行顺序：先开关，再亮度、色温）
PROP_MAP = [
    ("power", "on"),
    ("brightness", "brightness"),
    ("color_temperature", "color-temperature"),
]
POWER_TRUE = {"true", "1", "on", "yes", "开", "打开", "开启"}
POWER_FALSE = {"false", "0", "off", "no", "关", "关闭", "关掉"}
INT_RANGES = {
    "brightness": (1, 100),
    "color_temperature": (2500, 4800),
}
INT_RE = re.compile(r"^\s*(\d{1,5})\s*(?:%|k|K)?\s*$")


# --- 参数规范化 ---

def normalize_power(value):
    """兼容 True/False、true/false、on/off 等写法，统一为 mijiaAPI 需要的 True/False。"""
    text = str(value).strip().lower()
    if text in POWER_TRUE:
        return "True"
    if text in POWER_FALSE:
        return "False"
    raise ValueError(f"power 取值无效: '{value}'，应为 True 或 False。")


def normalize_int(key, value):
    """只接受纯整数（允许 % 或 K 后缀），并校验范围。"""
    match = INT_RE.match(str(value))
    if not match:
        raise ValueError(f"{key} 必须是整数，收到: '{value}'。")
    number = int(match.group(1))
    low, high = INT_RANGES[key]
    if not low <= number <= high:
        raise ValueError(f"{key} 超出范围 {low}~{high}，收到: {number}。")
    return str(number)


def build_control_plan(args):
    """把控制参数转换为 [(属性名, 值)]；任何参数非法时抛出 ValueError，不执行任何设置。"""
    plan = []
    for arg_key, prop_name in PROP_MAP:
        if arg_key not in args or args[arg_key] in (None, ""):
            continue
        value = args[arg_key]
        if arg_key == "power":
            plan.append((prop_name, normalize_power(value)))
        else:
            plan.append((prop_name, normalize_int(arg_key, value)))
    if not plan:
        raise ValueError("未提供任何有效的控制参数（power, brightness, color_temperature）。")
    return plan


# --- 执行 ---

def run_mijia(cli_args):
    """以参数数组方式调用 mijiaAPI，不经过 shell，参数值不会被解释为命令。"""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "mijiaAPI", *cli_args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=True,
        )
        return {"success": True, "output": result.stdout.strip()}
    except subprocess.CalledProcessError as e:
        return {
            "success": False,
            "output": f"退出码: {e.returncode}\n输出: {e.stdout}\n错误: {e.stderr}",
        }
    except Exception as e:
        return {"success": False, "output": f"执行命令时发生未知错误: {str(e)}"}


def send_response(status, result):
    """将最终结果以JSON格式打印到标准输出"""
    print(json.dumps({"status": status, "result": result}, ensure_ascii=False))
    sys.exit(0)


# --- 命令处理函数 ---

def handle_get_status():
    properties_to_get = {
        "on": "开关状态",
        "brightness": "亮度",
        "color-temperature": "色温",
    }
    results = []
    for prop, desc_zh in properties_to_get.items():
        res = run_mijia(["get", "--dev_name", DEVICE_NAME, "--prop_name", prop])
        if not res["success"]:
            send_response("error", f"获取属性 '{prop}' 失败: {res['output']}")
            return
        # mijiaAPI 的输出格式为 "设备名 的 属性名 值为 值"
        value = res["output"].split("值为")[-1].strip()
        results.append(f"{desc_zh}为 {value}")
    send_response("success", f"台灯当前状态：{'，'.join(results)}。")


def handle_lamp_control(args):
    try:
        plan = build_control_plan(args)
    except ValueError as e:
        send_response("error", str(e))
        return

    results_summary = []
    for prop_name, value in plan:
        res = run_mijia(["set", "--dev_name", DEVICE_NAME, "--prop_name", prop_name, "--value", value])
        if res["success"]:
            results_summary.append(res["output"])
        else:
            results_summary.append(f"设置 {prop_name}={value} 失败: {res['output']}")
    send_response("success", "批处理执行完成：\n" + "\n".join(results_summary))


# --- 主逻辑 ---

def main():
    try:
        request_str = sys.stdin.read().strip()
        if not request_str:
            send_response("error", "未从 stdin 接收到任何输入。")
            return

        request_data = json.loads(request_str)
        command = request_data.get("command")

        if command == "GetLampStatus":
            handle_get_status()
        elif command == "LampControl":
            params = {k: v for k, v in request_data.items() if k != "command"}
            handle_lamp_control(params)
        else:
            send_response("error", f"未知的 command: '{command}'")

    except json.JSONDecodeError:
        send_response("error", "无法解析来自 stdin 的 JSON 输入。")
    except Exception as e:
        send_response("error", f"插件执行时发生意外错误: {str(e)}")


if __name__ == "__main__":
    main()