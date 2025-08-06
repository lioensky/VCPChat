// ComfyUI State Manager Module
(function() {
    'use strict';

    class ComfyUI_StateManager {
        constructor() {
            if (ComfyUI_StateManager.instance) {
                return ComfyUI_StateManager.instance;
            }

            this.config = {
                serverUrl: 'http://localhost:8188',
                apiKey: '',
                workflow: 'text2img_basic',
                defaultModel: 'sd_xl_base_1.0.safetensors',
                defaultWidth: 1024,
                defaultHeight: 1024,
                defaultSteps: 30,
                defaultCfg: 7.5,
                defaultSampler: 'dpmpp_2m',
                defaultScheduler: 'normal',
                defaultSeed: -1,
                defaultBatchSize: 1,
                defaultDenoise: 1.0,
                negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
                qualityTags: 'masterpiece, best quality, high resolution, detailed',
                loras: []
            };

            // Runtime state
            this.isConnected = false;
            this.isHandlingConfigChange = false;
            // 运行时可用 LoRA 列表，不持久化进 config
            this._availableLoRAs = [];

            ComfyUI_StateManager.instance = this;
        }

        static getInstance() {
            if (!ComfyUI_StateManager.instance) {
                ComfyUI_StateManager.instance = new ComfyUI_StateManager();
            }
            return ComfyUI_StateManager.instance;
        }

        // --- Getters ---
        getConfig() {
            return { ...this.config };
        }

        get(key) {
            return this.config[key];
        }
        
        isConnectionActive() {
            return this.isConnected;
        }

        // --- Setters ---
        updateConfig(newConfig) {
            this.config = { ...this.config, ...newConfig };
        }

        set(key, value) {
            this.config[key] = value;
        }

        setConnectionStatus(status) {
            this.isConnected = status;
        }
        
        // 统一的运行时可用 LoRA 访问器
        setAvailableLoRAs(loras) {
            this._availableLoRAs = Array.isArray(loras) ? loras : [];
        }
        
        getAvailableLoRAs() {
            return Array.isArray(this._availableLoRAs) ? this._availableLoRAs : [];
        }

        // --- Async Operations ---
        async loadConfig() {
            try {
                if (window.electronAPI && window.electronAPI.loadComfyUIConfig) {
                    const loadedConfig = await window.electronAPI.loadComfyUIConfig();
                    if (loadedConfig) {
                        this.updateConfig(loadedConfig);
                    }
                } else {
                    // Fallback to localStorage
                    const saved = localStorage.getItem('comfyui-config');
                    if (saved) {
                        this.updateConfig(JSON.parse(saved));
                    }
                }
            } catch (error) {
                console.warn('[ComfyUI State] Failed to load config:', error);
            }
        }

        async saveConfig() {
            try {
                this.isHandlingConfigChange = true;
                const configToSave = this.getConfig();
                
                if (window.electronAPI && window.electronAPI.saveComfyUIConfig) {
                    await window.electronAPI.saveComfyUIConfig(configToSave);
                } else {
                    // Fallback to localStorage
                    localStorage.setItem('comfyui-config', JSON.stringify(configToSave));
                }
                
                
            } catch (error) {
                console.error('[ComfyUI State] Failed to save config:', error);
                throw error; // Re-throw to be handled by the coordinator
            } finally {
                // Release lock quickly to reduce potential UI blocking
                queueMicrotask(() => {
                    this.isHandlingConfigChange = false;
                });
            }
        }
    }

    window.ComfyUI_StateManager = ComfyUI_StateManager.getInstance();
})();