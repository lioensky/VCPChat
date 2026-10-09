# VCPChat 本地 SoVITS TTS 推理服务器兼容开发文档

> 核对日期：2026-10-09。本文描述当前仓库客户端的实际协议，不是通用 GPT-SoVITS API 标准。
> “必需”指无需修改当前客户端即可接入；“建议”指新服务器的实现建议，并非客户端已有能力。
> 后端可以使用任意 TTS 引擎，只需提供这里描述的兼容层。

## 1. 最小兼容范围

新服务器只需提供两个接口：

| 用途 | HTTP 方法 | 相对服务基础地址的路径 | 成功返回 |
| --- | --- | --- | --- |
| 获取音色/角色列表 | POST | /models | JSON，成功消息必须是“获取成功” |
| 文本合成 | POST | /v1/audio/speech | 完整的可解码音频二进制，推荐 MP3 |

无需为当前本地模式实现模型加载/切换、上传参考音频、安装模型、任务轮询、WebSocket、SSE 或停止推理接口。客户端不会调用这些接口。角色模型、参考音频及参考文本应由服务器内部维护。

协议依据：[模型列表请求](../modules/SovitsTTS.js:344)、[合成请求](../modules/SovitsTTS.js:430)。

## 2. 地址、端口与配置

### 2.1 端口不是固定要求

- 本地 URL 留空时，客户端实际使用 **http://127.0.0.1:8000**。
- 设置界面显示的 **http://127.0.0.1:9880** 只是输入提示，不是默认值。
- 可以使用 8000、9880、8001 或其他可访问端口，只要设置中的基础地址与服务器一致。
- 客户端不会启动推理服务器、探测端口或自动寻找服务。

依据：[实际默认地址](../modules/SovitsTTS.js:6)、[运行配置解析](../modules/SovitsTTS.js:58)、[设置界面提示](../modules/settings/schema/voice-settings.js:117)。

### 2.2 用户配置步骤

1. 在全局“语音设置”中选择“本地推理模式”。
2. “本地 SoVITS URL”填服务器基础地址，例如 http://127.0.0.1:8000。
3. 无鉴权时“本地 SoVITS Key”留空；有鉴权时填写密钥本身，不要加 Bearer 前缀。
4. 保存全局设置。
5. 在 Agent 设置中点击语音模型刷新按钮，选择主语言音色并保存 Agent 设置。
6. 触发朗读验证。

配置数据示意：

```json
{
  "voiceMode": "local",
  "voiceLocalSettings": {
    "sovitsUrl": "http://127.0.0.1:8000",
    "sovitsKey": ""
  }
}
```

对应字段依据：[语音模式](../modules/settings/schema/voice-settings.js:8)、[本地地址和密钥](../modules/settings/schema/voice-settings.js:117)。

### 2.3 基础地址拼接规则

客户端去除地址首尾空白及末尾斜杠，然后直接追加接口路径：

| 配置基础地址 | 模型列表请求 | 合成请求 |
| --- | --- | --- |
| http://127.0.0.1:8000 | http://127.0.0.1:8000/models | http://127.0.0.1:8000/v1/audio/speech |
| https://tts.example.com/compat | https://tts.example.com/compat/models | https://tts.example.com/compat/v1/audio/speech |

不要填完整合成地址，也不要仅因接口带有 /v1 就在基础地址末尾追加 /v1，否则会出现 /v1/v1/audio/speech。

建议显式填写 http:// 或 https://；本地 TTS 配置解析没有自动补全协议功能。依据：[地址处理](../modules/SovitsTTS.js:71)。

### 2.4 监听和跨域

同机部署建议只监听 127.0.0.1；跨机器部署需监听可访问地址，配置防火墙，并按需使用 TLS 和鉴权。

当前请求由 Electron 主进程的 HTTP 客户端发出，不是网页直接请求，因此浏览器 CORS 不是这条调用链的必需条件。若额外提供浏览器管理页面，应单独设计其跨域策略。

## 3. 鉴权规范

