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
            throw new Error("The 'command' parameter is required. Valid commands: 'SetWallpaper', 'QueryDesktop', 'ViewWidgetSource'.");
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

        } else {
            throw new Error(`Unknown command: '${command}'. Valid commands: 'SetWallpaper', 'QueryDesktop', 'ViewWidgetSource'.`);
        }

    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
});