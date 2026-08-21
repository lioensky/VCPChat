'use strict';

function resolveCommandInvocation(command, args = [], {
    platform = process.platform,
    env = process.env,
} = {}) {
    if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)) {
        return {
            command: env.ComSpec || env.COMSPEC || 'cmd.exe',
            args: ['/d', '/s', '/c', command, ...args],
        };
    }
    return { command, args };
}

module.exports = { resolveCommandInvocation };