配置密钥非空时，**两个接口**都会收到：

```http
Authorization: Bearer your-secret-key
Content-Type: application/json
```

密钥为空时不附带 Authorization。Content-Type 由 HTTP 客户端在发送 JSON 对象时设置。

新服务器应读取 Authorization 请求头；不要要求客户端额外提交请求体密钥。当前合成请求不会发送旧服务所使用的请求体 app_key 字段。

建议无效密钥返回 HTTP 401 或 403，响应类型为 application/json。当前客户端只会记录错误，不支持鉴权挑战、自动刷新令牌或交互式登录。

依据：[请求头构造](../modules/SovitsTTS.js:274)。

## 4. 模型列表接口

### 4.1 实际请求

```http
POST /models HTTP/1.1
Content-Type: application/json
```

```json
{
  "version": "v2ProPlus"
}
```

当前客户端固定发送这个版本标签，没有版本协商，也不会先调用 /version。新引擎无需真的实现该版本算法，但必须接受这个兼容标签，可以在内部映射到自己的模型目录。

### 4.2 推荐响应：音色对象数组

```json
{
  "msg": "获取成功",
  "models": [
    {
      "id": "speaker_zh_001",
      "voice": "speaker_zh_001",
      "displayName": "小夏 · 中文",
      "type": "local"
    },
    {
      "id": "speaker_日语_001",
      "voice": "speaker_日语_001",
      "displayName": "小夏 · 日语",
      "type": "local"
    }
  ]
}
```

| 字段 | 兼容含义 |
| --- | --- |
| [msg](../modules/SovitsTTS.js:401) | 必须精确等于“获取成功”；“success”“获取模型成功”等不被接受 |
| [models](../modules/SovitsTTS.js:401) | 必须提供，建议为音色对象数组或名称映射对象；无音色时返回空数组 |
| [voice](../modules/settingsManager.js:964) | 建议必填，非空且唯一的字符串；选中后原样作为合成音色参数发送 |
| [id](../modules/settingsManager.js:963) | 建议与音色参数一致；音色参数缺失时可作为后备值 |
| [displayName](../modules/settingsManager.js:965) | 推荐提供，用于下拉框显示；不作为推理参数 |
| [type](../modules/settingsManager.js:991) | 可选；本地模式不会按此字段分组 |

数组中的后备解析顺序：

- 实际音色值：[voice → uri → id](../modules/settingsManager.js:964)。
- 显示名称：[displayName → customName → name → voice → uri → id](../modules/settingsManager.js:965)。
- 重复的实际音色值只保留第一项。
- 不要返回纯字符串数组；当前界面按对象字段读取，字符串数组无法正常生成选项。
- 音色值应稳定，不要随刷新随机变化，否则已保存的 Agent 音色可能失效。

### 4.3 兼容响应：名称映射对象

```json
{
  "msg": "获取成功",
  "models": {
    "小夏-中文": {
      "中文": ["默认"]
    },
    "小夏-日语": {
      "日语": ["默认"]
    }
  }
}
```

客户端会把映射对象的顶层键同时作为显示名称和实际音色值。内部语言/情绪信息不会被界面读取或参与参数选择。因此，若只想提供最小列表，每个键对应空对象也可以。

不要把分页结果或 OpenAI 风格列表包装在映射对象内部；否则包装键也可能被当成音色名称。顶层只有 data 而没有 models 的响应也不兼容。

依据：[映射对象转换](../modules/settingsManager.js:947)。

### 4.4 模型列表缓存

- 普通读取优先使用项目内的 [本地模型缓存](../AppData/sovits_local_models.json)，缓存存在时通常不会发送请求。
- 点击刷新会强制请求服务器，并缓存响应中的模型数据部分，而不是整个响应包装。
- 强制请求出现网络异常或非成功 HTTP 状态时，会尝试回退到旧缓存。
- HTTP 成功但响应结构不符合成功条件时返回空结果，不走同一异常回退流程。
- 缓存没有按服务器 URL 或密钥隔离，也没有 TTL；切换服务器后务必手动刷新。
- 刷新界面的成功提示不能单独作为服务器已正确返回最新列表的证明，应结合服务端请求日志检查。

