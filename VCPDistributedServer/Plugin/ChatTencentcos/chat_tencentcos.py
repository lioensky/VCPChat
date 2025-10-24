# -*- coding=utf-8
import sys
import json
import os
import zipfile
import tempfile
from pathlib import Path
from dotenv import load_dotenv
from qcloud_cos import CosConfig
from qcloud_cos import CosS3Client
from qcloud_cos.cos_exception import CosClientError, CosServiceError

# --- 配置和常量 ---
PLUGIN_NAME = "ChatTencentcos"

# --- 结果输出 ---
def print_json_output(status, result=None, error=None, ai_message=None):
    output = {"status": status}
    if status == "success":
        if result is not None:
            output["result"] = result
        if ai_message:
            output["messageForAI"] = ai_message
    elif status == "error":
        if error is not None:
            output["error"] = error
    print(json.dumps(output, ensure_ascii=False))

# --- 权限管理类 ---
class FolderPermission:
    def __init__(self, folder_name, upload, list_files, download, delete, copy_move):
        self.folder_name = folder_name
        self.upload = upload.lower() == "true"
        self.list_files = list_files.lower() == "true"
        self.download = download.lower() == "true"
        self.delete = delete.lower() == "true"
        self.copy_move = copy_move.lower() == "true"
    
    def get_permission_description(self):
        desc = f"文件夹 '{self.folder_name}' 权限：\n"
        desc += f"- 上传权限：{'允许' if self.upload else '禁止'}\n"
        desc += f"- 列出权限：{'允许' if self.list_files else '禁止'}\n"
        desc += f"- 下载权限：{'允许' if self.download else '禁止'}\n"
        desc += f"- 删除权限：{'允许' if self.delete else '禁止'}\n"
        desc += f"- 复制和移动权限：{'允许' if self.copy_move else '禁止'}"
        return desc

class PermissionManager:
    def __init__(self, folders_config_str):
        self.permissions = {}
        self._parse_folders_config(folders_config_str)
    
    def _parse_folders_config(self, config_str):
        """解析文件夹配置字符串"""
        try:
            folders = config_str.split(',')
            for folder in folders:
                parts = folder.strip().split(':')
                if len(parts) == 6:
                    folder_name, upload, list_files, download, delete, copy_move = parts
                    self.permissions[folder_name] = FolderPermission(
                        folder_name, upload, list_files, download, delete, copy_move
                    )
        except Exception as e:
            pass  # 静默处理错误，因为不需要日志
    
    def get_permission(self, folder_name):
        """获取指定文件夹的权限"""
        return self.permissions.get(folder_name)
    
    
    def check_permission(self, folder_name, action):
        """检查指定文件夹的特定操作权限"""
        permission = self.get_permission(folder_name)
        if not permission:
            return False, f"文件夹 '{folder_name}' 未在配置中定义"
        
        action_map = {
            'upload': permission.upload,
            'list': permission.list_files,
            'download': permission.download,
            'delete': permission.delete,
            'copy_move': permission.copy_move
        }
        
        if action not in action_map:
            return False, f"未知操作: {action}"
        
        if action_map[action]:
            return True, "权限允许"
        else:
            return False, f"文件夹 '{folder_name}' 不允许执行 '{action}' 操作"

