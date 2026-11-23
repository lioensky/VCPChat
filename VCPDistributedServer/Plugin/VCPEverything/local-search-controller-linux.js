const http = require('http');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_SEARCH_TIMEOUT_MS = 5000;
const EVERYTHING_HOST = process.env.EVERYTHING_HOST || '127.0.0.1';
const EVERYTHING_PORT = readIntEnv('EVERYTHING_PORT', 80);
const FD_RDD_HOST = process.env.FD_RDD_HOST || '127.0.0.1';
const FD_RDD_PORT = readIntEnv('FD_RDD_PORT', 6060);
const FD_RDD_PATH = normalizeHttpPath(process.env.FD_RDD_PATH || '/search');
const SEARCH_TIMEOUT_MS = readIntEnv('SEARCH_TIMEOUT_MS', DEFAULT_SEARCH_TIMEOUT_MS);
const ENABLE_EVERYTHING = process.env.ENABLE_EVERYTHING !== 'false';
const ENABLE_FD_RDD = process.env.ENABLE_FD_RDD !== 'false';
const DEBUG_MODE = process.env.DEBUG_MODE === 'true';

function readIntEnv(name, fallbackValue) {
    const parsedValue = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(parsedValue) ? parsedValue : fallbackValue;
}

function normalizeHttpPath(rawPath) {
    return rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
}

function normalizeMaxResults(maxResults) {
    const parsedValue = Number.parseInt(maxResults, 10);
    return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : DEFAULT_MAX_RESULTS;
}

function debugLog(message, data = null) {
    if (DEBUG_MODE) {
        const timestamp = new Date().toISOString();
        console.error(`[DEBUG ${timestamp}] ${message}`);
        if (data) {
            console.error(JSON.stringify(data, null, 2));
        }
    }
}

function joinSearchPath(parentPath, itemName) {
    if (!parentPath) {
        return itemName;
    }

    const isWindowsPath = /^[a-zA-Z]:\\/.test(parentPath) || parentPath.includes('\\');
    return isWindowsPath ? path.win32.join(parentPath, itemName) : path.join(parentPath, itemName);
}

function createSuccessResponse(source, query, results, resultCount) {
    return {
        status: 'success',
        result: {
            searchQuery: query,
            source,
            resultCount,
            returnedCount: results.length,
            results,
        },
    };
}

function formatSourceError(sourceName, error, target) {
    let message = error.message;

    if (error.code === 'ECONNREFUSED') {
        if (sourceName === 'Everything') {
            message = `Connection to Everything HTTP server refused on ${target.host}:${target.port}. Please ensure Everything is running and the HTTP server is enabled in Tools -> Options.`;
        } else {
            message = `Connection to fd-rdd refused on ${target.host}:${target.port}. Please ensure fd-rdd is running and exposes the HTTP query endpoint.`;
        }
    } else if (error.code === 'ETIMEDOUT') {
        message = `${sourceName} request timed out after ${SEARCH_TIMEOUT_MS}ms.`;
    }

    const wrappedError = new Error(message);
    wrappedError.code = error.code;
    return wrappedError;
}

function createJsonRequestTask({ sourceName, hostname, port, requestPath, timeoutMs, transformResponse }) {
    let requestHandle = null;
    let settled = false;
    let cancelled = false;

    const promise = new Promise((resolve, reject) => {
        const finishSuccess = (value) => {
            if (settled || cancelled) {
                return;
            }

            settled = true;
            resolve(value);
        };

        const finishError = (error) => {
            if (settled || cancelled) {
                return;
            }

            settled = true;
            reject(error);
        };

        const options = {
            hostname,
            port,
            path: requestPath,
            method: 'GET',
        };

        debugLog(`Dispatching ${sourceName} request`, options);

        const req = http.request(options, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                finishError(new Error(`${sourceName} responded with status code: ${res.statusCode}`));
                return;
            }

            let rawData = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                rawData += chunk;
            });
            res.on('end', () => {
                if (cancelled) {
                    return;
                }

                try {
                    const parsedData = JSON.parse(rawData);
                    finishSuccess(transformResponse(parsedData));
                } catch (error) {
                    finishError(new Error(`${sourceName} JSON parse failed: ${error.message}`));
                }
            });
            res.on('error', (error) => {
                finishError(new Error(`${sourceName} response error: ${error.message}`));
            });
        });

        requestHandle = req;

        req.setTimeout(timeoutMs, () => {
            const timeoutError = new Error(`${sourceName} request timeout`);
            timeoutError.code = 'ETIMEDOUT';
            req.destroy(timeoutError);
        });

        req.on('error', (error) => {
            if (cancelled) {
                debugLog(`${sourceName} request cancelled`);
                return;
            }

            finishError(formatSourceError(sourceName, error, { host: hostname, port }));
        });

        req.end();
    });

    return {
        sourceName,
        promise,
        cancel() {
            if (cancelled || settled || !requestHandle) {
                return;
            }

            cancelled = true;
            requestHandle.destroy();
        },
    };
}

