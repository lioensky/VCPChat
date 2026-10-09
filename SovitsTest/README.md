# Sovits API 使用文档

> **当前 VCPChat 兼容开发请优先阅读：[本地 SoVITS TTS 推理服务器兼容开发文档](../docs/local-sovits-tts-server-compatibility.md)。**
> 本页保留的是旧 v4 服务示例；当前客户端固定发送 v2ProPlus 版本标签，使用 Bearer 请求头鉴权。
> 端口可配置，URL 留空时客户端实际默认使用 8000；设置界面的 9880 仅为示例。

本文档旨在说明如何通过 API 调用本地部署的 Sovits 服务进行文本转语音（TTS）。

## 1. 语音合成 API

这是用于生成语音的核心 API。

- **端点**: `/v1/audio/speech`
- **方法**: `POST`
- **Content-Type**: `application/json`

### 请求体 (Payload)

```json
{
  "model": "tts-v4",
  "input": "这里是您想要合成的文本内容。",
  "voice": "您的模型名称",
  "response_format": "mp3",
  "speed": 1.0,
  "other_params": {
    "app_key": "",
    "text_lang": "中英混合",
    "prompt_lang": "中文",
    "emotion": "默认",
    "top_k": 10,
    "top_p": 1.0,
    "temperature": 1.0,
    "text_split_method": "按标点符号切",
    "batch_size": 1,
    "batch_threshold": 0.75,
    "split_bucket": true,
    "fragment_interval": 0.3,
    "parallel_infer": true,
    "repetition_penalty": 1.35,
    "sample_steps": 16,
    "if_sr": false,
    "seed": -1
  }
}
```

### 参数详解

#### 顶层参数

- `model` (string, **必需**): 使用的 TTS 引擎版本。通常是固定的字符串，例如 `"tts-v4"`。
- `input` (string, **必需**): 您想要转换为语音的文本。
- `voice` (string, **必需**): 使用的角色模型名称。可以通过 `/models` 端点获取可用列表。
- `response_format` (string, 可选): 返回的音频格式，如 `"wav"`, `"mp3"`。默认为 `"mp3"`。
- `speed` (float, 可选): 语速。默认为 `1.0`。
- `other_params` (object, 可选): 其他高级参数，详见下文。

#### `other_params`

- `text_lang` (string): 输入文本的语言，如 `"中文"`, `"英文"`, `"日文"`, `"中英混合"`。
- `prompt_lang` (string): 参考提示的语言。
- `emotion` (string): 参考情感。通常与 `voice` 对应的模型有关，例如 `"默认"`。
- `seed` (integer): 随机种子，设置为 `-1` 表示随机。

## 2. 获取可用模型

在进行语音合成前，您需要知道有哪些可用的角色模型。

- **端点**: `/models`
- **方法**: `POST`
- **请求体**: `{"version": "v4"}`
- **成功响应**: 返回一个 JSON 对象，其中 `models` 键下包含了所有可用的模型及其支持的语言和情感。

## 3. 使用示例

### cURL 示例

```bash
curl -X POST http://127.0.0.1:8000/v1/audio/speech \
-H "Content-Type: application/json" \
-d '{
  "model": "tts-v4",
  "input": "使用 cURL 进行测试。",
  "voice": "原神-中文-绮良良_ZH",
  "response_format": "wav"
}' --output output.wav
```

### Python 示例

请参考项目中的 [`test_sovits_api.py`](test_sovits_api.py:1) 文件，它包含了一个完整、可运行的示例。