# --- COS客户端管理 ---
class COSClientManager:
    def __init__(self):
        self.client = None
        self.bucket_name = None
        self.region = None
        self.agent_parent_dir = None
        self.permission_manager = None
        self.compress_threshold_mb = 100
        self._initialize_client()
    
    def _initialize_client(self):
        """初始化COS客户端"""
        try:
            # 从环境变量读取配置
            secret_id = os.environ.get('TENCENTCLOUD_SECRET_ID')
            secret_key = os.environ.get('TENCENTCLOUD_SECRET_KEY')
            self.bucket_name = os.environ.get('COS_BUCKET_NAME')
            self.region = os.environ.get('COS_REGION')
            self.agent_parent_dir = os.environ.get('AGENT_PARENT_DIR', 'VCPAgentAI')
            folders_config = os.environ.get('AGENT_FOLDERS_CONFIG', '')
            self.compress_threshold_mb = int(os.environ.get('COMPRESS_THRESHOLD_MB', '100'))
            
            if not secret_id or not secret_key:
                raise ValueError("TENCENTCLOUD_SECRET_ID 或 TENCENTCLOUD_SECRET_KEY 未配置")
            
            if not self.bucket_name or not self.region:
                raise ValueError("COS_BUCKET_NAME 或 COS_REGION 未配置")
            
            # 初始化COS配置
            config = CosConfig(
                Region=self.region,
                SecretId=secret_id,
                SecretKey=secret_key,
                Scheme='https'
            )
            
            # 创建COS客户端
            self.client = CosS3Client(config)
            
            # 初始化权限管理器
            self.permission_manager = PermissionManager(folders_config)
            
        except Exception as e:
            raise

