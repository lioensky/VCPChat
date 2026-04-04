/**
 * weatherService.js
 * 
 * 天气预报服务模块：从VCP后端拉取天气数据，渲染天气卡片到通知栏。
 * 
 * 工作原理：
 * 1. 从 settings.json 中读取 vcpServerUrl（如 http://192.168.2.179:5890/v1/chat/completions）
 * 2. 从 forum.config.json 中读取 username/password（VCP后端面板的账号密码）
 * 3. 拼接出天气API URL：将 /v1/chat/completions 替换为 /admin_api/weather
 * 4. 使用 Basic Auth 认证拉取天气 JSON 数据
 * 5. 渲染为通知栏顶部的天气小卡片
 */

const weatherService = (() => {
    const chatAPI = window.chatAPI || window.electronAPI;
    let weatherData = null;
    let lastFetchTime = 0;
    const CACHE_DURATION = 30 * 60 * 1000; // 30分钟缓存
    let refreshTimer = null;

    /**
     * 从 vcpServerUrl 推导出天气 API 的 URL
     * 例如：http://url:5890/v1/chat/completions → http://url:5890/admin_api/weather
     */
    function deriveWeatherApiUrl(vcpServerUrl) {
        if (!vcpServerUrl) return null;
        try {
            const urlObj = new URL(vcpServerUrl);
            urlObj.pathname = '/admin_api/weather';
            return urlObj.toString();
        } catch (e) {
            console.warn('[WeatherService] Failed to parse vcpServerUrl:', e);
            return null;
        }
    }

    /**
     * 从后端拉取天气数据
     */
    async function fetchWeatherData() {
        try {
            // 读取全局设置中的 vcpServerUrl
            const settings = await chatAPI.loadSettings();
            if (!settings || settings.error || !settings.vcpServerUrl) {
                console.warn('[WeatherService] vcpServerUrl not configured');
                return null;
            }

            // 读取 forum.config.json 中的账号密码
            let forumConfig = null;
            try {
                forumConfig = await chatAPI.loadForumConfig();
            } catch (e) {
                console.warn('[WeatherService] Failed to read forum config:', e);
            }

            if (!forumConfig || !forumConfig.username || !forumConfig.password) {
                console.warn('[WeatherService] Forum credentials not available');
                return null;
            }

            const weatherApiUrl = deriveWeatherApiUrl(settings.vcpServerUrl);
            if (!weatherApiUrl) {
                console.warn('[WeatherService] Could not derive weather API URL');
                return null;
            }

            console.log('[WeatherService] Fetching weather from:', weatherApiUrl);

            const base64Credentials = btoa(forumConfig.username + ':' + forumConfig.password);
            const response = await fetch(weatherApiUrl, {
                headers: {
                    'Authorization': `Basic ${base64Credentials}`
                }
            });

            if (!response.ok) {
                console.warn('[WeatherService] Weather API returned status:', response.status);
                return null;
            }

            const data = await response.json();
            weatherData = data;
            lastFetchTime = Date.now();
            console.log('[WeatherService] Weather data fetched successfully');
            return data;
        } catch (error) {
            console.error('[WeatherService] Error fetching weather data:', error);
            return null;
        }
    }

    /**
     * 获取天气数据（带缓存）
     */
    async function getWeatherData(forceRefresh = false) {
        if (!forceRefresh && weatherData && (Date.now() - lastFetchTime < CACHE_DURATION)) {
            return weatherData;
        }
        return await fetchWeatherData();
    }

    /**
     * 获取天气图标 emoji
     */
    function getWeatherEmoji(iconCode) {
        const code = String(iconCode);
        const emojiMap = {
            '100': '☀️', '150': '☀️',  // 晴
            '101': '⛅', '151': '⛅',  // 多云
            '102': '🌤️', '152': '🌤️', // 少云
            '103': '⛅', '153': '⛅',  // 晴间多云
            '104': '☁️', '154': '☁️',  // 阴
            '300': '🌧️', '301': '🌧️', // 阵雨
            '302': '⛈️', '303': '⛈️', // 雷阵雨
            '304': '⛈️',              // 雷阵雨伴有冰雹
            '305': '🌦️',              // 小雨
            '306': '🌧️',              // 中雨
            '307': '🌧️',              // 大雨
            '308': '🌊',              // 极端降雨
            '309': '🌦️',              // 毛毛雨
            '310': '🌧️', '311': '🌧️', '312': '🌧️', // 暴雨系列
            '313': '🌧️',              // 冻雨
            '314': '🌦️', '315': '🌧️', // 小到中雨/中到大雨
            '316': '🌧️', '317': '🌧️', '318': '🌧️', // 大到暴雨系列
            '399': '🌧️',              // 雨
            '400': '🌨️', '401': '🌨️', '402': '❄️', // 雪系列
            '403': '❄️', '404': '🌨️', '405': '🌨️', // 暴雪系列
            '406': '🌨️', '407': '🌨️', // 阵雨夹雪
            '408': '🌨️', '409': '❄️', '410': '❄️', // 雪相关
            '499': '❄️',              // 雪
            '500': '🌫️', '501': '🌫️', '502': '🌁', // 雾霾
            '503': '🌫️', '504': '🌫️', '507': '🌪️', // 沙尘暴
            '508': '🌪️', '509': '🌫️', '510': '🌫️', // 浓雾
            '511': '🌫️', '512': '🌫️', '513': '🌁', '514': '🌫️', '515': '🌫️',
            '900': '🌡️', '901': '❄️', // 热/冷
            '999': '🌈',              // 未知
        };
        return emojiMap[code] || '🌡️';
    }

    /**
     * 获取空气质量等级对应的颜色
     */
    function getAqiColor(category) {
        const colorMap = {
            '优': '#00e400',
            '良': '#ffff00',
            '轻度污染': '#ff7e00',
            '中度污染': '#ff0000',
            '重度污染': '#99004c',
            '严重污染': '#7e0023'
        };
        return colorMap[category] || '#999';
    }

    /**
     * 获取预警等级对应的颜色
     */
    function getWarningColor(severityColor) {
        const colorMap = {
            'Blue': '#3b82f6',
            'Yellow': '#eab308',
            'Orange': '#f97316',
            'Red': '#ef4444',
        };
        return colorMap[severityColor] || '#f97316';
    }

    /**
     * 渲染天气卡片到通知栏
     */
    function renderWeatherCard(data, container) {
        if (!data || !container) return;

        // 移除已有的天气卡片
        const existingCard = container.querySelector('.weather-card');
        if (existingCard) existingCard.remove();

        const card = document.createElement('div');
        card.className = 'weather-card';

        // === 当前天气 ===
        const now = new Date();
        const currentHour = now.getHours();

        // 从逐时数据中找到最接近当前时间的数据
        let currentWeather = null;
        if (data.hourly && data.hourly.length > 0) {
            // 找最接近当前小时的逐时数据
            let minDiff = Infinity;
            for (const h of data.hourly) {
                const hDate = new Date(h.fxTime);
                const diff = Math.abs(hDate.getTime() - now.getTime());
                if (diff < minDiff) {
                    minDiff = diff;
                    currentWeather = h;
                }
            }
        }

        // 从日预报中获取今天的数据
        let todayForecast = null;
        if (data.daily && data.daily.length > 0) {
            const todayStr = now.toISOString().slice(0, 10);
            todayForecast = data.daily.find(d => d.fxDate === todayStr) || data.daily[0];
        }

        // --- 主天气区域 ---
        if (currentWeather || todayForecast) {
            const mainSection = document.createElement('div');
            mainSection.className = 'weather-main';

            const temp = currentWeather ? currentWeather.temp : (todayForecast ? todayForecast.tempMax : '--');
            const text = currentWeather ? currentWeather.text : (todayForecast ? todayForecast.textDay : '--');
            const icon = currentWeather ? currentWeather.icon : (todayForecast ? todayForecast.iconDay : '999');
            const humidity = currentWeather ? currentWeather.humidity : (todayForecast ? todayForecast.humidity : '--');
            const windDir = currentWeather ? currentWeather.windDir : (todayForecast ? todayForecast.windDirDay : '--');
            const windScale = currentWeather ? currentWeather.windScale : (todayForecast ? todayForecast.windScaleDay : '--');

            const tempRange = todayForecast ? `${todayForecast.tempMin}°~${todayForecast.tempMax}°` : '';

            mainSection.innerHTML = `
                <div class="weather-current">
                    <span class="weather-emoji">${getWeatherEmoji(icon)}</span>
                    <div class="weather-temp-info">
                        <span class="weather-temp">${temp}°C</span>
                        <span class="weather-desc">${text}</span>
                    </div>
                </div>
                <div class="weather-details">
                    <span title="今日温度范围">🌡️ ${tempRange}</span>
                    <span title="湿度">💧 ${humidity}%</span>
                    <span title="风向/风力">${windDir} ${windScale}级</span>
                </div>
            `;
            card.appendChild(mainSection);
        }

        // --- 空气质量 ---
        if (data.airQuality) {
            const aqiSection = document.createElement('div');
            aqiSection.className = 'weather-aqi';
            const aqiColor = getAqiColor(data.airQuality.category);
            aqiSection.innerHTML = `
                <span class="aqi-badge" style="background-color: ${aqiColor}; color: ${data.airQuality.category === '良' ? '#333' : '#fff'}">
                    AQI ${data.airQuality.aqi} ${data.airQuality.category}
                </span>
                <span class="aqi-detail">PM2.5: ${data.airQuality.pm2p5 ? data.airQuality.pm2p5.toFixed(0) : '--'}</span>
            `;
            card.appendChild(aqiSection);
        }

        // --- 天气预警 ---
        if (data.warning && data.warning.length > 0) {
            data.warning.forEach(w => {
                const warningSection = document.createElement('div');
                warningSection.className = 'weather-warning';
                const wColor = getWarningColor(w.severityColor);
                warningSection.innerHTML = `
                    <div class="warning-header" style="border-left: 3px solid ${wColor}">
                        <span class="warning-icon">⚠️</span>
                        <span class="warning-title" style="color: ${wColor}">${w.title}</span>
                    </div>
                `;
                warningSection.title = w.text || '';
                card.appendChild(warningSection);
            });
        }

        // --- 未来天气预报（横向滚动） ---
        if (data.daily && data.daily.length > 1) {
            const forecastSection = document.createElement('div');
            forecastSection.className = 'weather-forecast';

            // 跳过今天，显示未来几天
            const futureDays = data.daily.slice(1, 5);
            futureDays.forEach(day => {
                const dayItem = document.createElement('div');
                dayItem.className = 'forecast-day';
                const date = new Date(day.fxDate);
                const weekDay = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()];
                const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;

                dayItem.innerHTML = `
                    <span class="forecast-date">${weekDay}</span>
                    <span class="forecast-date-sub">${monthDay}</span>
                    <span class="forecast-icon">${getWeatherEmoji(day.iconDay)}</span>
                    <span class="forecast-temp">${day.tempMin}°~${day.tempMax}°</span>
                `;
                forecastSection.appendChild(dayItem);
            });
            card.appendChild(forecastSection);
        }

        // --- 逐时温度折线（简易文字版） ---
        if (data.hourly && data.hourly.length > 0) {
            const hourlySection = document.createElement('div');
            hourlySection.className = 'weather-hourly';

            // 显示接下来6个小时
            const upcomingHours = data.hourly.filter(h => {
                const hDate = new Date(h.fxTime);
                return hDate.getTime() >= now.getTime();
            }).slice(0, 6);

            if (upcomingHours.length > 0) {
                upcomingHours.forEach(h => {
                    const hourItem = document.createElement('div');
                    hourItem.className = 'hourly-item';
                    const hDate = new Date(h.fxTime);
                    const hourStr = `${String(hDate.getHours()).padStart(2, '0')}:00`;
                    hourItem.innerHTML = `
                        <span class="hourly-time">${hourStr}</span>
                        <span class="hourly-icon">${getWeatherEmoji(h.icon)}</span>
                        <span class="hourly-temp">${h.temp}°</span>
                    `;
                    hourlySection.appendChild(hourItem);
                });
                card.appendChild(hourlySection);
            }
        }

        // 插入到容器最前面
        container.insertBefore(card, container.firstChild);
    }

    /**
     * 初始化天气服务
     */
    async function init() {
        const globalSettings = window.globalSettings || {};
        if (globalSettings.enableWeatherCard === false) {
            console.log('[WeatherService] Weather card disabled in settings');
            return;
        }

        const data = await getWeatherData();
        if (data) {
            const container = document.getElementById('notificationsList');
            if (container) {
                renderWeatherCard(data, container);
            }
        }

        // 设置定时刷新（每30分钟）
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = setInterval(async () => {
            const gs = window.globalSettings || {};
            if (gs.enableWeatherCard === false) return;
            const freshData = await getWeatherData(true);
            if (freshData) {
                const container = document.getElementById('notificationsList');
                if (container) {
                    renderWeatherCard(freshData, container);
                }
            }
        }, CACHE_DURATION);
    }

    /**
     * 销毁天气服务
     */
    function destroy() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
        const container = document.getElementById('notificationsList');
        if (container) {
            const card = container.querySelector('.weather-card');
            if (card) card.remove();
        }
    }

    /**
     * 切换天气卡片显示
     */
    function toggle(enabled) {
        if (enabled) {
            init();
        } else {
            destroy();
        }
    }

    return {
        init,
        destroy,
        toggle,
        getWeatherData,
        renderWeatherCard,
        fetchWeatherData,
    };
})();

window.weatherService = weatherService;