依据：[读取及回退](../modules/SovitsTTS.js:385)、[刷新按钮](../modules/settingsManager.js:1351)。

## 5. 语音合成接口

### 5.1 完整的当前请求

```http
POST /v1/audio/speech HTTP/1.1
Content-Type: application/json
```

```json
{
  "model": "tts-v2ProPlus",
  "input": "你好，这是新推理服务器的兼容性测试。",
  "voice": "speaker_zh_001",
  "response_format": "mp3",
  "speed": 1.0,
  "other_params": {
    "text_lang": "中英混合",
    "prompt_lang": "中文",
    "emotion": "默认",
    "text_split_method": "按标点符号切"
  }
}
```

这是当前客户端实际发送的结构。不要把旧测试脚本中的高级参数都设为必填。依据：[请求体生成](../modules/SovitsTTS.js:463)。

### 5.2 字段处理规范

| 字段 | 当前行为与服务器要求 |
| --- | --- |
| [model](../modules/SovitsTTS.js:472) | 固定为 tts-v2ProPlus；建议作为兼容入口别名，不必与真实后端模型名称一致 |
| [input](../modules/SovitsTTS.js:473) | 要朗读的文本片段；支持 Unicode、中英文标点及换行 |
| [voice](../modules/SovitsTTS.js:474) | 下拉框选择的实际音色值，服务器必须能解析列表中每个可选值 |
| [response_format](../modules/SovitsTTS.js:475) | 固定请求 mp3；严格兼容建议实际编码为 MP3 |
| [speed](../modules/SovitsTTS.js:476) | Agent 语速，界面通常为 0.5–2.0，步长 0.1；服务器负责实现语速变化 |
| [other_params](../modules/SovitsTTS.js:477) | 当前只包含上述四个参数；额外参数应有默认值，不应强制客户端补齐 |

语速建议语义：1.0 为正常，0.5 为较慢，2.0 为较快。客户端在本地模式播放时使用 1 倍播放速度，不会替服务器进行语速补偿。服务器应验证语速为有效正数；如何处理缺失或超界值属于服务器策略，建议默认 1.0 并明确返回验证错误。

导演提示词在本地模式下不会加入 HTTP 合成请求；如果新引擎需要额外风格提示、动态参考音频或情绪选择，需要修改客户端，或预先映射成不同音色。

### 5.3 日语分支：取决于实际音色值

若实际音色值包含精确的“日语”两个字，则客户端改为：

```json
{
  "text_lang": "日语",
  "prompt_lang": "日语",
  "emotion": "默认",
  "text_split_method": "按标点符号切"
}
```

否则固定为“中英混合”与“中文”。不会根据输入文本、显示名称或列表元数据自动检测语言。

例如显示名称写“小夏 · 日语”，但实际音色值为 speaker_ja_001，仍走中文分支。需要触发日语分支时，可将实际音色值命名为 speaker_日语_001。

如果服务器内部采用 zh、ja、auto 等语言编码，应在兼容层映射中文标签。服务器也可以自行检测语言，但这是后端策略，不是当前客户端能力。

依据：[语言判断](../modules/SovitsTTS.js:466)。

### 5.4 成功响应：完整音频二进制

推荐：

```http
HTTP/1.1 200 OK
Content-Type: audio/mpeg

<完整 MP3 文件的原始二进制字节>
```

必需条件：

1. HTTP 状态处于 200–299。
2. Content-Type 包含小写的 audio/；推荐标准值 audio/mpeg。
3. 响应体是浏览器能解码的完整音频文件，而不是 JSON、下载地址、Base64 字符串或裸 PCM。

客户端将响应整体读入内存，缓存后再送到播放端。Content-Length 不是客户端检查项；HTTP 分块传输可以用于传送完整音频，但**不会让本地模式边收边播**。

