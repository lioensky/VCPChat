import sys
import json
import os
import requests
import hashlib
import time
import threading
from datetime import datetime
import traceback
from urllib.parse import urlparse
from urllib.request import url2pathname
from dotenv import load_dotenv

# --- 自定义异常 ---
class LocalFileNotFoundError(Exception):
    def __init__(self, message, file_url, failed_parameter=None):
        super().__init__(message)
        self.file_url = file_url
        self.failed_parameter = failed_parameter

# --- 配置和常量 ---
LOG_FILE = "VTAnalyzer.log"
VT_API_BASE = "https://www.virustotal.com/api/v3"
PLUGIN_NAME = "VirusTotalAnalyzer"

# --- 日志记录 ---
def log_event(level, message, data=None):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    log_entry = f"[{timestamp}] [{level.upper()}] {message}"
    if data:
        try:
            log_entry += f" | Data: {json.dumps(data, ensure_ascii=False)}"
        except Exception:
            log_entry += f" | Data: [Unserializable Data]"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(log_entry + "\n")
    except Exception as e:
        print(f"Error writing to log file: {e}", file=sys.stderr)

# --- 结果输出 ---
def print_json_output(status, result=None, error=None, code=None, file_url=None, failed_parameter=None):
    output = {"status": status}
    if status == "success":
        if result is not None:
            output["result"] = result
    elif status == "error":
        if error is not None:
            output["error"] = error
        if code:
            output["code"] = code
        if file_url:
            output["fileUrl"] = file_url
        if failed_parameter:
            output["failedParameter"] = failed_parameter
    print(json.dumps(output, ensure_ascii=False))
    log_event("debug", "Output sent to stdout", output)

# --- 文件处理 ---
def get_file_hash(file_path):
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()

def resolve_file_path(image_url, param_name=None):
    parsed_url = urlparse(image_url)
    if parsed_url.scheme == 'file':
        file_path = url2pathname(parsed_url.path)
        if os.name == 'nt' and parsed_url.path.startswith('/'):
            file_path = url2pathname(parsed_url.path[1:])
        
        if not os.path.exists(file_path):
            log_event("error", f"Local file not found: {file_path}")
            raise LocalFileNotFoundError("本地文件未找到，需要远程获取。", image_url, param_name)
        return file_path
    elif not parsed_url.scheme: # 假设是普通路径
        if not os.path.exists(image_url):
             raise FileNotFoundError(f"文件不存在: {image_url}")
        return image_url
    else:
        raise ValueError(f"不支持的协议: {parsed_url.scheme}")

# --- VirusTotal API 调用 ---
def get_vt_report(api_key, file_hash):
    url = f"{VT_API_BASE}/files/{file_hash}"
    headers = {"x-apikey": api_key}
    response = requests.get(url, headers=headers, timeout=30)
    if response.status_code == 200:
        return response.json()
    elif response.status_code == 404:
        return None
    else:
        response.raise_for_status()

def upload_file_to_vt(api_key, file_path):
    file_size = os.path.getsize(file_path)
    headers = {"x-apikey": api_key}
    
    if file_size <= 32 * 1024 * 1024: # 32MB
        url = f"{VT_API_BASE}/files"
        with open(file_path, "rb") as f:
            files = {"file": (os.path.basename(file_path), f)}
            response = requests.post(url, headers=headers, files=files, timeout=60)
    else:
        # 大文件处理
        get_url_endpoint = f"{VT_API_BASE}/files/upload_url"
        res_url = requests.get(get_url_endpoint, headers=headers, timeout=30)
        res_url.raise_for_status()
        upload_url = res_url.json()["data"]
        with open(file_path, "rb") as f:
            files = {"file": (os.path.basename(file_path), f)}
            response = requests.post(upload_url, headers=headers, files=files, timeout=300)
            
    response.raise_for_status()
    return response.json()["data"]["id"] # 返回 analysis_id

def get_analysis_result(api_key, analysis_id):
    url = f"{VT_API_BASE}/analyses/{analysis_id}"
    headers = {"x-apikey": api_key}
    response = requests.get(url, headers=headers, timeout=30)
    response.raise_for_status()
    return response.json()

# --- 异步处理逻辑 ---
def process_single_file(api_key, file_path, force_upload, request_id, callback_base_url):
    try:
        log_event("info", f"[{request_id}] Starting analysis for {file_path}")
        file_hash = get_file_hash(file_path)
        report = None
        
        if not force_upload:
            log_event("info", f"[{request_id}] Checking existing report for hash: {file_hash}")
            report = get_vt_report(api_key, file_hash)
            
        if not report:
            log_event("info", f"[{request_id}] No existing report or force upload. Uploading file...")
            analysis_id = upload_file_to_vt(api_key, file_path)
            log_event("info", f"[{request_id}] File uploaded. Analysis ID: {analysis_id}. Polling for results...")
            
            # 轮询结果
            max_retries = 20
            retry_interval = 15
            for i in range(max_retries):
                time.sleep(retry_interval)
                analysis_data = get_analysis_result(api_key, analysis_id)
                status = analysis_data["data"]["attributes"]["status"]
                if status == "completed":
                    log_event("info", f"[{request_id}] Analysis completed.")
                    # 获取最终报告
                    report = get_vt_report(api_key, file_hash)
                    break
                log_event("info", f"[{request_id}] Analysis status: {status}. Retrying {i+1}/{max_retries}")
            else:
                raise TimeoutError("VirusTotal 分析超时。")

        # 格式化结果
        stats = report["data"]["attributes"]["last_analysis_stats"]
        malicious = stats.get("malicious", 0)
        suspicious = stats.get("suspicious", 0)
        total = sum(stats.values())
        
        result_summary = f"分析完成。恶意: {malicious}, 可疑: {suspicious}, 总计引擎: {total}。\n"
        result_summary = format_report_summary(report, file_hash)

        # 回调
        if callback_base_url:
            callback_url = f"{callback_base_url}/{PLUGIN_NAME}/{request_id}"
            callback_payload = {
                "requestId": request_id,
                "status": "Succeed",
                "result": result_summary,
                "data": report
            }
            requests.post(callback_url, json=callback_payload, timeout=30)
            log_event("success", f"[{request_id}] Callback successful.")

    except Exception as e:
        log_event("error", f"[{request_id}] Error in background processing: {str(e)}", {"traceback": traceback.format_exc()})
        if callback_base_url:
            callback_url = f"{callback_base_url}/{PLUGIN_NAME}/{request_id}"
            callback_payload = {
                "requestId": request_id,
                "status": "Failed",
                "error": str(e)
            }
            requests.post(callback_url, json=callback_payload, timeout=30)

