import os
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from tools.my_infer import get_multi_ref_template, create_speaker_list, single_infer, multi_infer, pre_infer, get_classic_model_list, classic_infer, get_version, check_installed, install_model, delete_model, openai_like_infer
from fastapi import FastAPI, File, UploadFile, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
import argparse
import uvicorn
from pathlib import Path
import webbrowser
import signal
import mimetypes

#===========================启动服务===========================
origin = ["*"] # 允许所有来源的请求
mimetypes.add_type('application/javascript', '.js')

APP = FastAPI()
APP.add_middleware(
    CORSMiddleware,
    allow_origins=origin,  # 允许的来源
    allow_credentials=True,
    allow_methods=["*"],  # 允许的请求方法
    allow_headers=["*"],  # 允许的请求头
)

#OpenAI推理接口其它参数
class otherParams(BaseModel):
    app_key: str = ""
    text_lang: str = "中英混合"
    prompt_lang: str = "中文"
    emotion: str = "默认"
    top_k: int = 10
    top_p: float = 1.0
    temperature: float = 1.0
    text_split_method: str = "按标点符号切"
    batch_size: int = 1
    batch_threshold: float = 0.75
    split_bucket: bool = True
    fragment_interval: float = 0.3
    parallel_infer: bool = True
    repetition_penalty: float = 1.35
    sample_steps: int = 16
    if_sr: bool = False
    seed: int = -1

#OpenAI风格的推理接口
class openaiLikeInfer(BaseModel):
    model: str = ""
    input: str = ""
    voice: str = ""
    response_format: str = "mp3"
    speed: float = 1.0
    other_params: otherParams = otherParams()

# 定义请求参数模型
class requestVersion(BaseModel):
    version: str
    
class shutdown(BaseModel):
    password: str
    
class inferWithEmotions(BaseModel):
    app_key: str = ""
    dl_url: str = ""
    version: str = "v4"
    model_name: str = ""
    prompt_text_lang: str = ""
    emotion: str = ""
    text: str = ""
    text_lang: str = ""
    top_k: int = 10
    top_p: float = 1.0
    temperature: float = 1.0
    text_split_method: str = "按标点符号切"
    batch_size: int = 1
    batch_threshold: float = 0.75
    split_bucket: bool = True
    speed_facter: float = 1.0
    fragment_interval: float = 0.3
    media_type: str = "wav"
    parallel_infer: bool = True
    repetition_penalty: float = 1.35
    seed: int = -1
    sample_steps: int = 16
    if_sr : bool = False
    
class inferWithMulti(BaseModel):
    app_key: str = ""
    dl_url: str = ""
    content : str = ""
    top_k: int = 10
    top_p: float = 1.0
    temperature: float = 1.0
    text_split_method: str = "按标点符号切"
    batch_size: int = 1
    batch_threshold: float = 0.75
    split_bucket: bool = True
    fragment_interval: float = 0.3
    media_type: str = "wav"
    parallel_infer: bool = True
    repetition_penalty: float = 1.35
    seed: int = -1
    sample_steps: int = 16
    if_sr : bool = False
    
    
class inferWithClassic(BaseModel):
    app_key: str = ""
    dl_url: str = ""
    version: str = "v4"
    gpt_model_name: str = ""
    sovits_model_name: str = ""
    ref_audio_path: str = ""
    prompt_text: str = ""
    prompt_text_lang: str = ""
    text: str = ""
    text_lang: str = ""
    top_k: int = 10
    top_p: float = 1.0
    temperature: float = 1.0
    text_split_method: str = "按标点符号切"
    batch_size: int = 1
    batch_threshold: float = 0.75
    split_bucket: bool = True
    speed_facter: float = 1.0
    fragment_interval: float = 0.3
    media_type: str = "wav"
    parallel_infer: bool = True
    repetition_penalty: float = 1.35
    seed: int = -1
    sample_steps: int = 16
    if_sr : bool = False
    
class checkModelInstalled(BaseModel):
    version: str = "v4"
    category: str = ""
    language: str = ""
    model_name: str = ""
    
class installModel(BaseModel):
    version: str = "v4"
    category: str = ""
    language: str = ""
    model_name: str = ""
    dl_url: str = ""
    
    
# 初始化
@APP.get("/api")
async def root():
    return {"message": "This is a TTS inference API. If you see this page, it means the server is running."}

# 获取支持的版本号
@APP.get("/version")
async def version():
    versions = get_version()
    return {"msg": "获取版本号成功", "support_versions": versions}

# 获取多人对话模板
@APP.post("/template")
async def template(model: requestVersion):
    template_list, msg = get_multi_ref_template(model.version)
    return {"msg": msg, "template_list": template_list}