当前实现也可能播放带正确类型和文件头的 WAV，但客户端请求和本地缓存扩展名固定按 MP3 处理。因此新服务器应优先遵守 MP3 请求，不建议依赖格式不一致的宽松行为。采样率和声道数没有固定客户端协议要求，关键是音频完整可解码。

依据：[HTTP 和媒体类型检查](../modules/SovitsTTS.js:492)、[播放端解码](../modules/renderer/ttsSurfaceOwner.js:73)。

以下响应不兼容：

- HTTP 202 加任务 ID：没有任务轮询逻辑。
- JSON 返回音频 URL 或 Base64：没有对应解析逻辑。
- text/event-stream：本地模式没有 SSE 音频解析逻辑。
- application/octet-stream：不通过音频类型检查。
- 裸 PCM 即使标记为音频类型：缺乏容器信息，不能保证解码成功。
- HTML 页面：反向代理或静态站点回退可能掩盖接口路由错误。

### 5.5 错误响应建议

使用明确的 HTTP 错误状态，并返回 JSON，例如：

```http
HTTP/1.1 404 Not Found
Content-Type: application/json
```

```json
{
  "error": {
    "message": "未找到音色 speaker_zh_001",
    "type": "invalid_request_error",
    "param": "voice",
    "code": "voice_not_found"
  }
}
```

建议状态：400/422 为参数错误，401/403 为鉴权失败，404 为未知音色，429 为队列繁忙，500/503 为推理失败或不可用。错误体结构是建议，不是客户端强制 Schema；客户端目前主要将响应体写入日志，没有自动重试、退避或错误恢复协商。

不要把错误 JSON 标记为 audio/mpeg，否则它会被缓存并导致播放解码失败。

## 6. 文本分段、并发、停止和音频缓存

### 6.1 分段和请求调度

客户端先按主副语言正则切分文本，为每段选择主音色或副音色，再进行文本切块：

- 第一段通常拆出首句及剩余部分。
- 首句以感叹号结束时，可能合并下一句。
- 后续非空行作为独立文本块。
- 一次朗读可能产生多个合成请求；通常等待上一块合成完成后请求下一块，但不等待上一块播放结束。

服务器应将每个请求视作独立合成，不要要求额外的会话建立、结束消息或上下文 ID。

依据：[切块算法](../modules/SovitsTTS.js:536)、[双语任务创建](../modules/SovitsTTS.js:654)、[合成队列](../modules/SovitsTTS.js:702)。

### 6.2 停止不等于取消服务端推理

停止按钮会清空客户端任务队列，更新会话代数并停止播放；当前没有发送服务端取消请求，也没有对进行中的 HTTP 请求设置取消信号。

旧请求完成后，其音频可能被丢弃。停止后立即启动新朗读时，旧请求与新请求可能重叠。服务器应支持并发安全或排队，尤其避免共享模型切换导致串音色。

建议：为 GPU 推理设置有界队列，对共享模型状态加锁，限制输入长度与请求资源占用，避免跨请求复用同一个可覆盖的输出文件。

依据：[停止行为](../modules/SovitsTTS.js:786)、[新朗读入口](../modules/ipc/sovitsHandlers.js:29)。

### 6.3 合成缓存对联调的影响

本地音频缓存在 [TTS 缓存目录](../AppData/tts_cache)，扩展名为 MP3。缓存键由模式、基础地址、文本、音色、语速及导演提示词签名组合生成。

命中缓存时不会请求服务器。缓存没有纳入密钥、服务器模型权重版本或音色内部配置版本；同一个音色 ID 更换权重后，客户端可能继续播放旧音频。

联调建议使用不同测试文本，或只删除对应 TTS 缓存；发布新音色版本时可以使用新的稳定音色 ID。不要把“服务端没有收到重复请求”直接判为接口失效。

依据：[缓存键和读取](../modules/SovitsTTS.js:430)。

## 7. 新推理服务器的推荐兼容层

建议分为三层：

