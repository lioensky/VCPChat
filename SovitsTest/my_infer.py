import os
import sys

now_dir = os.getcwd()
sys.path.append(now_dir)
sys.path.append("%s/GPT_SoVITS" % (now_dir))

import subprocess
import numpy as np
import soundfile as sf
import torch
import gc
from typing import TYPE_CHECKING
from tools.logger import logger

if TYPE_CHECKING:
    from gsvi import otherParams

from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
from glob import glob
from pathlib import Path
from re import split
from io import BytesIO
from random import choice, randint
from hashlib import md5
from time import time, sleep
from datetime import datetime
from pydub import AudioSegment
from shutil import move, rmtree
from config import is_half, infer_device, force_half_infer, force_gpu_infer
from GPT_SoVITS.TTS_infer_pack.text_segmentation_method import get_method

#===============推理预备================
def create_weight_dirs():
    gpt_dirs = ["GPT_weights", "GPT_weights_v2", "GPT_weights_v3", "GPT_weights_v4", "GPT_weights_v2Pro", "GPT_weights_v2ProPlus"]
    sovits_dirs = ["SoVITS_weights", "SoVITS_weights_v2", "SoVITS_weights_v3", "SoVITS_weights_v4", "SoVITS_weights_v2Pro", "SoVITS_weights_v2ProPlus"]
    for gpt_dir in gpt_dirs:
        Path(gpt_dir).mkdir(parents=True, exist_ok=True)
        
    for sovits_dir in sovits_dirs:
        Path(sovits_dir).mkdir(parents=True, exist_ok=True)
    
def pre_infer(config_path: str, ref_audio_path: str) -> None:
    global tts_config, tts_pipeline
    create_weight_dirs()
    if config_path in [None, ""]:
        config_path = "GPT-SoVITS/configs/tts_infer.yaml"
    
    logger.debug(f"配置文件路径: {config_path}")
    tts_config = TTS_Config(config_path)
    
    if force_gpu_infer:
        if torch.cuda.is_available():
            tts_config.device = "cuda"
            tts_config.is_half = is_half
            if force_half_infer:
                tts_config.is_half = True
        else:
            tts_config.device = "cpu"
            tts_config.is_half = False
            logger.info("当前无可用 GPU，将使用 CPU 推理。")
            
    else:
        tts_config.device = infer_device
        tts_config.is_half = is_half

    Path(ref_audio_path).mkdir(parents=True, exist_ok=True)
    Path("outputs").mkdir(parents=True, exist_ok=True)
    Path("cache").mkdir(parents=True, exist_ok=True)
    
    tts_pipeline = TTS(tts_config)
    
    
loaded_gpt_model = ""
loaded_sovits_model = ""


def load_weights(gpt, sovits):
    global loaded_gpt_model, loaded_sovits_model
    if gpt != "" and gpt != loaded_gpt_model:
        logger.info(f"正在加载 GPT 模型: {gpt}")
        tts_pipeline.init_t2s_weights(gpt)
        loaded_gpt_model = gpt
    if sovits != "" and sovits != loaded_sovits_model:
        logger.info(f"正在加载 SoVITS 模型: {sovits}")
        tts_pipeline.init_vits_weights(sovits)
        loaded_sovits_model = sovits

    
#===============推理函数================
def pack_ogg(io_buffer:BytesIO, data:np.ndarray, rate:int):
    with sf.SoundFile(io_buffer, mode='w', samplerate=rate, channels=1, format='ogg') as audio_file:
        audio_file.write(data)
    return io_buffer


def pack_raw(io_buffer:BytesIO, data:np.ndarray, rate:int):
    io_buffer.write(data.tobytes())
    return io_buffer


def pack_wav(io_buffer:BytesIO, data:np.ndarray, rate:int):
    io_buffer = BytesIO()
    sf.write(io_buffer, data, rate, format='wav')
    return io_buffer

