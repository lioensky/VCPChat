'use strict';

const { contextBridge } = require('electron');

const profileArgument = process.argv.find((arg) => arg.startsWith('--loom-page-profile='));
const profile = profileArgument
    ? decodeURIComponent(profileArgument.slice('--loom-page-profile='.length))
    : '';

if (profile === 'mobile') {
    contextBridge.executeInMainWorld({
        func: (metadata) => {
            const defineGetter = (target, property, getter) => {
                try {
                    Object.defineProperty(target, property, {
                        configurable: true,
                        enumerable: true,
                        get: getter,
                    });
                    return true;
                } catch {
                    return false;
                }
            };

            const brands = Object.freeze(metadata.brands.map((brand) => Object.freeze({ ...brand })));
            const userAgentData = Object.freeze({
                brands,
                mobile: true,
                platform: 'Android',
                getHighEntropyValues: async (hints = []) => {
                    const values = {
                        brands,
                        mobile: true,
                        platform: 'Android',
                    };

                    const highEntropy = {
                        architecture: '',
                        bitness: '',
                        formFactors: ['Mobile'],
                        fullVersionList: metadata.fullVersionList,
                        model: 'Pixel 8 Pro',
                        platformVersion: '14.0.0',
                        uaFullVersion: '146.0.0.0',
                        wow64: false,
                    };

                    for (const hint of hints) {
                        if (Object.prototype.hasOwnProperty.call(highEntropy, hint)) {
                            values[hint] = highEntropy[hint];
                        }
                    }

                    return values;
                },
                toJSON: () => ({
                    brands,
                    mobile: true,
                    platform: 'Android',
                }),
            });

            if (!defineGetter(Navigator.prototype, 'userAgentData', () => userAgentData)) {
                defineGetter(navigator, 'userAgentData', () => userAgentData);
            }

            // 保持传统 Navigator 特征与 Android UA/Client Hints 一致。
            defineGetter(Navigator.prototype, 'platform', () => 'Linux armv8l');
            defineGetter(Navigator.prototype, 'maxTouchPoints', () => 5);
            defineGetter(Navigator.prototype, 'vendor', () => 'Google Inc.');

            // WebContentsView 具有正确的 390px innerWidth，但默认 screen 仍指向桌面显示器。
            // 部分站点会在客户端初始化完成后据此重新选择桌面布局。
            const mobileScreen = {
                width: metadata.screen.width,
                height: metadata.screen.height,
                availWidth: metadata.screen.width,
                availHeight: metadata.screen.height,
                availLeft: 0,
                availTop: 0,
                colorDepth: 24,
                pixelDepth: 24,
                isExtended: false,
            };

            for (const [property, value] of Object.entries(mobileScreen)) {
                if (!defineGetter(Screen.prototype, property, () => value)) {
                    defineGetter(window.screen, property, () => value);
                }
            }

            const orientation = Object.freeze({
                angle: 0,
                type: 'portrait-primary',
                onchange: null,
                lock: async () => undefined,
                unlock: () => undefined,
            });
            defineGetter(Screen.prototype, 'orientation', () => orientation);

            // 提供触摸能力探测，但不拦截或合成实际输入事件。
            if (!('ontouchstart' in window)) {
                defineGetter(Window.prototype, 'ontouchstart', () => null);
            }
            if (!('ontouchmove' in window)) {
                defineGetter(Window.prototype, 'ontouchmove', () => null);
            }
            if (!('ontouchend' in window)) {
                defineGetter(Window.prototype, 'ontouchend', () => null);
            }
        },
        args: [{
            brands: [
                { brand: 'Not-A.Brand', version: '24' },
                { brand: 'Chromium', version: '146' },
            ],
            fullVersionList: [
                { brand: 'Not-A.Brand', version: '24.0.0.0' },
                { brand: 'Chromium', version: '146.0.0.0' },
            ],
            screen: {
                width: 390,
                height: 720,
            },
        }],
    });
}