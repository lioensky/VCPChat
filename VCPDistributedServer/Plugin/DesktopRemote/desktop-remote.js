// desktop-remote.js
// This script acts as a simple data pipe and validator for DesktopRemote commands.
// It receives a JSON object from stdin, validates and normalizes it, then prints to stdout.
// The actual desktop control logic is handled by the main process (injected handler).

let inputBuffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', (chunk) => {
    inputBuffer += chunk;
});

process.stdin.on('end', () => {
    try {
        if (!inputBuffer.trim()) {
            throw new Error('No input received.');
        }

        const args = JSON.parse(inputBuffer);

        // Flexible command parameter recognition
        const command = args.command || args.Command || args.action || args.Action;

        if (!command) {
            throw new Error("The 'command' parameter is required. Valid commands: 'SetWallpaper', 'QueryDesktop', 'ViewWidgetSource', 'CreateWidget'.");
        }

        const normalizedCommand = command.toLowerCase();

        if (normalizedCommand === 'setwallpaper' || normalizedCommand === 'set_wallpaper') {
            // SetWallpaper command
            const wallpaperSource = args.wallpaperSource || args.wallpapersource || args.WallpaperSource
                || args.source || args.Source || args.url || args.URL || args.content || args.Content;

            if (!wallpaperSource) {
                throw new Error("The 'wallpaperSource' parameter is required for SetWallpaper command.");
            }

            const commandPayload = {
                command: 'SetWallpaper',
                wallpaperSource: wallpaperSource
            };

            console.log(JSON.stringify(commandPayload));

        } else if (normalizedCommand === 'querydesktop' || normalizedCommand === 'query_desktop' || normalizedCommand === 'query') {
            // QueryDesktop command - no additional parameters needed
            const commandPayload = {
                command: 'QueryDesktop'
            };

            console.log(JSON.stringify(commandPayload));

        } else if (normalizedCommand === 'viewwidgetsource' || normalizedCommand === 'view_widget_source' || normalizedCommand === 'viewsource') {
            // ViewWidgetSource command
            const widgetId = args.widgetId || args.widgetid || args.WidgetId || args.widget_id || args.id || args.Id;

            if (!widgetId) {
                throw new Error("The 'widgetId' parameter is required for ViewWidgetSource command.");
            }

            const commandPayload = {
                command: 'ViewWidgetSource',
                widgetId: widgetId
            };

            console.log(JSON.stringify(commandPayload));

        } else if (normalizedCommand === 'createwidget' || normalizedCommand === 'create_widget' || normalizedCommand === 'create') {
            // CreateWidget command - create a new widget on the desktop canvas
            const htmlContent = args.htmlContent || args.htmlcontent || args.HtmlContent
                || args.html || args.Html || args.content || args.Content;

            if (!htmlContent) {
                throw new Error("The 'htmlContent' parameter is required for CreateWidget command. Provide the HTML code for the widget.");
            }

            // Optional position and size parameters
            const x = _parseNumber(args.x || args.X || args.posX || args.positionX);
            const y = _parseNumber(args.y || args.Y || args.posY || args.positionY);
            const width = _parseNumber(args.width || args.Width || args.w);
            const height = _parseNumber(args.height || args.Height || args.h);

            // Optional widget ID and save options
            const widgetId = args.widgetId || args.widgetid || args.WidgetId || args.widget_id || args.id || args.Id || null;
            const autoSave = _parseBoolean(args.autoSave || args.autosave || args.AutoSave || args.auto_save);
            const saveName = args.saveName || args.savename || args.SaveName || args.save_name || args.name || args.Name || null;

            const commandPayload = {
                command: 'CreateWidget',
                htmlContent: htmlContent,
            };

            // Only include optional fields if they have valid values
            if (x !== null) commandPayload.x = x;
            if (y !== null) commandPayload.y = y;
            if (width !== null) commandPayload.width = width;
            if (height !== null) commandPayload.height = height;
            if (widgetId) commandPayload.widgetId = widgetId;
            if (autoSave) commandPayload.autoSave = true;
            if (saveName) commandPayload.saveName = saveName;

            console.log(JSON.stringify(commandPayload));

        } else {
            throw new Error(`Unknown command: '${command}'. Valid commands: 'SetWallpaper', 'QueryDesktop', 'ViewWidgetSource', 'CreateWidget'.`);
        }

    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
});

/**
 * Parse a value as a number, return null if invalid
 * @param {*} val
 * @returns {number|null}
 */
function _parseNumber(val) {
    if (val === undefined || val === null) return null;
    const num = Number(val);
    return isNaN(num) ? null : num;
}

/**
 * Parse a value as a boolean
 * @param {*} val
 * @returns {boolean}
 */
function _parseBoolean(val) {
    if (val === undefined || val === null) return false;
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return !!val;
}