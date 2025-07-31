// 从 Web 服务器的根目录加载模块
import DiceBox from "/node_modules/@3d-dice/dice-box/dist/dice-box.es.js";

// 使用相对于 Web 服务器根目录的绝对路径
const Box = new DiceBox({
    container: "#dice-canvas-container",
    assetPath: "/assets/dice-box/",
    theme: "default",
    offscreen: true,
    scale: 6
});

Box.init().then(() => {
    console.log("Dice Box is ready.");
    const notationInput = document.getElementById('notation-input');
    const rollButton = document.getElementById('roll-button');

    // Function to apply the current theme (light/dark)
    const applyTheme = (theme) => {
        const isLight = theme === 'light';
        document.body.classList.toggle('light-theme', isLight);

        // Update DiceBox config for the new theme
        // This should make DiceBox use 'diffuse-light.png' or 'diffuse-dark.png'
        Box.updateConfig({
            colorScheme: theme
        });
    };

    // Listen for theme changes from the main process
    if (window.electronAPI && window.electronAPI.onThemeUpdated) {
        window.electronAPI.onThemeUpdated(applyTheme);
    }

    // Get the initial theme from the main process
    if (window.electronAPI && window.electronAPI.getCurrentTheme) {
        window.electronAPI.getCurrentTheme().then(theme => {
            applyTheme(theme);
            // Now that the theme is set, we can signal readiness.
            if (window.electronAPI.sendDiceModuleReady) {
                window.electronAPI.sendDiceModuleReady();
            }
        });
    } else {
        // Fallback if getCurrentTheme is not available, signal ready immediately
        if (window.electronAPI && window.electronAPI.sendDiceModuleReady) {
            window.electronAPI.sendDiceModuleReady();
        }
    }

    // 新增：一个可以解析 "2d6+1d20" 这种复合表达式的函数
    const parseAndRoll = (notationString) => {
        if (!notationString) return;
        // 通过 "+" 分割字符串，并移除每个部分前后的空格，得到一个投掷数组
        const notations = notationString.split('+').map(s => s.trim());
        console.log(`Parsed notations: ${JSON.stringify(notations)}`);
        Box.roll(notations);
    };

    const doRoll = () => {
        parseAndRoll(notationInput.value);
    };

    // 用户手动投掷
    rollButton.addEventListener('click', doRoll);
    notationInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            doRoll();
        }
    });

    // 监听来自主进程的AI投掷请求
    if (window.electronAPI && window.electronAPI.onRollDice) {
        window.electronAPI.onRollDice((notation, options) => {
            console.log(`Received roll from main process: ${notation}`, options);
            
            // 智能处理颜色：如果AI提供了颜色，就使用它。
            // 如果没有，就根据当前主题设置一个合适的默认颜色。
            const isLight = document.body.classList.contains('light-theme');
            const defaultThemeColor = isLight ? '#8b4513' : '#ff4785'; // 匹配 themes.css 的高亮色

            const configUpdate = {
                ...options,
                themeColor: options?.themeColor || defaultThemeColor
            };
            Box.updateConfig(configUpdate);

            // 使用解析函数进行投掷
            parseAndRoll(notation);
        });
    }

    // 监听投掷完成事件，并将结果发送回主进程 (为AI指令提供反馈)
    Box.onRollComplete = (results) => {
        console.log("Roll complete:", results);
        if (window.electronAPI && window.electronAPI.sendDiceRollComplete) {
            window.electronAPI.sendDiceRollComplete(results);
        }
    };
    
    // The 'sendDiceModuleReady' is now called after the theme is set.
});