@APP.get("/template/{version}")
async def template_get(version: str):
    template_list, msg = get_multi_ref_template(version)
    return {"msg": msg, "template_list": template_list}

# 获取说话人列表
@APP.post("/models")
async def speaker_list(model: requestVersion):
    model_list, msg = create_speaker_list(model.version)
    return {"msg": msg, "models": model_list}

@APP.get("/models/{version}")
async def speaker_list_get(version: str):
    model_list, msg = create_speaker_list(version)
    return {"msg": msg, "models": model_list}

# 根据情感进行推理
@APP.post("/infer_single")
async def infer_emotion(model: inferWithEmotions):
    try:
        if model.app_key != infer_key and infer_key != "":
            msg = "app_key错误"
            audio_url = ""
        else:
            audio_path, msg = single_infer(model.model_name, model.prompt_text_lang, model.emotion, model.text, model.text_lang, model.top_k, model.top_p, model.temperature, model.text_split_method, model.batch_size, model.batch_threshold, model.split_bucket, model.speed_facter, model.fragment_interval, model.media_type, model.parallel_infer, model.repetition_penalty, model.seed, model.sample_steps, model.if_sr, model.version)
            if audio_path == "":
                audio_url = ""
            else:
                if model.dl_url == "":
                    audio_url = f"http://{host}:{port}/{audio_path}"
                else:
                    audio_url = f"{model.dl_url}/{audio_path}"
    except Exception as e:
        print(e)
        msg = "参数错误"
        audio_url = ""
    return {"msg": msg, "audio_url": audio_url}

# 根据多人对话模板进行推理
@APP.post("/infer_multi")
async def infer_multi(model: inferWithMulti):
    try:
        if model.app_key != infer_key and infer_key != "":
            msg = "app_key错误"
            archive_url = ""
        else:
            archive_path, msg = multi_infer(model.content, model.top_k, model.top_p, model.temperature, model.text_split_method, model.batch_size, model.batch_threshold, model.split_bucket, model.fragment_interval, model.media_type, model.parallel_infer, model.repetition_penalty, model.seed, model.sample_steps, model.if_sr)  
            if model.dl_url == "":
                archive_url = f"http://{host}:{port}/{archive_path}"
            else:
                archive_url = f"{model.dl_url}/{archive_path}"
    except Exception as e:
        print(e)
        msg = "参数错误"
        archive_url = ""
    return {"msg": msg, "archive_url": archive_url}

# 获取经典模型列表
@APP.post("/classic_model_list")
async def classic_model_list(model: requestVersion):
    try:
        gpt, sovits, msg, _, _ = get_classic_model_list(model.version)
    except Exception as e:
        msg = "获取模型列表失败"
        gpt = []
        sovits = []
        print(e)
    return {"msg": msg, "gpt": gpt, "sovits": sovits}

@APP.get("/classic_model_list/{version}")
async def classic_model_list_get(version: str):
    try:
        gpt, sovits, msg, _, _ = get_classic_model_list(version)
    except Exception as e:
        msg = "获取模型列表失败"
        gpt = []
        sovits = []
        print(e)
    return {"msg": msg, "gpt": gpt, "sovits": sovits}

@APP.get("/check_model/{version}")
async def check_model_list(version: str):
    try:
        model_root = Path(f"models/{version}")
        installed = []
        if model_root.exists():
            for item in sorted(model_root.iterdir(), key=lambda path: path.name):
                if not item.is_dir():
                    continue

                model_name = item.name
                if "_" in model_name:
                    category, language = model_name.rsplit("_", 1)
                elif "-" in model_name:
                    category, language = model_name.rsplit("-", 1)
                else:
                    category, language = model_name, ""

                installed.append(f"{category}-{language}-{model_name}" if language else model_name)
    except Exception as e:
        print(e)
        installed = []
    return {"installed": installed}

# 经典模式推理
@APP.post("/infer_classic")
async def infer_classic(model: inferWithClassic):
    try:
        if model.app_key != infer_key and infer_key != "":
            msg = "app_key错误"
            audio_url = ""
        else:
            audio_path, msg = classic_infer(model.gpt_model_name, model.sovits_model_name, model.ref_audio_path, model.prompt_text, model.prompt_text_lang, model.text, model.text_lang, model.top_k, model.top_p, model.temperature, model.text_split_method, model.batch_size, model.batch_threshold, model.split_bucket, model.speed_facter, model.fragment_interval, model.seed, model.media_type, model.parallel_infer, model.repetition_penalty, model.sample_steps, model.if_sr, model.version)
            if audio_path == "":
                audio_url = ""
            else:
                if model.dl_url == "":
                    audio_url = f"http://{host}:{port}/{audio_path}"
                else:
                    audio_url = f"{model.dl_url}/{audio_path}"
    except Exception as e:
        print(e)
        msg = "参数错误"
        audio_url = ""
    return {"msg": msg, "audio_url": audio_url}
    
