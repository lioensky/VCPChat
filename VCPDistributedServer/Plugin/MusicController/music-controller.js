// music-controller.js
// This script acts as a simple data pipe and validator.
// It receives a JSON object from stdin, validates it, and prints it to stdout.

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
        
        // The input from the plugin manager is already a JSON string of arguments
        const args = JSON.parse(inputBuffer);

        // The core logic is just to format the command for the main process.
        // Be flexible with parameter names from the AI.
        // Accept 'songName' (camelCase), 'songname' (lowercase), or 'song_name' (snake_case).
        const songName = args.songName || args.songname || args.song_name;
        if (typeof songName !== 'string' || !songName.trim()) {
            throw new Error("The 'songName', 'songname', or 'song_name' parameter is required.");
        }

        // Optional immersive performance mode. English IDs are the stable wire format,
        // while Chinese labels and common parameter spellings are accepted for the AI.
        const requestedStageMode = args.stageMode
            ?? args.stagemode
            ?? args.stage_mode
            ?? args.performanceMode
            ?? args.performance_mode;
        const stageModeAliases = {
            luminous: 'luminous',
            '流光': 'luminous',
            partita: 'partita',
            '云阶': 'partita',
            cadenza: 'cadenza',
            '心象': 'cadenza',
            tempera: 'tempera',
            '凝彩': 'tempera',
            sonnet: 'sonnet',
            '商籁': 'sonnet',
            diorama: 'diorama',
            '镜台': 'diorama',
            fume: 'fume',
            '浮名': 'fume',
            starborn: 'starborn',
            '星诞': 'starborn'
        };

        let stageMode;
        if (requestedStageMode !== undefined && requestedStageMode !== null && requestedStageMode !== '') {
            if (typeof requestedStageMode !== 'string') {
                throw new Error("The optional 'stageMode' parameter must be a string.");
            }
            stageMode = stageModeAliases[requestedStageMode.trim().toLowerCase()];
            if (!stageMode) {
                throw new Error(
                    `Unknown stage mode '${requestedStageMode}'. Supported modes: luminous, partita, cadenza, tempera, sonnet, diorama, fume, starborn.`
                );
            }
        }

        // Format the payload for the main process.
        // Omitting stageMode preserves the existing regular playback behavior.
        const commandPayload = {
            command: 'play',
            target: songName.trim()
        };
        if (stageMode) {
            commandPayload.stageMode = stageMode;
        }

        // Output the final command payload as a JSON string to stdout.
        // This will be captured by the PluginManager.
        console.log(JSON.stringify(commandPayload));

    } catch (error) {
        // Write the actual error message to the standard error stream (stderr).
        // This is the conventional way for command-line tools to report errors.
        console.error(error.message);
        process.exit(1); // Exit with a non-zero code to indicate failure.
    }
});