def format_report_summary(report, file_hash):
    stats = report["data"]["attributes"]["last_analysis_stats"]
    malicious = stats.get("malicious", 0)
    suspicious = stats.get("suspicious", 0)
    total = sum(stats.values())
    
    result_summary = f"分析完成。恶意: {malicious}, 可疑: {suspicious}, 总计引擎: {total}。\n"
    if malicious > 0:
        result_summary += "⚠️ 警告：发现恶意软件！\n"
    elif suspicious > 0:
        result_summary += "💡 提示：发现可疑行为。\n"
    else:
        result_summary += "✅ 安全：未发现威胁。\n"
        
    result_summary += f"完整报告: https://www.virustotal.com/gui/file/{file_hash}"
    return result_summary

# --- 主函数 ---
def main():
    dotenv_path = os.path.join(os.path.dirname(__file__), 'config.env')
    load_dotenv(dotenv_path=dotenv_path)
    
    api_key = os.getenv("VT_API_KEY")
    callback_base_url = os.getenv("CALLBACK_BASE_URL")
    
    if not api_key:
        print_json_output("error", error="VT_API_KEY not found.")
        sys.exit(1)

    try:
        input_data = json.loads(sys.stdin.read())
    except Exception as e:
        print_json_output("error", error=f"Invalid input: {e}")
        sys.exit(1)

    # 处理批量请求
    commands_to_process = []
    i = 1
    while True:
        cmd_key = f"command{i}" if i > 1 else "command"
        if i == 1 and "command" not in input_data and "command1" in input_data:
             cmd_key = "command1"
             
        if cmd_key not in input_data:
            if i == 1: # 兼容没有数字后缀的情况
                pass
            else:
                break
        
        suffix = str(i) if (i > 1 or cmd_key == "command1") else ""
        cmd = input_data.get(cmd_key)
        file_path_raw = input_data.get(f"filePath{suffix}") or input_data.get("filePath")
        force_upload = input_data.get(f"forceUpload{suffix}", False)
        
        if cmd == "AnalyzeFile" and file_path_raw:
            commands_to_process.append({
                "type": "analyze",
                "filePath": file_path_raw,
                "forceUpload": force_upload,
                "paramName": f"filePath{suffix}" if suffix else "filePath"
            })
        elif cmd == "GetReport" and file_path_raw:
            commands_to_process.append({
                "type": "query",
                "filePath": file_path_raw,
                "paramName": f"filePath{suffix}" if suffix else "filePath"
            })
        
        i += 1
        if i > 20: break # 防止死循环

    if not commands_to_process:
        print_json_output("error", error="No valid AnalyzeFile commands found.")
        sys.exit(1)

    results_for_ai = []
    for item in commands_to_process:
        try:
            file_path = resolve_file_path(item["filePath"], item["paramName"])
            
            if item["type"] == "analyze":
                request_id = f"VT_{int(time.time())}_{hashlib.md5(file_path.encode()).hexdigest()[:6]}"
                # 启动后台线程
                thread = threading.Thread(target=process_single_file, args=(
                    api_key, file_path, item["forceUpload"], request_id, callback_base_url
                ))
                thread.start()
                results_for_ai.append(f"文件 '{os.path.basename(file_path)}' 的分析任务已提交 (ID: {request_id})。\n请在回复中包含占位符：{{{{VCP_ASYNC_RESULT::VirusTotalAnalyzer::{request_id}}}}}")
            else: # query
                file_hash = get_file_hash(file_path)
                report = get_vt_report(api_key, file_hash)
                if report:
                    results_for_ai.append(f"文件 '{os.path.basename(file_path)}' 的查询结果：\n{format_report_summary(report, file_hash)}")
                else:
                    results_for_ai.append(f"文件 '{os.path.basename(file_path)}' 在 VirusTotal 上没有记录。请使用 AnalyzeFile 指令上传分析。")
                    
        except LocalFileNotFoundError as e:
            print_json_output("error", code="FILE_NOT_FOUND_LOCALLY", error=str(e), file_url=e.file_url, failed_parameter=e.failed_parameter)
            sys.exit(0)
        except Exception as e:
            results_for_ai.append(f"提交文件 '{item['filePath']}' 失败: {str(e)}")

    print_json_output("success", result="\n\n".join(results_for_ai))

if __name__ == "__main__":
    main()