# OpenAI风格的推理接口
@APP.post("/v1/audio/speech")
async def openai_compatible_infer(model: openaiLikeInfer):
    try:
        if model.other_params.app_key != infer_key and infer_key != "":
            return {
                "error": {
                    "message": "app_key错误",
                    "type": "authentication_error",
                    "param": "app_key",
                    "code": "invalid_app_key"
                }
            }
        else:
            audio_byte, msg = openai_like_infer(model.model, model.input, model.voice, model.response_format, model.speed, model.other_params)
            if audio_byte is None:
                return {
                    "error": {
                        "message": msg,
                        "type": "processing_error",
                        "param": "unknown",
                        "code": "processing_failed"
                    }
                }
            else:
                media_type_map = {
                    "mp3": "audio/mpeg",
                    "wav": "audio/wav",
                    "aac": "audio/aac",
                    "ogg": "audio/ogg",
                    "raw": "application/octet-stream"
                }
                response_media_type = media_type_map.get(model.response_format, "audio/wav")
                return Response(content=audio_byte, media_type=response_media_type)

    except Exception as e:
        print(e)
        return {
            "error": {
                "message": "参数错误",
                "type": "parameter_error",
                "param": "unknown",
                "code": "invalid_parameters"
            }
        }

# 检查模型是否安装
@APP.post("/check_model")
async def check_model(model: checkModelInstalled):
    try:
        installed = check_installed(model.version, model.category, model.language, model.model_name)
    except Exception as e:
        print(e)
        installed = False
    return {"installed": installed}

# 安装模型
@APP.post("/install_model")
async def install_model_func(model: installModel):
    try:
        msg = install_model(model.version, model.category, model.language, model.model_name, model.dl_url)
    except Exception as e:
        print(e)
        msg = "安装失败"
    return {"msg": msg}

# 删除模型
@APP.post("/delete_model")
async def delete_model_func(model: checkModelInstalled):
    try:
        msg = delete_model(model.version, model.category, model.language, model.model_name)
    except Exception as e:
        print(e)
        msg = "删除失败"
    return {"msg": msg}

# 关闭服务
@APP.post("/shutdown")
async def shutdown(model: shutdown):
    shutdown_password = "wYdjEHnnjrNAahFsQ0yVmv1TEeUU9Z8A"  # 设置关闭密码
    if model.password == shutdown_password:
        os.kill(os.getpid(), signal.SIGINT)
        print("服务已关闭")
    else:
        return {"msg": "密码错误"}

# 下载生成结果
APP.mount("/outputs", StaticFiles(directory="outputs"), name="outputs")
@APP.get("/outputs/{result_path}")
async def download(result_path: str):
    return FileResponse(f"outputs/{result_path}")

# 上传参考音频到指定目录
@APP.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    #使用pathlib保存文件
    file_path = ""
    try:
        Path(ref_audio_path).mkdir(parents=True, exist_ok=True)
        Path(f"{ref_audio_path}/{file.filename}").write_bytes(file.file.read())
        file_path = f"{ref_audio_path}/{file.filename}"
        msg = "上传成功"
    except Exception as e:
        print(e)
        msg = "上传失败"
    return {"msg": msg, "file_path": str(file_path)}

# 挂载Vue编写的推理WebUI
APP.mount("/", StaticFiles(directory="gsvi_ui"), name="gsvi_ui")
@APP.middleware("http")
async def redirect_to_index(request: Request, call_next):
    response = await call_next(request)
    if response.status_code == 404 and not request.url.path.startswith("/api"):
        return FileResponse("gsvi_ui/index.html")
    return response

if __name__ == "__main__":
    #===========================启动参数===========================
    parser = argparse.ArgumentParser(description="TTS Inference API")
    parser.add_argument("-s","--host", type=str, default="0.0.0.0", help="主机地址")
    parser.add_argument("-p","--port", type=int, default=8001, help="端口")
    parser.add_argument("-k","--key", type=str, default="", help="推理密钥")
    parser.add_argument("-c","--config", type=str, default="./GPT_SoVITS/configs/tts_infer.yaml", help="配置文件路径")
    parser.add_argument("-r","--ref_audio", type=str, default="./custom_refs", help="参考音频路径")
    args = parser.parse_args()
        
    infer_key = args.key
    host = args.host
    port = args.port
    ref_audio_path = args.ref_audio
    pre_infer(args.config, ref_audio_path)
    webbrowser.open(f"http://127.0.0.1:{port}")
    uvicorn.run(app=APP, host=host, port=port)