# --- 文件压缩工具 ---
def compress_to_zip(file_path_or_dir, output_zip_path):
    """将文件或目录压缩为zip"""
    try:
        with zipfile.ZipFile(output_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            path_obj = Path(file_path_or_dir)
            
            if path_obj.is_file():
                # 压缩单个文件
                zipf.write(file_path_or_dir, path_obj.name)
            elif path_obj.is_dir():
                # 压缩目录
                for file_path in path_obj.rglob('*'):
                    if file_path.is_file():
                        arcname = file_path.relative_to(path_obj.parent)
                        zipf.write(file_path, arcname)
            else:
                raise ValueError(f"路径不存在: {file_path_or_dir}")
        
        return True
        
    except Exception as e:
        return False

def get_file_size_mb(file_path):
    """获取文件大小（MB）"""
    try:
        size_bytes = os.path.getsize(file_path)
        return size_bytes / (1024 * 1024)
    except Exception:
        return 0

# --- 文件操作功能 ---
class FileOperations:
    def __init__(self, cos_manager):
        self.cos_manager = cos_manager
    
    def upload_file(self, local_path, cos_folder, remote_filename=None):
        """上传文件到COS"""
        try:
            # 检查权限
            allowed, message = self.cos_manager.permission_manager.check_permission(cos_folder, 'upload')
            if not allowed:
                return {"success": False, "error": message}
            
            # 检查本地文件是否存在
            if not os.path.exists(local_path):
                return {"success": False, "error": f"本地文件不存在: {local_path}"}
            
            # 确定远程文件名
            if not remote_filename:
                remote_filename = os.path.basename(local_path)
            
            # 构建COS键
            cos_key = f"{self.cos_manager.agent_parent_dir}/{cos_folder}/{remote_filename}"
            
            # 检查文件大小，决定是否压缩
            file_size_mb = get_file_size_mb(local_path)
            should_compress = file_size_mb > self.cos_manager.compress_threshold_mb or os.path.isdir(local_path)
            
            if should_compress:
                # 创建临时zip文件
                with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as temp_zip:
                    temp_zip_path = temp_zip.name
                
                if compress_to_zip(local_path, temp_zip_path):
                    # 上传压缩文件
                    cos_key = f"{self.cos_manager.agent_parent_dir}/{cos_folder}/{remote_filename}.zip"
                    response = self.cos_manager.client.upload_file(
                        Bucket=self.cos_manager.bucket_name,
                        Key=cos_key,
                        LocalFilePath=temp_zip_path,
                        EnableMD5=True
                    )
                    # 清理临时文件
                    os.unlink(temp_zip_path)
                    
                    return {
                        "success": True,
                        "cos_key": cos_key,
                        "original_size_mb": file_size_mb,
                        "compressed": True,
                        "message": f"文件已压缩并上传到: {cos_key}"
                    }
                else:
                    # 压缩失败，尝试直接上传
                    os.unlink(temp_zip_path)
            
            # 直接上传文件
            response = self.cos_manager.client.upload_file(
                Bucket=self.cos_manager.bucket_name,
                Key=cos_key,
                LocalFilePath=local_path,
                EnableMD5=True
            )
            
            return {
                "success": True,
                "cos_key": cos_key,
                "size_mb": file_size_mb,
                "compressed": False,
                "message": f"文件已上传到: {cos_key}"
            }
            
        except CosClientError as e:
            return {"success": False, "error": f"COS客户端错误: {e}"}
        except CosServiceError as e:
            return {"success": False, "error": f"COS服务错误: {e}"}
        except Exception as e:
            return {"success": False, "error": f"上传失败: {e}"}
    
    def download_file(self, cos_key, local_path=None):
        """从COS下载文件"""
        try:
            # 解析COS键获取文件夹信息
            key_parts = cos_key.split('/')
            if len(key_parts) < 3 or key_parts[0] != self.cos_manager.agent_parent_dir:
                return {"success": False, "error": f"无效的COS键格式: {cos_key}"}
            
            cos_folder = key_parts[1]
            
            # 检查权限
            allowed, message = self.cos_manager.permission_manager.check_permission(cos_folder, 'download')
            if not allowed:
                return {"success": False, "error": message}
            
            # 确定本地保存路径
            if not local_path:
                # 使用下载目录
                download_dir = os.path.join(os.path.dirname(__file__), 'download')
                os.makedirs(download_dir, exist_ok=True)
                filename = key_parts[-1]
                local_path = os.path.join(download_dir, filename)
            
            # 确保本地目录存在
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            
            # 下载文件
            response = self.cos_manager.client.download_file(
                Bucket=self.cos_manager.bucket_name,
                Key=cos_key,
                DestFilePath=local_path
            )
            
            file_size_mb = get_file_size_mb(local_path)
            
            return {
                "success": True,
                "cos_key": cos_key,
                "local_path": local_path,
                "size_mb": file_size_mb,
                "message": f"文件已下载到: {local_path}"
            }
            
        except CosClientError as e:
            return {"success": False, "error": f"COS客户端错误: {e}"}
        except CosServiceError as e:
            return {"success": False, "error": f"COS服务错误: {e}"}
        except Exception as e:
            return {"success": False, "error": f"下载失败: {e}"}

# --- 主逻辑 ---
def main():
    # 加载环境变量
    dotenv_path = os.path.join(os.path.dirname(__file__), 'config.env')
    load_dotenv(dotenv_path=dotenv_path)
    
    try:
        # 初始化COS客户端管理器
        cos_manager = COSClientManager()
        
        # 初始化文件操作
        file_ops = FileOperations(cos_manager)
        
        # 读取输入
        try:
            input_str = sys.stdin.read()
            input_data = json.loads(input_str)
        except json.JSONDecodeError:
            print_json_output("error", error="无效的JSON输入")
            sys.exit(1)
        
        command = input_data.get("command")
        
        if command == "upload_file":
            local_path = input_data.get("local_path")
            cos_folder = input_data.get("cos_folder")
            remote_filename = input_data.get("remote_filename")
            
            if not local_path or not cos_folder:
                print_json_output("error", error="缺少必需参数: local_path, cos_folder")
                sys.exit(1)
            
            result = file_ops.upload_file(local_path, cos_folder, remote_filename)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        elif command == "download_file":
            cos_key = input_data.get("cos_key")
            local_path = input_data.get("local_path")
            
            if not cos_key:
                print_json_output("error", error="缺少必需参数: cos_key")
                sys.exit(1)
            
            result = file_ops.download_file(cos_key, local_path)
            if result["success"]:
                print_json_output("success", result=result)
            else:
                print_json_output("error", error=result["error"])
                sys.exit(1)
        
        else:
            print_json_output("error", error=f"命令 '{command}' 暂未实现")
            sys.exit(1)
    
    except Exception as e:
        print_json_output("error", error=f"发生意外错误: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()