# MiMo 2.5 TTS 本地测试台

这是一个用于测试 DMXAPI MiMo 2.5 TTS 的本地网页项目。浏览器只访问本地后端，API Key 从 `.env` 读取，不会暴露到前端静态代码。

## 功能

- 支持三种合成模式：
  - 预置音色：`mimo-v2.5-tts`
  - 自然语言音色设计：`mimo-v2.5-tts-voicedesign`
  - 参考音频音色克隆：`mimo-v2.5-tts-voiceclone`
- 服务端根据模式自动选择模型，无需手动填写模型后缀。
- 支持自然语言控制和“角色 / 场景 / 指导”导演模板；导演模式是提示词写法，不是第四个模型。
- 预置音色支持：`mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`。
- 服务端实时解析 DMXAPI SSE，并继续以 SSE 向浏览器转发 PCM16 音频块。
- 浏览器将 24kHz PCM16LE 单声道数据封装为可播放、可下载的 WAV。
- 支持 MiMo 2.5 圆括号风格语法和方括号行内控制标签。
- 唱歌模式自动校验，禁止与其他风格混用。
- 音色克隆参考音频只随合成请求发送，不会保存到本地磁盘。

## 安装和启动

### 1. 安装依赖

```bash
npm install
```

### 2. 创建环境配置

复制 `.env.example` 为 `.env`，填入真实 API Key：

```env
PORT=3460
MIMO_API_KEY=sk-你的真实密钥
MIMO_API_URL=https://www.dmxapi.cn/v1/chat/completions
MIMO_MODEL=mimo-v2.5-tts
```

默认示例使用 DMXAPI。使用小米 MiMo 官方 Key 时，将 Key 和端点一起替换：

```env
MIMO_API_KEY=sk-你的小米官方密钥
MIMO_API_URL=https://api.xiaomimimo.com/v1
MIMO_MODEL=mimo-v2.5-tts
```

官方 Python 示例把 `/v1` 作为 OpenAI SDK 的 `base_url`，SDK 会自动追加 `/chat/completions`。本项目使用原生 `fetch`，但服务端也会自动补全该路径，因此基础 URL 和完整 URL 两种配置都可使用。

请求体和 Bearer 认证协议基本兼容，所以无需修改服务端代码。但 Key 与 URL 必须属于同一家服务；不同平台的限流、模型开放范围、错误格式和网关超时策略可能不同。

`MIMO_MODEL` 应填写基础模型。服务端会自动按模式派生：

| 页面模式 | 实际模型 |
| --- | --- |
| `preset` | `mimo-v2.5-tts` |
| `voicedesign` | `mimo-v2.5-tts-voicedesign` |
| `voiceclone` | `mimo-v2.5-tts-voiceclone` |

即使误将 `MIMO_MODEL` 配置为带 `-voicedesign` 或 `-voiceclone` 的名称，服务端也会先移除后缀，再按当前模式重新派生。

### 3. 启动

```bash
npm run dev
```

打开：

```text
http://localhost:3460
```

也可以双击 `start.bat`。

## 自然语言与导演模式

自然语言控制内容放在 `role: user` 的消息中，不会出现在最终语音里。可以直接写一句话，也可以使用更精细的导演结构：

```text
角色：
描述人物身份、性格底色、外形气质与说话习惯。

场景：
描述时间、地点、事件、对话对象及当前情绪。

指导：
描述语速、气息、停顿、重音、共鸣位置、音色质感与情绪起伏。
- 语速与顿挫：
- 气声与实声：
- 咬字与重音：
```

导演模式不是独立 API 模型：

- 预置音色仍使用 `mimo-v2.5-tts`。
- 音色克隆仍使用 `mimo-v2.5-tts-voiceclone`。
- 音色设计仍使用 `mimo-v2.5-tts-voicedesign`，其 `user` 消息为必填，可采用导演结构详细描述声线与表演。

页面中的“导演模板”按钮会把该结构填入自然语言指令编辑器。

## 三种模式

### 预置音色

页面选择预置音色。语气描述是可选项，不会被朗读。上游请求使用：

```json
{
  "model": "mimo-v2.5-tts",
  "messages": [
    {
      "role": "user",
      "content": "明亮、轻快、语速稍快"
    },
    {
      "role": "assistant",
      "content": "(开心 变快)今天是个好天气，[轻笑]我们出去走走吧。"
    }
  ],
  "audio": {
    "format": "pcm16",
    "voice": "冰糖"
  },
  "stream": true
}
```

### 自然语言音色设计

“音色设计描述”为必填项。服务端自动使用 `mimo-v2.5-tts-voicedesign`，并可传递 `optimize_text_preview`。该模型虽然兼容 SSE，但上游可能在推理完成后一次性返回整个音频块。

### 参考音频音色克隆

上传 WAV 或 MP3 参考音频后，浏览器转换为 Data URI 发送给本地服务端。服务端自动使用 `mimo-v2.5-tts-voiceclone`。

限制：

- 仅支持 WAV 和 MP3。
- MIME 类型必须和文件真实格式一致。
- Base64 编码后的参考音频不能超过 10 MB。
- 该模型虽然兼容 SSE，但上游可能在推理完成后一次性返回整个音频块。

## MiMo 2.5 文本语法

- 开头风格：`(开心 变快)正文`
- 开头风格括号支持半角 `()`、全角 `（）` 或方括号 `[]`；页面独立风格输入框统一生成半角圆括号。
- 多种风格：写在同一对圆括号中。
- 行内控制：`[吸气]`、`[深呼吸]`、`[叹气]`、`[紧张]`、`[激动]`、`[疲惫]`、`[颤抖]`、`[气声]`、`[笑]`、`[轻笑]`、`[抽泣]`、`[哽咽]`
- 唱歌：`(唱歌)`、`(sing)` 或 `(singing)`，且不能和其他风格混用。
- 待合成正文始终放在 `assistant` 消息中。

## 本地接口

### `GET /api/config`

返回可选音色、模式、实际模型映射、采样率和可视化标签配置。

### `POST /api/tts`

接收页面参数并返回 `text/event-stream`：

- `start`：文件名、采样率、模型和脱敏后的请求预览。
- `audio`：Base64 编码的 PCM16LE 音频块。
- `done`：流结束和总块数。
- `error`：流建立后的结构化错误。

如果错误发生在 SSE 响应建立前，则返回普通 JSON 错误及对应 HTTP 状态码。

## 安全说明

- 不要提交 `.env`。
- API Key 仅由 Node.js 服务端读取。
- `start` 事件不会包含音色克隆参考音频内容。
- 客户端断开时，服务端会取消尚未完成的上游请求。