1. **HTTP 兼容层**：接受固定版本标签、两个 POST 路由、Bearer 鉴权和中文参数标签。
2. **音色注册表**：稳定音色 ID 映射到真实引擎、权重、说话人、参考音频、参考文本及默认语言。
3. **推理执行层**：验证输入，排队执行推理，应用语速，编码 MP3，并直接返回二进制。

列表与推理必须使用同一音色注册表：任何对外列出的音色都应可以合成。不支持的后端参数可以在兼容层映射或使用明确的默认策略，但不能因为不是 SoVITS 算法就拒绝固定的兼容版本标签。

## 8. 联调示例与验收清单

### 8.1 Windows 命令行请求

以下命令可在 Windows cmd 中执行；模型列表无鉴权示例：

```bat
curl.exe -i -X POST "http://127.0.0.1:8000/models" -H "Content-Type: application/json" -d "{\"version\":\"v2ProPlus\"}"
```

合成示例，替换为列表中实际存在的音色值：

```bat
curl.exe --fail-with-body -X POST "http://127.0.0.1:8000/v1/audio/speech" -H "Content-Type: application/json" -d "{\"model\":\"tts-v2ProPlus\",\"input\":\"你好，这是兼容测试。\",\"voice\":\"speaker_zh_001\",\"response_format\":\"mp3\",\"speed\":1.0,\"other_params\":{\"text_lang\":\"中英混合\",\"prompt_lang\":\"中文\",\"emotion\":\"默认\",\"text_split_method\":\"按标点符号切\"}}" --output "tts-compat-test.mp3"
```

有鉴权时在两个命令中增加请求头：

```bat
-H "Authorization: Bearer your-secret-key"
```

先确认返回状态和媒体类型，再验证输出音频能播放。上述 curl 验证只能确认服务端 HTTP 行为，最终还需在 VCPChat 内完成列表刷新和实际朗读。

### 8.2 验收清单

- [ ] URL 留空且服务监听 8000 时可连接；使用其他端口时显式配置 URL。
- [ ] 接受固定的模型列表版本标签和合成引擎标签。
- [ ] 模型列表成功消息精确为“获取成功”，且列表结构可生成下拉选项。
- [ ] 列表中每个实际音色值均能合成，刷新后 ID 保持稳定。
- [ ] 只提交当前四个附加参数也能正常推理，未强制要求旧脚本高级参数。
- [ ] 成功响应为完整 MP3 二进制，类型为 audio/mpeg。
- [ ] 中文、中英混合、日语分支以及主副音色切换均按预期工作。
- [ ] 0.5、1.0、2.0 倍语速由服务器生效，没有再次播放变速。
- [ ] 密钥为空和非空两种配置均按预期工作，错误密钥返回明确错误。
- [ ] 使用新文本验证实际请求，避免被客户端音频缓存掩盖。
- [ ] 切换服务后强制刷新音色列表，避免复用另一台服务器的缓存。
- [ ] 长文本多次请求、停止后重新朗读和重叠请求没有串音色或输出覆盖。
- [ ] 推理失败不返回音频类型的 JSON，也不返回任务 ID 让客户端等待轮询。

## 9. 与仓库旧示例的区别

仓库中的 [旧 API 说明](../SovitsTest/README.md)、[旧列表脚本](../SovitsTest/get_models.py) 和 [旧合成脚本](../SovitsTest/test_sovits_api.py) 使用 v4 示例；**当前运行客户端使用 v2ProPlus**。旧示例不能代替本文描述的当前请求。

此外，[旧 GSVI 服务的鉴权](../SovitsTest/GSVI.py:297) 检查请求体附加参数中的密钥，而当前客户端发送 Bearer 请求头。新服务器应遵循当前客户端行为，不要照搬旧鉴权要求。

[旧 GSVI 服务启动参数](../SovitsTest/GSVI.py:419) 默认端口为 8001，也不代表客户端要求 8001。客户端默认 8000、界面示例 9880、旧服务脚本默认 8001 是三个不同概念。