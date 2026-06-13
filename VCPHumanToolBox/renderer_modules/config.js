// renderer_modules/config.js
// VCPHumanToolBox工具定义
// 最后更新: 2026-04-21by CodeCC &赵枫
// 备份: config.js.bak.20260421
// 工具总数: 46 (原39+ 新增7)

// --- 工具定义 ---
export const tools = {
    // ========================================
    // 多媒体生成类
    // ========================================
    'ZImageGen': {
        displayName: '通义Qwen 生图',
        description: '国产生图开源模型，性能不错，支持NSFW。[后端插件: ZImageGen]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于图片生成的详细提示词。' },
            { name: 'resolution', type: 'select', required: false, options: ['1024x1024', '1280x720', '720x1280', '1152x864', '864x1152'], default: '1024x1024' },
            { name: 'steps', type: 'number', required: false, placeholder: '推荐8-20步' },
            { name: 'showbase64', type: 'checkbox', required: false, default: false }
        ]
    },
    'ZImageTurboGen': {
        displayName: 'Z-Image-Turbo 图片生成/编辑/合成',
        description: '使用 Z-Image-Turbo 生成、编辑或合成图片。支持中文和英文提示词。[后端插件: ZImageTurboGen]',
        commands: {
            'generate': {
                description: '生成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'size', type: 'select', required: false, options: ['1024x1024', '1024x768', '768x1024', '1024x576', '576x1024', '2048x2048', '2048x1536', '1536x2048', '2048x1152', '1152x2048', '2048x1280', '1280x2048'], default: '1024x1024', description: '图片分辨率或比例' },
                    { name: 'negative_prompt', type: 'textarea', required: false, placeholder: '(可选) 不希望出现的内容，例如模糊、低质量、变形、错误文字等。只有Zimage支持该功能。' },
                    { name: 'num_inference_steps', type: 'number', required: false, min: 4, max: 25, default: 9, placeholder: '推理步数，范围 4-25，默认 9' },
                    { name: 'seed', type: 'number', required: false, default: 0, placeholder: '随机种子，默认 0' }
                ]
            },
            'edit': {
                description: '编辑图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(编辑/合成时必需) 单图URL/base64/data URI，或图片数组，例如["url1","url2"]。也兼容image_url、image_1、image_2、image_url_1、image_base64_1等字段。' },
                    { name: 'negative_prompt', type: 'textarea', required: false, placeholder: '(可选) 不希望出现的内容，例如模糊、低质量、变形、错误文字等。只有Zimage支持该功能。' },
                    { name: 'num_inference_steps', type: 'number', required: false, min: 4, max: 25, default: 9, placeholder: '推理步数，范围 4-25，默认 9' },
                    { name: 'seed', type: 'number', required: false, default: 0, placeholder: '随机种子，默认 0' }
                ]
            },
            'compose': {
                description: '合成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(编辑/合成时必需) 单图URL/base64/data URI，或图片数组，例如["url1","url2"]。也兼容image_url、image_1、image_2、image_url_1、image_base64_1等字段。' },
                    { name: 'negative_prompt', type: 'textarea', required: false, placeholder: '(可选) 不希望出现的内容，例如模糊、低质量、变形、错误文字等。只有Zimage支持该功能。' },
                    { name: 'num_inference_steps', type: 'number', required: false, min: 4, max: 25, default: 9, placeholder: '推理步数，范围 4-25，默认 9' },
                    { name: 'seed', type: 'number', required: false, default: 0, placeholder: '随机种子，默认 0' }
                ],
                dynamicImages: true
            }
        }
    },
    'FluxGen': {
        displayName: 'Flux 图片生成',
        description: '艺术风格多变，仅支持英文提示词。[后端插件: FluxGen]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'prompt', type: 'textarea', required: true, placeholder: '详细的英文提示词' },
            { name: 'resolution', type: 'select', required: true, options: ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280'] }
        ]
    },
    'DoubaoGen': {
        displayName: '豆包 AI 图片生成/编辑/合成',
        description: '使用豆包模型生成、编辑或合成图片。国产强图像模型，字体/中文排版/海报类任务表现强。[后端插件: DoubaoGen]',
        commands: {
            'generate': {
                description: '生成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'size', type: 'text', required: false, placeholder: '(可选) 图片尺寸，如2K、4K、2048x2048、adaptive等，建议不低于2K', default: '2K', description: '图片分辨率或比例' }
                ]
            },
            'edit': {
                description: '编辑图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(编辑/合成时必需) 单图URL/base64/data URI，或图片数组，例如["url1","url2"]。也兼容image_url、image_1、image_2、image_url_1、image_base64_1等字段。' },
                    { name: 'size', type: 'text', required: false, placeholder: '(可选) 图片尺寸，如2K、4K、2048x2048、adaptive等', default: '2K', description: '图片分辨率或比例' },
                    { name: 'guidance_scale', type: 'number', required: false, placeholder: '范围0-10，值越小越相似。' }
                ]
            },
            'compose': {
                description: '合成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(编辑/合成时必需) 单图URL/base64/data URI，或图片数组，例如["url1","url2"]。也兼容image_url、image_1、image_2、image_url_1、image_base64_1等字段。' },
                    { name: 'size', type: 'text', required: false, placeholder: '(可选) 图片尺寸，如2K、4K、2048x2048、adaptive等', default: 'adaptive', description: '图片分辨率或比例' },
                    { name: 'guidance_scale', type: 'number', required: false, placeholder: '范围0-10，值越小越相似。' }
                ],
                dynamicImages: true
            }
        }
    },
    'QwenImageGen': {
        displayName: '千问图片生成',
        description: '国产新星，文字排版能力不输豆包哦。[后端插件: QwenImageGen]',
        commands: {
            'GenerateImage': {
                description: '生成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于图片生成的详细提示词。' },
                    { name: 'negative_prompt', type: 'textarea', required: false, placeholder: '(可选) 负向提示词。' },
                    { name: 'image_size', type: 'select', required: false, options: ["1328x1328", "1664x928", "928x1664", "1472x1140", "1140x1472", "1584x1056", "1056x1584"], placeholder: '(可选) 图片分辨率' }
                ]
            }
        }
    },
    'GeminiImageGen': {
        displayName: 'Gemini 图像生成',
        description: '使用 Google Gemini 模型进行图像生成和编辑，支持英文提示词。[后端插件: GeminiImageGen]',
        commands: {
            'generate': {
                description: '生成全新图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '详细的英文提示词，描述想生成的图片内容、风格和细节' }
                ]
            },
            'edit': {
                description: '编辑现有图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '英文编辑指令，如: Add a llama next to the person' },
                    { name: 'image_url', type: 'dragdrop_image', required: true, placeholder: '要编辑的图片（支持拖拽、URL、file://路径）' }
                ]
            }
        }
    },
    'NovelAIGen': {
        displayName: 'NovelAI 动漫生图',
        description: 'NovelAI Diffusion 4.5 Full模型，专精高质量动漫风格。需NovelAI订阅。[后端插件: NovelAIGen]',
        commands: {
            'NovelAIGenerateImage': {
                description: '生成动漫风格图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '详细英文提示词，动漫风格' },
                    { name: 'resolution', type: 'select', required: true, options: ['832x1216', '1216x832', '1024x1024', '1024x1536', '1536x1024', '512x768', '768x512', '640x640', '1472x1472', '1088x1920', '1920x1088'], description: '分辨率（NORMAL推荐832x1216）' }
                ]
            }
        }
    },
    'ComfyCloudGen': {
        displayName: 'Comfy Cloud 云端生图',
        description: '通过云端GPU生成图像/视频，895+模型，支持LoRA。三种模式：auto/template/raw。超时3分钟。[后端插件: ComfyCloudGen]',
        commands: {
            'GenerateImage': {
                description: '云端生成图像或视频',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '英文正面提示词（auto/template模式必需）' },
                    { name: 'negative_prompt', type: 'textarea', required: false, placeholder: '英文负面提示词' },
                    { name: 'unet', type: 'text', required: false, placeholder: 'UNet模型名，如z_image_bf16.safetensors（触发auto模式）' },
                    { name: 'checkpoint', type: 'text', required: false, placeholder: 'Checkpoint模型名（触发auto模式）' },
                    { name: 'lora', type: 'text', required: false, placeholder: 'LoRA文件名' },
                    { name: 'lora_strength', type: 'number', required: false, placeholder: 'LoRA强度，默认0.8' },
                    { name: 'width', type: 'number', required: false, placeholder: '宽度，默认1024' },
                    { name: 'height', type: 'number', required: false, placeholder: '高度，默认1024' },
                    { name: 'steps', type: 'number', required: false, placeholder: '采样步数' },
                    { name: 'cfg', type: 'number', required: false, placeholder: 'CFG引导强度' },
                    { name: 'seed', type: 'number', required: false, placeholder: '随机种子，-1为随机' },
                    { name: 'workflow', type: 'text', required: false, placeholder: '模板名称（触发template模式）' },
                    { name: 'load_cached', type: 'text', required: false, placeholder: '从缓存加载工作流' },
                    { name: 'save_as', type: 'text', required: false, placeholder: '保存工作流到缓存' }
                ]
            }
        }
    },
    'SunoGen': {
        displayName: 'Suno 音乐生成',
        description: '强大的Suno音乐生成器。[后端插件: SunoGen]',
        commands: {
            'generate_song': {
                description: '生成歌曲或纯音乐',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'mode', type: 'radio', options: ['lyrics', 'instrumental'], default: 'lyrics', description: '生成模式' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '[Verse 1]\nSunlight on my face...', dependsOn: { field: 'mode', value: 'lyrics' } },
                    { name: 'tags', type: 'text', required: false, placeholder: 'acoustic, pop, happy', dependsOn: { field: 'mode', value: 'lyrics' } },
                    { name: 'title', type: 'text', required: false, placeholder: 'Sunny Days', dependsOn: { field: 'mode', value: 'lyrics' } },
                    { name: 'gpt_description_prompt', type: 'textarea', required: true, placeholder: '一首关于星空和梦想的安静钢琴曲', dependsOn: { field: 'mode', value: 'instrumental' } }
                ]
            }
        }
    },
    'WanVideoGen': {
        displayName: 'Wan视频生成',
        description: '基于强大的Wan系列模型生成视频。[后端插件: VideoGenerator]',
        commands: {
            'submit': {
                description: '提交新视频任务',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'mode', type: 'radio', options: ['i2v', 't2v'], default: 't2v', description: '生成模式' },
                    { name: 'image_url', type: 'text', required: true, placeholder: 'http://example.com/cat.jpg', dependsOn: { field: 'mode', value: 'i2v' } },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '一只猫在太空漫步', dependsOn: { field: 'mode', value: 't2v' } },
                    { name: 'resolution', type: 'select', required: true, options: ['1280x720', '720x1280', '960x960'], dependsOn: { field: 'mode', value: 't2v' } }
                ]
            },
            'query': {
                description: '查询任务状态',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'request_id', type: 'text', required: true, placeholder: '任务提交后返回的ID' }
                ]
            }
        }
    },
    'GrokVideoGen': {
        displayName: 'Grok 视频生成',
        description: '马斯克家的图生视频大模型，超快且含配音。[后端插件: GrokVideo]',
        commands: {
            'submit': {
                description: '提交视频任务',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'image_url', type: 'dragdrop_image', required: true, placeholder: '必需，要有底图' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '英文提示词描述内容，支持配音' },
                    { name: 'video_url', type: 'text', required: false, placeholder: '可选，用于视频续写' }
                ]
            },
            'concat': {
                description: '视频拼接',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'video_urls', type: 'textarea', required: true, placeholder: '每行一个视频URL' }
                ],
                dynamicParams: true
            }
        }
    },
    'WebUIGen': {
        displayName: '喵喵 WebUI',
        description: '每一路模型独立部署，支持多种艺术风格。[后端插件: WebUIGen]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'prompt', type: 'textarea', required: true, placeholder: '生成提示词' },
            { name: 'negative_prompt', type: 'textarea', required: false, placeholder: '负面提示词' },
            { name: 'resolution', type: 'text', required: false, placeholder: '如 1024x1024, landscape', default: '512x512' },
            { name: 'steps', type: 'number', required: false, default: 20 },
            { name: 'cfg', type: 'number', required: false, default: 7.0 },
            { name: 'model_index', type: 'number', required: false, default: 0 },
            { name: 'showbase64', type: 'checkbox', required: false, default: false }
        ]
    },
    'ComfyUIGen': {
        displayName: 'ComfyUI 生成',
        description: '使用本地 ComfyUI 后端进行图像生成。[后端插件: ComfyUIGen]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'prompt', type: 'textarea', required: true, placeholder: '图像生成的正面提示词' },
            { name: 'negative_prompt', type: 'textarea', required: false, placeholder: '额外的负面提示词' },
            { name: 'workflow', type: 'text', required: false, placeholder: '例如: text2img_basic, text2img_advanced' },
            { name: 'width', type: 'number', required: false, placeholder: '默认使用用户配置的值' },
            { name: 'height', type: 'number', required: false, placeholder: '默认使用用户配置的值' }
        ]
    },
    'NanoBananaGen2': {
        displayName: 'NanoBanana 图片生成/编辑/合成 (V2)',
        description: '顶级图像编辑AI，适合长描述、复杂修图、多图参考和角色一致性任务，支持中英文。[后端插件: NanoBananaGen2]',
        commands: {
            'generate': {
                description: '生成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'size', type: 'select', required: false, options: ['1K', '2K', '4K'], default: '2K', description: '图片分辨率或比例' }
                ]
            },
            'edit': {
                description: '编辑图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(编辑/合成时必需) 单图URL/base64/data URI，或图片数组，例如["url1","url2"]。也兼容image_url、image_1、image_2、image_url_1、image_base64_1等字段。' },
                    { name: 'size', type: 'select', required: false, options: ['1K', '2K', '4K'], default: '2K', description: '图片分辨率或比例' }
                ]
            },
            'compose': {
                description: '合成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(编辑/合成时必需) 单图URL/base64/data URI，或图片数组，例如["url1","url2"]。也兼容image_url、image_1、image_2、image_url_1、image_base64_1等字段。' },
                    { name: 'size', type: 'select', required: false, options: ['1K', '2K', '4K'], default: '2K', description: '图片分辨率或比例' }
                ],
                dynamicImages: true
            }
        }
    },
    'GPTImageGen': {
        displayName: 'GPT 图片生成/编辑/合成',
        description: 'OpenAI超大参数图片编辑模型，适合通用生成与编辑，但昂贵而缓慢。[后端插件: GPTImageGen]',
        commands: {
            'generate': {
                description: '生成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'size', type: 'select', required: false, options: ['1024x1024', '1536x1024', '1024x1536'], default: '1024x1024', description: '图片分辨率或比例' }
                ]
            },
            'edit': {
                description: '编辑图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(编辑/合成时必需) 单图URL/base64/data URI，或图片数组，例如["url1","url2"]。也兼容image_url、image_1、image_2、image_url_1、image_base64_1等字段。' },
                    { name: 'size', type: 'select', required: false, options: ['1024x1024', '1536x1024', '1024x1536'], default: '1024x1024', description: '图片分辨率或比例' }
                ]
            },
            'compose': {
                description: '合成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于生成、编辑或合成图片的自然语言描述，支持中文或英文。纯文本描述即可，不需要特殊格式。' },
                    { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(编辑/合成时必需) 单图URL/base64/data URI，或图片数组，例如["url1","url2"]。也兼容image_url、image_1、image_2、image_url_1、image_base64_1等字段。' },
                    { name: 'size', type: 'select', required: false, options: ['1024x1024', '1536x1024', '1024x1536'], default: '1024x1024', description: '图片分辨率或比例' }
                ],
                dynamicImages: true
            }
        }
    },

    // ========================================
    // 工具类
    // ========================================
    'SciCalculator': {
        displayName: '科学计算器',
        description: '支持基础运算、函数、统计和微积分。[后端插件: SciCalculator]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'expression', type: 'textarea', required: true, placeholder: "例如: integral('x**2', 0, 1)" }
        ]
    },
    'DomainSafetyChecker': {
        displayName: '域名/URL 安全核查',
        description: '对 URL 或域名执行低交互、静态、非侵入式安全核查，返回适合直接展示给用户的 Markdown 报告，并附完整 JSON 证据。不会执行 JavaScript、提交表单、爆破、端口扫描或绕过访问控制。[后端插件: DomainSafetyChecker]',
        params: [
            { name: 'target', type: 'text', required: true, placeholder: 'https://example.com/login 或 example.com', description: '要核查的 URL 或域名；也兼容 url/domain 字段。' },
            { name: 'timeout', type: 'number', required: false, default: 12, min: 1, max: 60, placeholder: '12', description: '网络请求超时秒数；普通检查建议 8-15，网络较慢可用 20-30。' },
            { name: 'maxBytes', type: 'number', required: false, default: 2000000, placeholder: '2000000', description: '单次 HTTP 最多读取字节数；也兼容 max_bytes。' },
            { name: 'defaultScheme', type: 'select', required: false, options: ['https', 'http'], default: 'https', description: '裸域名输入时默认协议；也兼容 default_scheme。' },
            { name: 'fetchScripts', type: 'checkbox', required: false, default: false, description: '是否额外下载外部 JS 做静态扫描；更全面但更慢，也兼容 fetch_scripts。' },
            { name: 'noTls', type: 'checkbox', required: false, default: false, description: '跳过 TLS 证书检查；也兼容 no_tls。' },
            { name: 'noHttp', type: 'checkbox', required: false, default: false, description: '跳过明文 HTTP 探测；也兼容 no_http。' },
            { name: 'getHttp', type: 'checkbox', required: false, default: false, description: '明文 HTTP 也使用 GET；默认只用 HEAD 以降低交互，也兼容 get_http。' },
            { name: 'whois', type: 'checkbox', required: false, default: false, description: '尝试调用系统 whois 命令；未安装时会在报告中记录不可用。' },
            { name: 'includeJson', type: 'checkbox', required: false, default: true, description: '在 Markdown 报告末尾附加完整原始 JSON 结构化结果；建议保留，也兼容 include_json。' },
            { name: 'proxyEnabled', type: 'checkbox', required: false, default: false, description: '仅本次调用覆盖代理启用状态；也兼容 proxy_enabled。' },
            { name: 'proxyUrl', type: 'text', required: false, placeholder: 'http://127.0.0.1:7890', description: '仅本次调用覆盖 config.env 中的代理地址；也兼容 proxy_url。' },
            { name: 'proxyRetryOnFailure', type: 'checkbox', required: false, default: true, description: '直连失败或遇到 403/407/408/429/5xx 时自动代理重试；也兼容 proxy_retry_on_failure。' }
        ]
    },

    // ========================================
    // 联网搜索类
    // ========================================
    'VSearch': {
        displayName: 'V-Search 穿透检索',
        description: 'VCP家语义级穿透联网检索引擎，支持并发检索。[后端插件: VSearch]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'SearchTopic', type: 'text', required: true, placeholder: '研究主题' },
            { name: 'Keywords', type: 'textarea', required: true, placeholder: '多检索词，用逗号隔开' },
            { name: 'SearchMode', type: 'select', required: false, options: ['grounding', 'grok', 'tavily', 'kimisearch'], default: 'grounding' },
            { name: 'ShowURL', type: 'checkbox', required: false, default: false }
        ]
    },
    'TavilySearch': {
        displayName: 'Tavily 联网搜索',
        description: '专业的联网搜索API。[后端插件: TavilySearch]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'query', type: 'text', required: true, placeholder: '搜索的关键词 or 问题' },
            { name: 'topic', type: 'text', required: false, placeholder: "general, news, finance..." },
            { name: 'max_results', type: 'number', required: false, placeholder: '10(范围 5-100)' },
            { name: 'include_raw_content', type: 'select', required: false, options: ['', 'text', 'markdown'] },
            { name: 'start_date', type: 'text', required: false, placeholder: 'YYYY-MM-DD' },
            { name: 'end_date', type: 'text', required: false, placeholder: 'YYYY-MM-DD' }
        ]
    },
    'AnySearch': {
        displayName: '高级垂直搜索',
        description: '高级垂直搜索插件，支持通用搜索、领域列表、批量搜索与网页正文提取。复杂垂直搜索前建议先调用 list_domains 获取 sub_domain、query_format、params_schema 和 zone 约束。[后端插件: AnySearch]',
        commands: {
            'search': {
                description: '搜索',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'query', type: 'textarea', required: true, placeholder: 'AI regulation 2026。垂直搜索时必须遵循 list_domains 返回的 query_format。也兼容 q、text 字段。' },
                    { name: 'domain', type: 'text', required: false, placeholder: '垂直领域，如 finance、academic、security、code、tech、legal' },
                    { name: 'sub_domain', type: 'text', required: false, placeholder: '子领域路由，如 finance.us_stock、academic.doi、security.cve' },
                    { name: 'sub_domain_params', type: 'textarea', required: false, placeholder: '子领域额外参数，支持 JSON 对象或字符串' },
                    { name: 'content_types', type: 'text', required: false, placeholder: 'web、news、code、doc、academic、data、image、video、audio；支持单值或数组' },
                    { name: 'zone', type: 'select', required: false, options: ['', 'cn', 'intl'], description: '地域约束；当 list_domains 标记 zone=CN 时必须传 cn' },
                    { name: 'max_results', type: 'number', required: false, min: 1, max: 100, placeholder: '结果数量，范围 1-100' },
                    { name: 'freshness', type: 'select', required: false, options: ['', 'day', 'week', 'month', 'year'], description: '时效范围' }
                ]
            },
            'list_domains': {
                description: '列出可用垂直领域',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'domain', type: 'text', required: false, placeholder: '单个垂直领域，如 finance、academic、security、code、tech、legal' },
                    { name: 'domains', type: 'textarea', required: false, placeholder: '批量查询最多 5 个领域，支持字符串或数组；与 domain 二选一' }
                ]
            },
            'batch_search': {
                description: '批量搜索',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'queries', type: 'textarea', required: true, placeholder: '1-5 个查询对象或字符串，支持 JSON 数组或逐行输入' },
                    { name: 'domain', type: 'text', required: false, placeholder: '垂直领域，如 finance、academic、security、code、tech、legal' },
                    { name: 'sub_domain', type: 'text', required: false, placeholder: '子领域路由，如 finance.us_stock、academic.doi、security.cve' },
                    { name: 'sub_domain_params', type: 'textarea', required: false, placeholder: '子领域额外参数，支持 JSON 对象或字符串' },
                    { name: 'content_types', type: 'text', required: false, placeholder: 'web、news、code、doc、academic、data、image、video、audio；支持单值或数组' },
                    { name: 'zone', type: 'select', required: false, options: ['', 'cn', 'intl'], description: '地域约束；当 list_domains 标记 zone=CN 时必须传 cn' },
                    { name: 'max_results', type: 'number', required: false, min: 1, max: 100, placeholder: '结果数量，范围 1-100' },
                    { name: 'freshness', type: 'select', required: false, options: ['', 'day', 'week', 'month', 'year'], description: '时效范围' }
                ]
            },
            'extract': {
                description: '提取网页正文',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'url', type: 'text', required: true, placeholder: '需要提取正文的网页 URL' }
                ]
            }
        }
    },
    'GoogleSearch': {
        displayName: 'Google 搜索',
        description: '进行一次标准的谷歌网页搜索。[后端插件: GoogleSearch]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'query', type: 'text', required: true, placeholder: '如何学习编程？' }
        ]
    },
    'SerpSearch': {
        displayName: 'SerpAPI 搜索',
        description: '使用DuckDuckGo搜索引擎进行网页搜索。[后端插件: SerpSearch]',
        commands: {
            'duckduckgo_search': {
                description: 'DuckDuckGo 搜索',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'q', type: 'text', required: true, placeholder: '需要搜索的关键词' },
                    { name: 'kl', type: 'text', required: false, placeholder: 'us-en' }
                ]
            },
            'google_reverse_image_search': {
                description: '谷歌以图搜图',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'image_url', type: 'dragdrop_image', required: true, placeholder: '本地或远程图片链接' }
                ]
            }
        }
    },
    'UrlFetch': {
        displayName: '网页超级爬虫',
        description: '获取网页的文本内容或快照。[后端插件: UrlFetch]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'url', type: 'text', required: true, placeholder: 'https://example.com' },
            { name: 'mode', type: 'select', required: false, options: ['text', 'snapshot', 'jina', 'image'] }
        ]
    },
    'BilibiliFetch': {
        displayName: 'B站内容获取',
        description: '获取B站视频文本、弹幕、评论及快照。[后端插件: BilibiliFetch]',
        commands: {
            'fetch': {
                description: '获取视频内容',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'url', type: 'text', required: true, placeholder: 'Bilibili 视频的URL' },
                    { name: 'lang', type: 'text', required: false, placeholder: 'ai-zh' },
                    { name: 'danmaku_num', type: 'number', required: false, default: 0 },
                    { name: 'comment_num', type: 'number', required: false, default: 0 },
                    { name: 'snapshots', type: 'text', required: false, placeholder: '10,60,120' },
                    { name: 'hd_snapshot', type: 'checkbox', required: false, default: false },
                    { name: 'need_subs', type: 'checkbox', required: false, default: true }
                ]
            },
            'search': {
                description: '搜索视频/用户',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'keyword', type: 'text', required: true },
                    { name: 'search_type', type: 'select', options: ['video', 'bili_user'], default: 'video' },
                    { name: 'page', type: 'number', default: 1 }
                ]
            },
            'get_up_videos': {
                description: '获取UP主视频列表',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'mid', type: 'text', required: true },
                    { name: 'pn', type: 'number', default: 1 },
                    { name: 'ps', type: 'number', default: 30 }
                ]
            }
        }
    },
    'FlashDeepSearch': {
        displayName: '深度信息研究',
        description: '进行深度主题搜索，返回研究论文。[后端插件: FlashDeepSearch]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'SearchContent', type: 'textarea', required: true, placeholder: '希望研究的主题内容' },
            { name: 'SearchBroadness', type: 'number', required: false, placeholder: '7(范围 5-20)' }
        ]
    },
    'AnimeFinder': {
        displayName: '番剧名称查找',
        description: '通过图片找原始番剧名字工具。[后端插件: AnimeFinder]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'imageUrl', type: 'dragdrop_image', required: true, placeholder: '可以是任意类型url比如http或者file' }
        ]
    },

    // ========================================
    // Git 代码托管平台搜索
    // ========================================
    'GitSearch': {
        displayName: 'Git 代码搜索',
        description: '聚合 GitHub/GitLab/Gitee 三大代码托管平台的读取操作。[后端插件: GitSearch]',
        commands: {
            'repo_get': {
                description: '获取仓库基本信息',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'platform', type: 'select', required: true, options: ['github', 'gitlab', 'gitee'], description: '平台' },
                    { name: 'repo_owner', type: 'text', required: true, placeholder: '仓库所有者，如 lioensky' },
                    { name: 'repo_name', type: 'text', required: true, placeholder: '仓库名称，如 VCPToolBox' }
                ]
            },
            'repo_list_files': {
                description: '浏览目录或读取文件内容',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'platform', type: 'select', required: true, options: ['github', 'gitlab', 'gitee'], description: '平台' },
                    { name: 'repo_owner', type: 'text', required: true, placeholder: '仓库所有者' },
                    { name: 'repo_name', type: 'text', required: true, placeholder: '仓库名称' },
                    { name: 'path', type: 'text', required: false, placeholder: '文件或目录路径，留空列出根目录' },
                    { name: 'ref', type: 'text', required: false, placeholder: '分支/tag/SHA，默认主分支' }
                ]
            },
            'repo_search_code': {
                description: '搜索仓库中的代码（仅GitHub支持）',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'platform', type: 'select', required: true, options: ['github'], description: '平台（仅GitHub）' },
                    { name: 'repo_owner', type: 'text', required: true, placeholder: '仓库所有者' },
                    { name: 'repo_name', type: 'text', required: true, placeholder: '仓库名称' },
                    { name: 'query', type: 'text', required: true, placeholder: '搜索关键词' }
                ]
            },
            'issue_list': {
                description: '列出仓库的 Issues',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'platform', type: 'select', required: true, options: ['github', 'gitlab', 'gitee'], description: '平台' },
                    { name: 'repo_owner', type: 'text', required: true, placeholder: '仓库所有者' },
                    { name: 'repo_name', type: 'text', required: true, placeholder: '仓库名称' },
                    { name: 'state', type: 'select', required: false, options: ['', 'open', 'closed', 'all'], description: '状态筛选' },
                    { name: 'per_page', type: 'number', required: false, placeholder: '每页数量，默认30' }
                ]
            },
            'pr_list': {
                description: '列出 Pull Requests',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'platform', type: 'select', required: true, options: ['github', 'gitlab', 'gitee'], description: '平台' },
                    { name: 'repo_owner', type: 'text', required: true, placeholder: '仓库所有者' },
                    { name: 'repo_name', type: 'text', required: true, placeholder: '仓库名称' },
                    { name: 'state', type: 'select', required: false, options: ['', 'open', 'closed', 'all'], description: '状态筛选' }
                ]
            },
            'pr_get_diff': {
                description: '获取 PR 的文件变更',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'platform', type: 'select', required: true, options: ['github', 'gitlab', 'gitee'], description: '平台' },
                    { name: 'repo_owner', type: 'text', required: true, placeholder: '仓库所有者' },
                    { name: 'repo_name', type: 'text', required: true, placeholder: '仓库名称' },
                    { name: 'pr_number', type: 'number', required: true, placeholder: 'PR 编号' }
                ]
            }
        }
    },

    // ========================================
    // DeepWiki AI仓库文档引擎
    // ========================================
    'DeepWikiVCP': {
        displayName: 'DeepWiki 仓库问答',
        description: '通过 DeepWiki AI 获取GitHub公开仓库的智能文档和问答。[后端插件: DeepWikiVCP]',
        commands: {
            'wiki_structure': {
                description: '查看仓库的AI文档目录',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'url', type: 'text', required: true, placeholder: 'owner/repo 格式，如 lioensky/VCPToolBox' }
                ]
            },
            'wiki_content': {
                description: '读取完整AI文档（内容较长，慎用）',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'url', type: 'text', required: true, placeholder: 'owner/repo 格式' }
                ]
            },
            'wiki_ask': {
                description: '向AI提问关于仓库的问题（最常用）',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'url', type: 'text', required: true, placeholder: 'owner/repo（多仓库逗号分隔，最多10个）' },
                    { name: 'question', type: 'textarea', required: true, placeholder: '你想问的问题' },
                    { name: 'deep_research', type: 'checkbox', required: false, default: false, description: '启用深度研究模式' }
                ]
            }
        }
    },

    // ========================================
    // 学术研究
    // ========================================
    'PubMedSearch': {
        displayName: 'PubMed 文献检索',
        description: '基于NCBI E-utilities的PubMed学术文献检索，支持关键词/作者/期刊/MeSH搜索、全文获取、引用分析和引用导出。[后端插件: PubMedSearch]',
        commands: {
            'search_articles': {
                description: '综合检索 — 按关键词、作者、期刊搜索',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'query', type: 'textarea', required: true, placeholder: '检索表达式，如: cancer immunotherapy' },
                    { name: 'max_results', type: 'number', required: false, placeholder: '默认20（1-1000）' },
                    { name: 'sort', type: 'select', required: false, options: ['', 'relevance', 'pub_date', 'author', 'journal'], description: '排序' },
                    { name: 'date_from', type: 'text', required: false, placeholder: '起始日期 YYYY/MM/DD' },
                    { name: 'date_to', type: 'text', required: false, placeholder: '截止日期 YYYY/MM/DD' }
                ]
            },
            'advanced_search': {
                description: '高级检索 — 标题/摘要/作者/MeSH多字段组合',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'title', type: 'text', required: false, placeholder: '标题关键词' },
                    { name: 'abstract', type: 'text', required: false, placeholder: '摘要关键词' },
                    { name: 'author', type: 'text', required: false, placeholder: '作者名' },
                    { name: 'journal', type: 'text', required: false, placeholder: '期刊名' },
                    { name: 'mesh_terms', type: 'text', required: false, placeholder: 'MeSH术语，JSON数组格式' },
                    { name: 'boolean_operator', type: 'select', required: false, options: ['AND', 'OR'], description: '布尔关系' },
                    { name: 'max_results', type: 'number', required: false, placeholder: '默认20' }
                ]
            },
            'get_trending_articles': {
                description: '趋势文献 — 获取某领域最近的热门论文',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'field', type: 'text', required: true, placeholder: '研究领域，如: single-cell RNA-seq' },
                    { name: 'days', type: 'number', required: false, placeholder: '回溯天数，默认30' },
                    { name: 'max_results', type: 'number', required: false, placeholder: '默认20' }
                ]
            },
            'get_article_details': {
                description: '文章详情 — 按PMID获取完整元数据',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'pmid', type: 'text', required: true, placeholder: 'PubMed ID，如 37912345' }
                ]
            },
            'get_full_text': {
                description: '全文获取 — 通过PMC ID获取开放获取全文',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'pmcid', type: 'text', required: true, placeholder: 'PMC ID，如 PMC1234567' }
                ]
            },
            'get_cited_by': {
                description: '引用分析 — 查看哪些文章引用了该论文',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'pmid', type: 'text', required: true, placeholder: 'PubMed ID' },
                    { name: 'max_results', type: 'number', required: false, placeholder: '默认100' }
                ]
            },
            'export_citation': {
                description: '导出引用 — 生成APA/MLA/BibTeX/RIS格式',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'pmid', type: 'text', required: true, placeholder: 'PubMed ID' },
                    { name: 'format', type: 'select', required: false, options: ['apa', 'mla', 'chicago', 'bibtex', 'ris'], description: '引用格式，默认APA' }
                ]
            }
        }
    },
    'PaperReader': {
        displayName: '论文阅读器',
        description: '超文本递归阅读器（Rust引擎），支持PDF摄入、多模式阅读、证据检索和审核。超时30分钟。[后端插件: PaperReader]',
        commands: {
            'IngestPDF': {
                description: '摄入论文 — 上传PDF到阅读器',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'filePath', type: 'text', required: true, placeholder: '论文路径，如 D:/papers/example.pdf' },
                    { name: 'paperId', type: 'text', required: false, placeholder: '自定义论文ID（可选）' }
                ]
            },
            'Read': {
                description: '自动阅读 — 智能选择阅读模式',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'paperId', type: 'text', required: true, placeholder: '论文ID（摄入时返回）' },
                    { name: 'goal', type: 'textarea', required: false, placeholder: '阅读目标，如:提取核心方法论' },
                    { name: 'forceReread', type: 'checkbox', required: false, default: false, description: '强制重读' }
                ]
            },
            'ReadDeep': {
                description: '深度阅读 — 逐段精读全文',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'paperId', type: 'text', required: true, placeholder: '论文ID' },
                    { name: 'goal', type: 'textarea', required: false, placeholder: '深度阅读目标' }
                ]
            },
            'Query': {
                description: '提问 — 基于论文内容回答',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'paperId', type: 'text', required: true, placeholder: '论文ID' },
                    { name: 'question', type: 'textarea', required: true, placeholder: '你的问题' }
                ]
            },
            'audit_document': {
                description: '审核 — 生成论文审核报告',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'document_id', type: 'text', required: true, placeholder: '论文ID' }
                ]
            }
        }
    },

    // ========================================
    // 塔罗占卜
    // ========================================
    'TarotDivination': {
        displayName: '塔罗占卜',
        description: '融合天文与神秘学的塔罗牌占卜，支持多种牌阵与起源选择。[后端插件: TarotDivination]',
        commands: {
            'draw_single_card': {
                description: '单牌占卜 — 抽取一张塔罗牌',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'fate_check_number', type: 'number', required: false, placeholder: '命运检定数（任意数字）' },
                    { name: 'origin', type: 'select', required: false, options: ['', '日', '月', '星'], description: '☉日=行动☽月=情感 ✦星=智慧' }
                ]
            },
            'draw_three_card_spread': {
                description: '三牌阵 — 过去·现在·未来',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'fate_check_number', type: 'number', required: false, placeholder: '命运检定数' },
                    { name: 'origin', type: 'select', required: false, options: ['', '日', '月', '星'], description: '起源选择' }
                ]
            },
            'draw_celtic_cross': {
                description: '凯尔特十字 — 10张牌完整牌阵',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'fate_check_number', type: 'number', required: false, placeholder: '命运检定数' },
                    { name: 'origin', type: 'select', required: false, options: ['', '日', '月', '星'], description: '起源选择' }
                ]
            },
            'get_celestial_data': {
                description: '天象数据 — 获取实时天文与环境数据',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'origin', type: 'select', required: false, options: ['', '日', '月', '星'], description: '观察视角' }
                ]
            }
        }
    },

    // ========================================
    // 音乐控制
    // ========================================
    'MusicController': {
        displayName: '莱恩家的点歌台',
        description: '播放音乐。[前端分布式: MusicController]',
        commands: {
            'playSong': {
                description: '播放歌曲',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'songname', type: 'text', required: true, placeholder: '星の余韻' }
                ]
            }
        }
    },

    // ========================================
    // VCP通讯插件
    // ========================================
    'AgentAssistant': {
        displayName: '女仆通讯器',
        description: '用于联络别的女仆Agent。[后端插件: AgentAssistant]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'agent_name', type: 'text', required: true, placeholder: '小娜, 小克, Nova...' },
            { name: 'prompt', type: 'textarea', required: true, placeholder: '我是[您的名字]，我想请你...' },
            { name: 'temporary_contact', type: 'checkbox', required: false, default: false }
        ]
    },
    'AgentDream': {
        displayName: '梦境触发器',
        description: '让一位Agent入眠做梦。[后端插件: AgentDream]',
        commands: {
            'triggerDream': {
                description: '触发梦境',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'agent_name', type: 'text', required: true, placeholder: 'Nova' }
                ]
            }
        }
    },
    'AgentMessage': {
        displayName: '主人通讯器',
        description: '向主人设备发送通知消息。[后端插件: AgentMessage]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'message', type: 'textarea', required: true, placeholder: '要发送的消息内容' }
        ]
    },
    'VCPForum': {
        displayName: 'VCP 论坛',
        description: '在VCP论坛上发帖、回帖和读帖。[后端插件: VCPForum]',
        commands: {
            'CreatePost': {
                description: '创建新帖子',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'board', type: 'text', required: true, placeholder: '板块名称' },
                    { name: 'title', type: 'text', required: true, placeholder: '[置顶] 规范流程' },
                    { name: 'content', type: 'textarea', required: true, placeholder: '帖子正文，支持Markdown' }
                ]
            },
            'ReplyPost': {
                description: '回复帖子',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'post_uid', type: 'text', required: true, placeholder: '帖子UID' },
                    { name: 'content', type: 'textarea', required: true, placeholder: '回复内容' }
                ]
            },
            'ReadPost': {
                description: '读取帖子内容',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'post_uid', type: 'text', required: true, placeholder: '帖子UID' }
                ]
            }
        }
    },

    // ========================================
    // 记忆与思考
    // ========================================
    'DeepMemo': {
        displayName: '深度回忆',
        description: '回忆过去的聊天历史。[内置功能: DeepMemo]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'keyword', type: 'text', required: true, placeholder: '多个关键词用空格或逗号分隔' },
            { name: 'window_size', type: 'number', required: false, placeholder: '10(范围 1-20)' }
        ]
    },
    'LightMemo': {
        displayName: '快速回忆',
        description: '主动检索日记本或知识库。[后端插件: LightMemo]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: 'Nova' },
            { name: 'folder', type: 'text', required: false, placeholder: '特定的索引文件夹' },
            { name: 'query', type: 'textarea', required: true, placeholder: '记忆检索内容' },
            { name: 'k', type: 'number', required: false, default: 5 },
            { name: 'rerank', type: 'text', required: false, placeholder: 'true / false / 0.6(RRF融合)' },
            { name: 'tag_boost', type: 'text', required: false, placeholder: '0.6或 0.6+ (浪潮V8)' },
            { name: 'search_all_knowledge_bases', type: 'checkbox', required: false, default: true }
        ]
    },
    'ThoughtClusterManager': {
        displayName: '思维簇管理器',
        description: '创建和编辑思维簇文件。[后端插件: ThoughtClusterManager]',
        commands: {
            'CreateClusterFile': {
                description: '创建新思维簇',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'clusterName', type: 'text', required: true, placeholder: '簇文件夹名称，必须以"簇"结尾' },
                    { name: 'content', type: 'textarea', required: true, placeholder: '【思考模块：模块名】\n【触发条件】：\n【核心功能】：\n【执行流程】：' }
                ]
            },
            'EditClusterFile': {
                description: '编辑已存在的思维簇',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'clusterName', type: 'text', required: false, placeholder: '指定簇文件夹' },
                    { name: 'targetText', type: 'textarea', required: true, placeholder: '需要被替换的旧内容（至少15字）' },
                    { name: 'replacementText', type: 'textarea', required: true, placeholder: '更新后的新内容' }
                ]
            },
            'ListClusters': {
                description: '查看思维簇内容（支持按链名/簇名/全量查看）',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'chainName', type: 'text', required: false, placeholder: '链名如 default, coding, disco（逗号分隔多个）' },
                    { name: 'clusterName', type: 'text', required: false, placeholder: '簇文件夹名（逗号分隔多个）' }
                ]
            }
        }
    },
    'TopicMemo': {
        displayName: '话题回忆',
        description: '回忆具体的聊天话题。[内置功能: TopicMemo]',
        commands: {
            'ListTopics': {
                description: '列出所有话题',
                params: [{ name: 'maid', type: 'text', required: true, placeholder: '你的名字' }]
            },
            'GetTopicContent': {
                description: '获取话题内容',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'topic_id', type: 'text', required: true }
                ]
            }
        }
    },
    'TopicSponsor': {
        displayName: '话题发起人 (TopicSponsor)',
        description: '发起、查询和管理聊天话题。[前端分布式插件: TopicSponsor]',
        commands: {
            'CreateTopic': {
                description: '创建新话题并发起对话',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'topic_name', type: 'text', required: true, placeholder: '话题名称' },
                    { name: 'initial_message', type: 'textarea', required: true, placeholder: '第一句话' }
                ]
            },
            'ReadUnlockedTopics': {
                description: '读取未锁定话题及消息历史',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'include_read', type: 'select', options: ['false', 'true'], description: '是否包含已读' }
                ]
            },
            'CheckNewTopics': {
                description: '检查最近几天的新话题',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'days', type: 'number', required: false, placeholder: '3' }
                ]
            },
            'CheckUnreadMessages': {
                description: '检查未读消息',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' }
                ]
            },
            'ReplyToTopic': {
                description: '在话题中回复消息',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'topic_id', type: 'text', required: true, placeholder: 'topic_xxx' },
                    { name: 'message', type: 'textarea', required: true },
                    { name: 'sender_name', type: 'text', required: true, placeholder: '发送者名' }
                ]
            },
            'CheckTopicOwnership': {
                description: '验证话题所有权',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'topic_id', type: 'text', required: true, placeholder: 'topic_xxx' },
                    { name: 'caller_name', type: 'text', required: true, placeholder: '调用者名' }
                ]
            },
            'ListUnlockedTopics': {
                description: '列出所有未锁定话题',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' }
                ]
            },
            'ReadTopicContent': {
                description: '读取话题完整内容',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'topic_id', type: 'text', required: true, placeholder: 'topic_xxx' }
                ]
            }
        }
    },

    // ========================================
    // 物联网插件
    // ========================================
    'TableLampRemote': {
        displayName: '桌面台灯控制器',
        description: '控制智能台灯的状态。[后端插件: TableLampRemote]',
        commands: {
            'GetLampStatus': {
                description: '获取台灯当前信息',
                params: [{ name: 'maid', type: 'text', required: true, placeholder: '你的名字' }]
            },
            'LampControl': {
                description: '控制台灯',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'power', type: 'select', options: ['', 'True', 'False'], description: '电源' },
                    { name: 'brightness', type: 'number', min: 1, max: 100, placeholder: '1-100', description: '亮度' },
                    { name: 'color_temperature', type: 'number', min: 2500, max: 4800, placeholder: '2500-4800', description: '色温' }
                ]
            }
        }
    },
    'VCPAlarm': {
        displayName: 'Vchat闹钟',
        description: '设置一个闹钟。[前端分布式: VCPAlarm]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'time_description', type: 'text', required: true, placeholder: '1分钟后' },
            { name: 'reminder_text', type: 'textarea', required: false, placeholder: '提醒我检查烤箱里的点心' }
        ]
    },

    // ========================================
    // 文件管理
    // ========================================
    'LocalSearchController': {
        displayName: '本地文件搜索',
        description: '基于Everything模块实现本地文件搜索。[前端分布式: VCPEverything]',
        commands: {
            'search': {
                description: '搜索文件',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'query', type: 'text', required: true, placeholder: 'VCP a.txt' },
                    { name: 'maxResults', type: 'number', required: false, placeholder: '50' }
                ]
            }
        }
    },
    'ServerSearchController': {
        displayName: '服务器文件搜索',
        description: '基于Everything模块实现服务器文件搜索。[后端插件: VCPEverything]',
        commands: {
            'search': {
                description: '搜索文件',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'query', type: 'text', required: true, placeholder: 'VCP a.txt' },
                    { name: 'maxResults', type: 'number', required: false, placeholder: '50' }
                ]
            }
        }
    },
    'PowerShellExecutor': {
        displayName: 'PowerShell (前端)',
        description: '在前端执行PowerShell命令。[前端分布式: PowerShellExecutor]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'command', type: 'textarea', required: true, placeholder: 'Get-ChildItem' },
            { name: 'executionType', type: 'select', options: ['blocking', 'background'], required: false, placeholder: 'blocking' },
            { name: 'newSession', type: 'checkbox', required: false, default: false },
            { name: 'requireAdmin', type: 'checkbox', required: false, default: false }
        ]
    },
    'ServerPowerShellExecutor': {
        displayName: 'PowerShell (后端)',
        description: '在服务器后端执行PowerShell命令。[后端插件: PowerShellExecutor]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'command', type: 'textarea', required: true, placeholder: 'Get-ChildItem' },
            { name: 'executionType', type: 'select', options: ['blocking', 'background'], required: false, placeholder: 'blocking' },
            { name: 'requireAdmin', type: 'text', required: false, placeholder: '6位数安全码' }
        ]
    },
    'CodeSearcher': {
        displayName: '代码检索器(前端)',
        description: '在VCP项目前端源码中搜索。[前端分布式: CodeSearcher]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'query', type: 'text', required: true, placeholder: '关键词或正则表达式' },
            { name: 'search_path', type: 'text', required: false, placeholder: '相对路径' },
            { name: 'case_sensitive', type: 'checkbox', required: false, default: false },
            { name: 'whole_word', type: 'checkbox', required: false, default: false },
            { name: 'context_lines', type: 'number', required: false, placeholder: '2' }
        ]
    },
    'ServerCodeSearcher': {
        displayName: '代码检索器 (后端)',
        description: '在VCP项目后端源码中搜索。[后端插件: CodeSearcher]',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'query', type: 'text', required: true, placeholder: '关键词或正则表达式' },
            { name: 'search_path', type: 'text', required: false, placeholder: '相对路径' },
            { name: 'case_sensitive', type: 'checkbox', required: false, default: false },
            { name: 'whole_word', type: 'checkbox', required: false, default: false },
            { name: 'context_lines', type: 'number', required: false, placeholder: '2' }
        ]
    },

    // ========================================
    // 日程管理
    // ========================================
    'ScheduleManager': {
        displayName: '日程管理器',
        description: '辅助日程管理。[后端插件: ScheduleManager]',
        commands: {
            'AddSchedule': {
                description: '添加日程',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'time', type: 'text', required: true, placeholder: '2025-12-31 10:00' },
                    { name: 'content', type: 'textarea', required: true }
                ]
            },
            'ListSchedules': {
                description: '列出所有日程',
                params: [{ name: 'maid', type: 'text', required: true, placeholder: '你的名字' }]
            },
            'DeleteSchedule': {
                description: '删除日程',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'id', type: 'text', required: true }
                ]
            }
        }
    }
};