function createEverythingTask(query, maxResults) {
    const encodedQuery = encodeURIComponent(query);
    const requestPath = `/?s=${encodedQuery}&json=1&path_column=1&n=${maxResults}`;

    return createJsonRequestTask({
        sourceName: 'Everything',
        hostname: EVERYTHING_HOST,
        port: EVERYTHING_PORT,
        requestPath,
        timeoutMs: SEARCH_TIMEOUT_MS,
        transformResponse(parsedData) {
            const rawResults = Array.isArray(parsedData.results) ? parsedData.results : [];
            const filePaths = rawResults
                .filter((item) => item && typeof item.path === 'string' && typeof item.name === 'string')
                .map((item) => joinSearchPath(item.path, item.name));
            const resultCount = Number.isFinite(parsedData.totalResults)
                ? parsedData.totalResults
                : filePaths.length;

            return createSuccessResponse('everything', query, filePaths, resultCount);
        },
    });
}

function createFdRddTask(query, maxResults) {
    const encodedQuery = encodeURIComponent(query);
    const separator = FD_RDD_PATH.includes('?') ? '&' : '?';
    const requestPath = `${FD_RDD_PATH}${separator}q=${encodedQuery}&limit=${maxResults}`;

    return createJsonRequestTask({
        sourceName: 'fd-rdd',
        hostname: FD_RDD_HOST,
        port: FD_RDD_PORT,
        requestPath,
        timeoutMs: SEARCH_TIMEOUT_MS,
        transformResponse(parsedData) {
            const rawResults = Array.isArray(parsedData) ? parsedData : [];
            const filePaths = rawResults
                .filter((item) => item && typeof item.path === 'string')
                .map((item) => item.path);

            return createSuccessResponse('fd-rdd', query, filePaths, filePaths.length);
        },
    });
}

function searchWithRace(query, maxResults = DEFAULT_MAX_RESULTS) {
    const tasks = [];

    if (ENABLE_EVERYTHING) {
        tasks.push(createEverythingTask(query, maxResults));
    }

    if (ENABLE_FD_RDD) {
        tasks.push(createFdRddTask(query, maxResults));
    }

    if (tasks.length === 0) {
        throw new Error('No search source is enabled. Please enable Everything and/or fd-rdd.');
    }

    return new Promise((resolve, reject) => {
        let winnerSelected = false;
        let remainingTasks = tasks.length;
        const errorMessages = [];

        tasks.forEach((task, index) => {
            task.promise
                .then((result) => {
                    if (winnerSelected) {
                        return;
                    }

                    winnerSelected = true;
                    debugLog(`Search resolved by ${task.sourceName}`, {
                        source: result.result.source,
                        returnedCount: result.result.returnedCount,
                    });

                    tasks.forEach((otherTask, otherIndex) => {
                        if (otherIndex !== index) {
                            otherTask.cancel();
                        }
                    });

                    resolve(result);
                })
                .catch((error) => {
                    if (winnerSelected) {
                        return;
                    }

                    remainingTasks -= 1;
                    errorMessages.push(`[${task.sourceName}] ${error.message}`);
                    debugLog(`${task.sourceName} search failed`, {
                        error: error.message,
                        remainingTasks,
                    });

                    if (remainingTasks === 0) {
                        reject(new Error(errorMessages.join(' | ')));
                    }
                });
        });
    });
}

async function processRequest(request) {
    const query = typeof request.query === 'string' ? request.query : '';
    const maxResults = normalizeMaxResults(request.maxResults);

    if (!query.trim()) {
        return {
            status: 'error',
            error: 'Missing required parameter: query',
        };
    }

    try {
        return await searchWithRace(query, maxResults);
    } catch (error) {
        return {
            status: 'error',
            error: error.message,
        };
    }
}

let inputBuffer = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', async (chunk) => {
    inputBuffer += chunk;
});

process.stdin.on('end', async () => {
    if (!inputBuffer.trim()) {
        console.log(JSON.stringify({ status: 'error', error: 'No input received.' }));
        return;
    }

    debugLog('Received raw input from VCP', inputBuffer);

    try {
        const request = JSON.parse(inputBuffer);
        const response = await processRequest(request);
        console.log(JSON.stringify(response));
    } catch (error) {
        console.log(JSON.stringify({ status: 'error', error: `Invalid JSON input: ${error.message}` }));
    }
});

debugLog('VCPEverything hybrid search plugin started and ready.');