def pack_aac(io_buffer:BytesIO, data:np.ndarray, rate:int):
    process = subprocess.Popen([
        'ffmpeg',
        '-f', 's16le',  # 输入16位有符号小端整数PCM
        '-ar', str(rate),  # 设置采样率
        '-ac', '1',  # 单声道
        '-i', 'pipe:0',  # 从管道读取输入
        '-c:a', 'aac',  # 音频编码器为AAC
        '-b:a', '192k',  # 比特率
        '-vn',  # 不包含视频
        '-f', 'adts',  # 输出AAC数据流格式
        'pipe:1'  # 将输出写入管道
    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, _ = process.communicate(input=data.tobytes())
    io_buffer.write(out)
    return io_buffer

def pack_mp3(io_buffer:BytesIO, data:np.ndarray, rate:int):
    """
    将 PCM 音频数据打包为 MP3 格式并写入 BytesIO 对象。

    Args:
        io_buffer (BytesIO): 要写入 MP3 数据的 BytesIO 对象。
        data (np.ndarray): 包含 16 位有符号小端整数 PCM 数据的 NumPy 数组。
        rate (int): 音频数据的采样率。

    Returns:
        BytesIO: 包含 MP3 数据的 BytesIO 对象。
    """
    process = subprocess.Popen([
        'ffmpeg',
        '-f', 's16le',  # 输入16位有符号小端整数PCM
        '-ar', str(rate),  # 设置采样率
        '-ac', '1',  # 单声道
        '-i', 'pipe:0',  # 从管道读取输入
        '-c:a', 'libmp3lame',  # 音频编码器更改为 MP3 (libmp3lame)
        '-b:a', '192k',  # 比特率
        '-vn',  # 不包含视频
        '-f', 'mp3',  # 输出格式更改为 MP3
        'pipe:1'  # 将输出写入管道
    ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # 将 NumPy 数组转换为字节流作为 ffmpeg 的输入
    out, _ = process.communicate(input=data.tobytes())

    io_buffer.write(out)
    return io_buffer

def pack_audio(io_buffer:BytesIO, data:np.ndarray, rate:int, media_type:str):
    if media_type == "ogg":
        io_buffer = pack_ogg(io_buffer, data, rate)
    elif media_type == "aac":
        io_buffer = pack_aac(io_buffer, data, rate)
    elif media_type == "wav":
        io_buffer = pack_wav(io_buffer, data, rate)
    elif media_type == "mp3":
        io_buffer = pack_mp3(io_buffer, data, rate)
    else:
        io_buffer = pack_raw(io_buffer, data, rate)
    io_buffer.seek(0)
    return io_buffer

def tts_infer(text, text_lang, ref_audio_path, prompt_text, prompt_lang, top_k, top_p, temperature, text_split_method, batch_size, batch_threshold, split_bucket, speed_facter, fragment_interval, seed, media_type, parallel_infer, repetition_penalty, sample_steps, if_sr):
    t_lang = ["all_zh","en","all_ja","all_yue","all_ko","zh","ja","yue","ko","auto","auto_yue"][["中文","英语","日语","粤语","韩语","中英混合","日英混合","粤英混合","韩英混合","多语种混合","多语种混合(粤语)"].index(text_lang)]
    p_lang = ["all_zh","en","all_ja","all_yue","all_ko","zh","ja","yue","ko","auto","auto_yue"][["中文","英语","日语","粤语","韩语","中英混合","日英混合","粤英混合","韩英混合","多语种混合","多语种混合(粤语)"].index(prompt_lang)]
    cut_method = ["cut0","cut1","cut2","cut3","cut4","cut5"][["不切","凑四句一切","凑50字一切","按中文句号。切","按英文句号.切","按标点符号切"].index(text_split_method)]
    infer_dict = {
        "text": text,
        "text_lang": t_lang,
        "ref_audio_path": ref_audio_path,
        "prompt_text": prompt_text,
        "prompt_lang": p_lang,
        "top_k": top_k,
        "top_p": top_p,
        "temperature": temperature,
        "text_split_method": cut_method,
        "batch_size": batch_size,
        "batch_threshold": batch_threshold,
        "split_bucket": split_bucket,
        "speed_factor": speed_facter,
        "fragment_interval": fragment_interval,
        "seed": seed,
        "parallel_infer": parallel_infer,
        "repetition_penalty": repetition_penalty,
        "sample_steps": sample_steps,
        "if_sr": if_sr
    }
    with torch.no_grad():
        tts_gen = tts_pipeline.run(infer_dict)
        sr, audio = next(tts_gen)
        torch.cuda.empty_cache()
        gc.collect()
    audio = pack_audio(BytesIO(), audio, sr, media_type).getvalue()
    
    return audio

#===============音频处理================
def audio_md5(audio):
    audio_md5 = md5(audio).hexdigest()
    return audio_md5

#===============通用函数================

# 随机种子码
def random_seed():
    seed = randint(0, 4294967295)
    return seed

#判断参考音频时长是否在3~10秒之间
def check_ref_audio_duration(ref_audio_path):
    audio = AudioSegment.from_file(ref_audio_path)
    duration = len(audio) / 1000  # 转换为秒
    if 3 <= duration <= 10:
        return True
    else:
        return False

# 根据情感参考音频文件名分离情感名称和参考文本
def get_tag_text(file_name):
    tag = split("【|】", file_name)[1]
    text = split("【|】", file_name)[2]
    return tag, text

# 获取说话人支持的参考音频语言
def get_ref_audio_langs(modelname: str, version: str) -> list[str]:
    langs = []
    lang_dir = glob(f"models/{version}/{modelname}/reference_audios/*")
    for lang in lang_dir:
        lang_name = Path(lang).name
        langs.append(lang_name)
    return langs

# 根据语言获取参考情感列表
def get_ref_audios(modelname: str, lang: str, version: str) -> list[str]:
    audios = glob(f"models/{version}/{modelname}/reference_audios/{lang}/emotions/*.wav")
    audio_list = []
    for audio in audios:
        audio_name = Path(audio).name
        emotion, emo_text = get_tag_text(audio_name)
        audio_list.append(emotion)
    if Path(f"models/{version}/{modelname}/reference_audios/{lang}/randoms").exists():
        audio_list.append("随机")
    return audio_list

# 获取指定情感的完整参考音频文件名
def get_ref_audio(modelname: str, lang: str, emotion: str, version: str) -> tuple[str, str]:
    emo = ""
    emo_text = ""
    audios = glob(f"models/{version}/{modelname}/reference_audios/{lang}/emotions/*.wav")
    for audio in audios:
        audio_name = str(Path(audio).name).replace(".wav", "")
        if f"【{emotion}】" in audio_name:
            emo, emo_text = get_tag_text(audio_name)
    return emo, emo_text

# 随机选择参考音频
def random_ref_audio(modelname, lang, version):
    if Path(f"models/{version}/{modelname}/reference_audios/{lang}/randoms").exists():
        audios = glob(f"models/{version}/{modelname}/reference_audios/{lang}/randoms/*.wav")
        audio = choice(audios)
        lab_content = Path(audio).name.replace(".wav", "")
    else:
        audio = ""
        lab_content = ""
    return audio, lab_content
    
#获取模型路径
def get_model_path(model_name, version):
    gpt_models = glob(f"models/{version}/{model_name}/*.ckpt")
    sovits_models = glob(f"models/{version}/{model_name}/*.pth")
    gpt_model = gpt_models[0] if len(gpt_models) > 0 else ""
    sovits_model = sovits_models[0] if len(sovits_models) > 0 else ""
    return gpt_model, sovits_model

#加载模型
def load_model(model_name, version):
    gpt_model, sovits_model = get_model_path(model_name, version)
    load_weights(gpt_model, sovits_model)

#移动模型
def move_model_files(version, categroy, lang, model):
    model_files = glob(f"cache/{categroy}-{lang}-{model}/**/*", recursive=True)
    Path(f"models/{version}/{categroy}-{lang}-{model}/reference_audios/{lang}/emotions").mkdir(parents=True, exist_ok=True)
    for file in model_files:
        if file.endswith(".wav"):
            move(file, f"models/{version}/{categroy}-{lang}-{model}/reference_audios/{lang}/emotions")
            logger.info(f"Moved {file} to models/{version}/{categroy}-{lang}-{model}/reference_audios/{lang}/emotions")
        elif file.endswith(".log") or file.endswith(".ckpt") or file.endswith(".pth"):
            move(file, f"models/{version}/{categroy}-{lang}-{model}")
            logger.info(f"Moved {file} to models/{version}/{categroy}-{lang}-{model}")

#===============接口函数================
def get_version() -> list[str]:
    """ 获取所有支持版本 """
    versions = ["v2", "v3", "v4", "v2Pro", "v2ProPlus"]
    return versions

def version_support(version: str) -> bool:
    """ 检查版本是否支持 """
    support_versions = get_version()
    if version not in support_versions:
        return False
    else:
        return True

# 获取多人对话参考单人模板（不支持自定义参考音频）
def get_multi_ref_template(version: str) -> tuple[list[str], str]:
    msg = ""
    template_list = []
    if not version_support(version):
        msg = "不支持该版本！"
    else:
        speakers = glob(f"models/{version}/*")
        if len(speakers) == 0:
            msg = "该模型不存在或未设置参考音频"
        for speaker in speakers:
            speaker_name = Path(speaker).name
            multi_template = f"{version}|{speaker_name}|合成语言|参考语言|情感|语速|#内容请自由发挥‖"
            template_list.append(multi_template)
            msg = "获取成功"
    return template_list, msg

# 创建说话人列表
def create_speaker_list(version: str) -> tuple[dict[str, dict[str, list[str]]], str]:
    spk_list = {}
    if not version_support(version):
        msg = "不支持该版本！"
    else:
        speakers = glob(f"models/{version}/*")
        if len(speakers) == 0:
            msg = "该模型不存在!"
        else:
            for speaker in speakers:
                spk_name = Path(speaker).name
                langs = get_ref_audio_langs(spk_name, version)
                spk_list[spk_name] = {}
                for lang in langs:
                    audios = get_ref_audios(spk_name, lang, version)
                    spk_list[spk_name][lang] = audios
            msg = "获取成功"
    return spk_list, msg
    
# 根据说话人和情感合成语音（单人合成）
def single_infer(modelname, prompt_lang, emotion, text, text_lang, top_k, top_p, temperature, text_split_method, batch_size, batch_threshold, split_bucket, speed_facter, fragment_interval, media_type, parallel_infer, repetition_penalty, seed, sample_steps, if_sr, version):
    if not version_support(version):
        msg = "不支持该版本！或没选择版本！"
        audio_path = ""
    elif modelname == "":
        msg = "请选择模型"
        audio_path = ""
    else:
        if emotion == "随机":
            ref_audio, lab_content = random_ref_audio(modelname, prompt_lang, version)
            prompt_text = lab_content
        else:
            emo, prompt_text = get_ref_audio(modelname, prompt_lang, emotion, version)
            ref_audio = f"models/{version}/{modelname}/reference_audios/{prompt_lang}/emotions/【{emo}】{prompt_text}.wav"
            
        if ref_audio == "":
            msg = "情感不存在"
            audio_path = ""
        elif text == "":
            msg = "请提供合成文本"
            audio_path = ""
        else:
            load_model(modelname, version)
            if seed == -1:
                seed = random_seed()
            audio = tts_infer(text, text_lang, ref_audio, prompt_text, prompt_lang, top_k, top_p, temperature, text_split_method, batch_size, batch_threshold, split_bucket, speed_facter, fragment_interval, seed, media_type, parallel_infer, repetition_penalty, sample_steps, if_sr)
            audio_md5 = md5(audio).hexdigest()
            audio_path = f"outputs/{audio_md5}.{media_type}"
            Path(audio_path).write_bytes(audio)
            msg = "合成成功"
    return audio_path, msg

# 根据说话人和情感合成语音（多人合成）
def multi_infer(content, top_k, top_p, temperature, text_split_method, batch_size, batch_threshold, split_bucket, fragment_interval, media_type, parallel_infer, repetition_penalty, seed, sample_steps, if_sr):
    log_list = []
    try:
        content_list = content.split("‖")
        filtered_list = list(filter(str.strip, content_list))
        content_md5 = f"{md5(content.encode()).hexdigest()}_{int(time())}"
        content_md5 = md5(content_md5.encode()).hexdigest()
        Path(f"outputs/conv_{content_md5}").mkdir(parents=True, exist_ok=True)
        for i, single_content in enumerate(filtered_list):
            try:
                single_content_list = single_content.split("|")
                model_version = single_content_list[0]
                model_name = single_content_list[1]
                text_lang = single_content_list[2]
                prompt_lang = single_content_list[3]
                emotion = single_content_list[4]
                speed_facter = float(single_content_list[5])
                text = single_content_list[6]
                text = text.replace("#", "")
                if emotion == "随机":
                    ref_audio, lab_content = random_ref_audio(model_name, prompt_lang, model_version)
                    prompt_text = lab_content
                else:
                    emo, prompt_text = get_ref_audio(model_name, prompt_lang, emotion, model_version)
                    ref_audio = f"models/{model_version}/{model_name}/reference_audios/{prompt_lang}/emotions/【{emo}】{prompt_text}.wav"
            except:
                log_list.append(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}] 第 {i+1} 段对话格式错误或参数有误，已跳过！")
                continue
            log_list.append(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}] 正在合成第 {i+1} 段对话，模型：{model_name}，版本：{model_version}，情感：{emotion}")
            load_model(model_name, model_version)
            if seed == -1:
                seed = random_seed()
            audio = tts_infer(text, text_lang, ref_audio, prompt_text, prompt_lang, top_k, top_p, temperature, text_split_method, batch_size, batch_threshold, split_bucket, speed_facter, fragment_interval, seed, media_type, parallel_infer, repetition_penalty, sample_steps, if_sr)
            Path(f"outputs/conv_{content_md5}/{i+1}_{model_name}_{model_version}.{media_type}").write_bytes(audio)
            Path(f"outputs/conv_{content_md5}/{i+1}_{model_name}_{model_version}.txt").write_text(text, encoding="utf-8")
            log_list.append(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}] 第 {i+1} 段对话合成成功！")
        Path(f"outputs/conv_{content_md5}/log.txt").write_text("\n".join(log_list), encoding="utf-8")
        if os.name == "nt":
            subprocess.run(f"./7-Zip/7za.exe a -t7z outputs/conv_{content_md5}.7z outputs/conv_{content_md5}",stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        else:
            subprocess.run(f"7za a -t7z outputs/conv_{content_md5}.7z outputs/conv_{content_md5}", shell=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        archive_path = f"outputs/conv_{content_md5}.7z"
        msg = "合成成功"
    except:
        msg = "合成失败，参数错误！"
        archive_path = ""
    return archive_path, msg

#===============原版兼容================
# 获取模型列表
def get_classic_model_list(version):
    gpt_model_list = []
    sovits_model_list = []
    gpt_model_path_index = {}
    sovits_model_path_index = {}
    if not version_support(version):
        msg = "不支持该版本！"
    else:
        installed_gpt = glob(f"models/{version}/**/*.ckpt", recursive=True)
        installed_sovits = glob(f"models/{version}/**/*.pth", recursive=True)
        classic_gpt = glob(f"GPT_weights_{version}/*.ckpt", recursive=True)
        classic_sovits = glob(f"SoVITS_weights_{version}/*.pth", recursive=True)
        
        for inst_gpt in installed_gpt:
            model_name = Path(inst_gpt).name.replace(".ckpt", "")
            model_name = f"【GSVI】{model_name}"
            gpt_model_list.append(model_name)
            gpt_model_path_index[model_name] = inst_gpt
            
        for inst_sovits in installed_sovits:
            model_name = Path(inst_sovits).name.replace(".pth", "")
            model_name = f"【GSVI】{model_name}"
            sovits_model_list.append(model_name)
            sovits_model_path_index[model_name] = inst_sovits
            
        for classic_gpt_model in classic_gpt:
            model_name = Path(classic_gpt_model).name.replace(".ckpt", "")
            model_name = f"【经典】{model_name}"
            gpt_model_list.append(model_name)
            gpt_model_path_index[model_name] = classic_gpt_model
            
        for classic_sovits_model in classic_sovits:
            model_name = Path(classic_sovits_model).name.replace(".pth", "")
            model_name = f"【经典】{model_name}"
            sovits_model_list.append(model_name)
            sovits_model_path_index[model_name] = classic_sovits_model
        msg = "获取模型列表成功"
            
    return gpt_model_list, sovits_model_list, msg, gpt_model_path_index, sovits_model_path_index

# 推理函数
def classic_infer(gpt_model_name, sovits_model_name, ref_audio_path, prompt_text, prompt_lang, text, text_lang, top_k, top_p, temperature, text_split_method, batch_size, batch_threshold, split_bucket, speed_facter, fragment_interval, seed, media_type, parallel_infer, repetition_penalty, sample_steps, if_sr, version):
    audio_path = ""
    if not version_support(version):
        msg = "不支持该版本！或没选择版本！"
    else:
        _, _, msg, gpt_model_path_index, sovits_model_path_index = get_classic_model_list(version)
        
        gpt_model = gpt_model_path_index.get(gpt_model_name, "")
        sovits_model = sovits_model_path_index.get(sovits_model_name, "")
        
        if gpt_model_name == "":
            msg = "无 GPT 模型"
        elif sovits_model_name == "":
            msg = "无 SoVITS 模型"
        elif ref_audio_path == "":
            msg = "请上传参考音频"
        elif not check_ref_audio_duration(ref_audio_path):
            msg = "参考音频时长不符合要求，请在3~10秒之间"
        elif prompt_text == "":
            msg = "请提供参考文本"
        elif text == "":
            msg = "请提供合成文本"
        elif not Path(gpt_model).exists() or not Path(sovits_model).exists():
            msg = "模型不存在"
        else:
            load_weights(gpt_model, sovits_model)
            audio = tts_infer(text, text_lang, ref_audio_path, prompt_text, prompt_lang, top_k, top_p, temperature, text_split_method, batch_size, batch_threshold, split_bucket, speed_facter, fragment_interval, seed, media_type, parallel_infer, repetition_penalty, sample_steps, if_sr)
            audio_md5 = md5(audio).hexdigest()
            audio_path = f"outputs/{audio_md5}.{media_type}"
            Path(audio_path).write_bytes(audio)
            msg = "合成成功"
    return audio_path, msg

#=========OpenAI语音合成兼容接口=========


def openai_like_infer(model, input, voice, response_format, speed, other_options: "otherParams"):

    version = model.split("-")[1]
    if not version_support(version):
        msg = "不支持该版本！"
        audio_data = None
    elif model == "":
        msg = "请选择模型"
        audio_data = None
    elif input == "":
        msg = "请提供合成文本"
        audio_data = None
    elif voice == "":
        msg = "请选择说话人"
        audio_data = None
    else:
        if other_options.emotion == "随机":
            ref_audio, lab_content = random_ref_audio(voice, other_options.prompt_lang, version)
            prompt_text = lab_content
        else:
            emo, prompt_text = get_ref_audio(voice, other_options.prompt_lang, other_options.emotion, version)
            ref_audio = f"models/{version}/{voice}/reference_audios/{other_options.prompt_lang}/emotions/【{emo}】{prompt_text}.wav"
        load_model(voice, version)
        if other_options.seed == -1:
            seed = random_seed()
        else:
            seed = other_options.seed
            
        audio_data = tts_infer(
            input, 
            other_options.text_lang, 
            ref_audio, prompt_text, 
            other_options.prompt_lang, 
            other_options.top_k, 
            other_options.top_p, 
            other_options.temperature, 
            other_options.text_split_method, 
            other_options.batch_size, 
            other_options.batch_threshold, 
            other_options.split_bucket, 
            speed, 
            other_options.fragment_interval, 
            seed, 
            response_format, 
            other_options.parallel_infer, 
            other_options.repetition_penalty, 
            other_options.sample_steps, 
            other_options.if_sr
            )
        msg = "合成成功"
    return audio_data, msg
                    
#===============一键安装================
# 获取已安装模型列表
def get_installed_models(version):
    model_list = []
    if not version_support(version):
        msg = "不支持该版本！"
    else:
        installed_models = glob(f"models/{version}/*")
        if len(installed_models) == 0:
            msg = "该版本暂无已安装模型！"
        else:
            for model in installed_models:
                model_name = Path(model).name
                model_list.append(model_name)
            msg = "获取已安装模型列表成功"
    return model_list, msg

# 检测是否已安装对应模型
def check_installed(version, categroy, lang, model_name):
    model_dir = Path(f"models/{version}/{categroy}-{lang}-{model_name}")
    if model_dir.exists():
        return True

    if model_name:
        direct_model_dir = Path(f"models/{version}/{model_name}")
        if direct_model_dir.exists():
            return True

    return False
    
# 检测模型是否成功安装
def check_model_installed(version, categroy, lang, model_name):
    if not check_installed(version, categroy, lang, model_name):
        return False
    else:
        gpt_model_files = glob(f'models/{version}/{categroy}-{lang}-{model_name}/*.ckpt', recursive=True)
        sovits_model_files = glob(f'models/{version}/{categroy}-{lang}-{model_name}/*.pth', recursive=True)
        if len(gpt_model_files) == 0 or len(sovits_model_files) == 0:
            return False
        else:
            return True
    
# 安装模型
def install_model(version, categroy, lang, model_name, model_url):
    if check_installed(version, categroy, lang, model_name):
        msg = f"模型 {categroy}-{lang}-{model_name} 已安装过！"
    elif model_url == "":
        msg = f"下载链接不能为空！"
    elif version == "":
        msg = f"版本不能为空！"
    elif categroy == "":
        msg = f"模型类别不能为空！"
    elif lang == "":
        msg = f"语言不能为空！"
    elif model_name == "":
        msg = f"模型名称不能为空！" 
    else:    
        print(f"------------------------模型 {categroy}-{lang}-{model_name} 安装中------------------------")
        print(f"------------------------模型 {categroy}-{lang}-{model_name} 下载中------------------------")
        if os.name == "nt":
            subprocess.run(f"./Aria2/aria2c.exe -x16 -s16 -c {model_url} -o cache/{categroy}-{lang}-{model_name}.zip")
        else:
            subprocess.run(f"aria2c -x16 -s16 -c {model_url} -o cache/{categroy}-{lang}-{model_name}.zip", shell=True)
        if Path(f"cache/{categroy}-{lang}-{model_name}.zip").exists():
            print(f"------------------------模型 {categroy}-{lang}-{model_name} 解压中------------------------")
            Path(f"cache/{categroy}-{lang}-{model_name}").mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                subprocess.run(f"./7-Zip/7za.exe x cache/{categroy}-{lang}-{model_name}.zip -ocache/{categroy}-{lang}-{model_name}",stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            else:
                subprocess.run(f"7za x cache/{categroy}-{lang}-{model_name}.zip -ocache/{categroy}-{lang}-{model_name}", shell=True)
            print(f"------------------------模型 {categroy}-{lang}-{model_name} 移动中------------------------")
            move_model_files(version, categroy, lang, model_name)
            print(f"------------------------清理 {categroy}-{lang}-{model_name} 的缓存------------------------")
            rmtree(f"cache/{categroy}-{lang}-{model_name}")
            Path(f"cache/{categroy}-{lang}-{model_name}.zip").unlink()
            if check_model_installed(version, categroy, lang, model_name):
                print(f"------------------------模型 {categroy}-{lang}-{model_name} 安装完成------------------------")
                msg = f"模型 {categroy}-{lang}-{model_name} 安装完成！可在 models/{version} 目录下查看！"
            else:
                msg = f"模型 {categroy}-{lang}-{model_name} 安装失败或已损坏，请检查下网络连接！"
                rmtree(f"models/{version}/{categroy}-{lang}-{model_name}")
        else:
            msg = f"模型 {categroy}-{lang}-{model_name} 下载失败，请检查网络连接！"
    return msg

# 删除模型
def delete_model(version, categroy, lang, model_name):
    if not check_installed(version, categroy, lang, model_name):
        msg = f"模型 {categroy}-{lang}-{model_name} 不存在！"
    else:
        rmtree(f"models/{version}/{categroy}-{lang}-{model_name}")
        msg = f"模型 {categroy}-{lang}-{model_name} 删除成功！"
    return msg