// renderer_modules/config.js

// --- 工具定义 (基于 supertool.txt) ---
export const tools = {
    // 多媒体生成类
    'ZImageGen': {
        displayName: '通义 Qwen 生图',
        description: '国产生图开源模型，性能不错，支持NSFW。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于图片生成的详细提示词。' },
            { name: 'resolution', type: 'select', required: false, options: ['1024x1024', '1280x720', '720x1280', '1152x864', '864x1152'], default: '1024x1024' },
            { name: 'steps', type: 'number', required: false, placeholder: '推荐8-20步' },
            { name: 'showbase64', type: 'checkbox', required: false, default: false }
        ]
    },
    'FluxGen': {
        displayName: 'Flux 图片生成',
        description: '艺术风格多变，仅支持英文提示词。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'prompt', type: 'textarea', required: true, placeholder: '详细的英文提示词' },
            { name: 'resolution', type: 'select', required: true, options: ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280'] }
        ]
    },
    'DoubaoGen': {
        displayName: '豆包 AI 图片',
        description: '集成豆包模型的图片生成与编辑功能。',
        commands: {
            'DoubaoGenerateImage': {
                description: '豆包生图',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于图片生成的详细提示词。' },
                    { name: 'resolution', type: 'text', required: true, placeholder: '(必需) 图片分辨率，格式为“宽x高”。理论上支持2048以内内任意分辨率组合。', default: '1024x1024' }
                ]
            },
            'DoubaoEditImage': {
                description: '豆包修图',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于指导图片修改的详细提示词。' },
                    { name: 'image', type: 'dragdrop_image', required: true, placeholder: '(必需) 来源图片URL或file://本地路径' },
                    { name: 'resolution', type: 'text', required: true, placeholder: '(必需) 2K, 4K 或 宽x高', default: '2K' },
                    { name: 'guidance_scale', type: 'number', required: false, placeholder: '范围0-10，值越小越相似。' }
                ]
            },
            'DoubaoComposeImage': {
                description: '豆包多图合成',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '(必需) 用于指导图片融合或对话的详细提示词。' },
                    { name: 'image_1', type: 'dragdrop_image', required: true, placeholder: '(必需) 第1张图片来源' },
                    { name: 'image_2', type: 'dragdrop_image', required: false, placeholder: '(可选) 第2张图片来源' },
                    { name: 'resolution', type: 'text', required: true, placeholder: '(必需) 宽x高 或 adaptive', default: 'adaptive' },
                    { name: 'guidance_scale', type: 'number', required: false, placeholder: '范围0-10，值越小越相似。' }
                ],
                dynamicImages: true
            }
        }
    },
    'QwenImageGen': {
        displayName: '千问图片生成',
        description: '国产新星，文字排版能力不输豆包哦。',
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
    'SunoGen': {
        displayName: 'Suno 音乐生成',
        description: '强大的Suno音乐生成器。',
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
        displayName: 'Wan 视频生成',
        description: '基于强大的Wan系列模型生成视频。',
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
        description: '马斯克家的图生视频大模型，超快且含配音。',
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
        description: '每一路模型独立部署，支持多种艺术风格。',
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
    // 工具类
    'SciCalculator': {
        displayName: '科学计算器',
        description: '支持基础运算、函数、统计和微积分。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'expression', type: 'textarea', required: true, placeholder: "例如: integral('x**2', 0, 1)" }
        ]
    },
    // 联网类
    'VSearch': {
        displayName: 'V-Search 穿透检索',
        description: 'VCP家语义级穿透联网检索引擎，支持并发检索。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'SearchTopic', type: 'text', required: true, placeholder: '研究主题' },
            { name: 'Keywords', type: 'textarea', required: true, placeholder: '多检索词，用逗号隔开' },
            { name: 'ShowURL', type: 'checkbox', required: false, default: false }
        ]
    },
    'TavilySearch': {
        displayName: 'Tavily 联网搜索',
        description: '专业的联网搜索API。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'query', type: 'text', required: true, placeholder: '搜索的关键词 or 问题' },
            { name: 'topic', type: 'text', required: false, placeholder: "general, news, finance..." },
            { name: 'max_results', type: 'number', required: false, placeholder: '10 (范围 5-100)' },
            { name: 'include_raw_content', type: 'select', required: false, options: ['', 'text', 'markdown'] },
            { name: 'start_date', type: 'text', required: false, placeholder: 'YYYY-MM-DD' },
            { name: 'end_date', type: 'text', required: false, placeholder: 'YYYY-MM-DD' }
        ]
    },
    'GoogleSearch': {
        displayName: 'Google 搜索',
        description: '进行一次标准的谷歌网页搜索。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'query', type: 'text', required: true, placeholder: '如何学习编程？' }
        ]
    },
    'SerpSearch': {
        displayName: 'SerpAPI 搜索',
        description: '使用DuckDuckGo搜索引擎进行网页搜索。',
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
        description: '获取网页的文本内容或快照。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'url', type: 'text', required: true, placeholder: 'https://example.com' },
            { name: 'mode', type: 'select', required: false, options: ['text', 'snapshot'] }
        ]
    },
    'BilibiliFetch': {
        displayName: 'B站内容获取',
        description: '获取B站视频文本、弹幕、评论及快照。',
        commands: {
            'fetch': {
                description: '获取视频内容',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'url', type: 'text', required: true, placeholder: 'Bilibili 视频的 URL' },
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
        description: '进行深度主题搜索，返回研究论文。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'SearchContent', type: 'textarea', required: true, placeholder: '希望研究的主题内容' },
            { name: 'SearchBroadness', type: 'number', required: false, placeholder: '7 (范围 5-20)' }
        ]
    },
    'AnimeFinder': {
        displayName: '番剧名称查找',
        description: '通过图片找原始番剧名字工具。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'imageUrl', type: 'dragdrop_image', required: true, placeholder: '可以是任意类型url比如http或者file' }
        ]
    },
    'MusicController': {
        displayName: '莱恩家的点歌台',
        description: '播放音乐。',
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
    // VCP通讯插件
    'AgentAssistant': {
        displayName: '女仆通讯器',
        description: '用于联络别的女仆Agent。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'agent_name', type: 'text', required: true, placeholder: '小娜, 小克, Nova...' },
            { name: 'prompt', type: 'textarea', required: true, placeholder: '我是[您的名字]，我想请你...' },
            { name: 'temporary_contact', type: 'checkbox', required: false, default: false }
        ]
    },
    'AgentMessage': {
        displayName: '主人通讯器',
        description: '向莱恩主人的设备发送通知消息。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'message', type: 'textarea', required: true, placeholder: '要发送的消息内容' }
        ]
    },
    'VCPForum': {
        displayName: 'VCP 论坛',
        description: '在 VCP 论坛上进行发帖、回帖和读帖。',
        commands: {
            'CreatePost': {
                description: '创建新帖子',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'board', type: 'text', required: true, placeholder: '板块名称，不存在则会自动创建' },
                    { name: 'title', type: 'text', required: true, placeholder: '[置顶] 规范流程' },
                    { name: 'content', type: 'textarea', required: true, placeholder: '帖子正文，支持 Markdown' }
                ]
            },
            'ReplyPost': {
                description: '回复帖子',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'post_uid', type: 'text', required: true, placeholder: '要回复的帖子 UID' },
                    { name: 'content', type: 'textarea', required: true, placeholder: '回复内容，支持 Markdown' }
                ]
            },
            'ReadPost': {
                description: '读取帖子内容',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'post_uid', type: 'text', required: true, placeholder: '要读取的帖子 UID' }
                ]
            }
        }
    },
    'DeepMemo': {
        displayName: '深度回忆',
        description: '回忆过去的聊天历史。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'keyword', type: 'text', required: true, placeholder: '多个关键词用空格或逗号分隔' },
            { name: 'window_size', type: 'number', required: false, placeholder: '10 (范围 1-20)' }
        ]
    },
    'LightMemo': {
        displayName: '快速回忆',
        description: '主动检索日记本或者知识库。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: 'Nova' },
            { name: 'folder', type: 'text', required: false, placeholder: '特定的索引文件夹' },
            { name: 'query', type: 'textarea', required: true, placeholder: '记忆检索内容' },
            { name: 'k', type: 'number', required: false, default: 5 },
            { name: 'rerank', type: 'checkbox', required: false, default: true },
            { name: 'tag_boost', type: 'number', required: false, placeholder: '0.1-0.9', min: 0, max: 1, step: 0.01 },
            { name: 'search_all_knowledge_bases', type: 'checkbox', required: false, default: true }
        ]
    },
    // 物联网插件
    'TableLampRemote': {
        displayName: '桌面台灯控制器',
        description: '控制智能台灯的状态。',
        commands: {
            'GetLampStatus': {
                description: '获取台灯当前信息',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' }
                ]
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
        displayName: 'Vchat 闹钟',
        description: '设置一个闹钟。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'time_description', type: 'text', required: true, placeholder: '1分钟后' }
        ]
    },
    // ComfyUI 图像生成
    'ComfyUIGen': {
        displayName: 'ComfyUI 生成',
        description: '使用本地 ComfyUI 后端进行图像生成',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'prompt', type: 'textarea', required: true, placeholder: '图像生成的正面提示词，描述想要生成的图像内容、风格、细节等' },
            { name: 'negative_prompt', type: 'textarea', required: false, placeholder: '额外的负面提示词，将与用户配置的负面提示词合并' },
            { name: 'workflow', type: 'text', required: false, placeholder: '例如: text2img_basic, text2img_advanced' },
            { name: 'width', type: 'number', required: false, placeholder: '默认使用用户配置的值' },
            { name: 'height', type: 'number', required: false, placeholder: '默认使用用户配置的值' }
        ]
    },
    // NanoBanana 图像生成
    'NanoBananaGen2': {
        displayName: 'NanoBanana 图像编辑 (V2)',
        description: '地球最强的图像编辑AI，2025年11月更新2代。支持中英文。',
        commands: {
            'generate': {
                description: '生成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '详细提示词' },
                    { name: 'image_size', type: 'select', options: ['1K', '2K', '4K'], default: '2K' }
                ]
            },
            'edit': {
                description: '编辑图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '编辑指令' },
                    { name: 'image_url', type: 'dragdrop_image', required: true },
                    { name: 'image_size', type: 'select', options: ['1K', '2K', '4K'], default: '2K' }
                ]
            },
            'compose': {
                description: '合成图片',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'prompt', type: 'textarea', required: true, placeholder: '合成指令' },
                    { name: 'image_url_1', type: 'dragdrop_image', required: true },
                    { name: 'image_url_2', type: 'dragdrop_image', required: false },
                    { name: 'image_size', type: 'select', options: ['1K', '2K', '4K'], default: '2K' }
                ],
                dynamicImages: true
            }
        }
    },
    // VCP思考自进化插件
    'ThoughtClusterManager': {
        displayName: '思维簇管理器',
        description: '创建和编辑思维簇文件。',
        commands: {
            'CreateClusterFile': {
                description: '创建新的思维簇文件',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'clusterName', type: 'text', required: true, placeholder: '目标簇文件夹的名称，必须以\'簇\'结尾' },
                    { name: 'content', type: 'textarea', required: true, placeholder: '【思考模块：模块名】\n【触发条件】：\n【核心功能】：\n【执行流程】：' }
                ]
            },
            'EditClusterFile': {
                description: '编辑已存在的思维簇文件',
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'clusterName', type: 'text', required: false, placeholder: '指定在哪个簇文件夹中进行搜索' },
                    { name: 'targetText', type: 'textarea', required: true, placeholder: '这是需要被替换的旧的思考内容，确保它不少于15字。' },
                    { name: 'replacementText', type: 'textarea', required: true, placeholder: '这是更新后的新的思考内容。' }
                ]
            }
        }
    },

    // 文件管理
    'LocalSearchController': {
        displayName: '本地文件搜索',
        description: '基于Everything模块实现本地文件搜索。',
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
        description: '基于Everything模块实现服务器文件搜索。',
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
        description: '在前端执行PowerShell命令。',
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
        description: '在服务器后端执行PowerShell命令。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'command', type: 'textarea', required: true, placeholder: 'Get-ChildItem' },
            { name: 'executionType', type: 'select', options: ['blocking', 'background'], required: false, placeholder: 'blocking' },
            { name: 'requireAdmin', type: 'text', required: false, placeholder: '6位数安全码' }
        ]
    },
    'CodeSearcher': {
        displayName: '代码检索器 (前端)',
        description: '在VCP项目前端源码中搜索。',
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
        description: '在VCP项目后端源码中搜索。',
        params: [
            { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
            { name: 'query', type: 'text', required: true, placeholder: '关键词或正则表达式' },
            { name: 'search_path', type: 'text', required: false, placeholder: '相对路径' },
            { name: 'case_sensitive', type: 'checkbox', required: false, default: false },
            { name: 'whole_word', type: 'checkbox', required: false, default: false },
            { name: 'context_lines', type: 'number', required: false, placeholder: '2' }
        ]
    },
    'ScheduleManager': {
        displayName: '日程管理器',
        description: '辅助日程管理。',
        commands: {
            'AddSchedule': {
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'time', type: 'text', required: true, placeholder: '2025-12-31 10:00' },
                    { name: 'content', type: 'textarea', required: true }
                ]
            },
            'ListSchedules': {
                params: [{ name: 'maid', type: 'text', required: true, placeholder: '你的名字' }]
            },
            'DeleteSchedule': {
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'id', type: 'text', required: true }
                ]
            }
        }
    },
    'TopicMemo': {
        displayName: '话题回忆',
        description: '回忆具体的聊天话题。',
        commands: {
            'ListTopics': {
                params: [{ name: 'maid', type: 'text', required: true, placeholder: '你的名字' }]
            },
            'GetTopicContent': {
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'topic_id', type: 'text', required: true }
                ]
            }
        }
    },
    'AgentTopicCreator': {
        displayName: '话题发起人',
        description: '发起一个全新的聊天话题。',
        commands: {
            'CreateTopic': {
                params: [
                    { name: 'maid', type: 'text', required: true, placeholder: '你的名字' },
                    { name: 'topic_name', type: 'text', required: true },
                    { name: 'initial_message', type: 'textarea', required: true }
                ]
            }
        }
    }
};