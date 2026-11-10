// Compression is a side request: never execute tools or substitute reasoning for content.
export async function readCompactionResponse(response, { signal, model, onResponse }) {
    if (!response.body?.getReader || response.headers?.get('content-type')?.includes('application/json')) {
        const data = await response.json();
        if (data?.error) throw new Error('压缩服务器返回错误，未生成快照，请检查模型配置或服务端日志');
        const choice = data?.choices?.[0];
        onResponse({
            model: typeof data?.model === 'string' ? data.model : model,
            finishReason: choice?.finish_reason ?? '未提供',
            content: choice?.message?.content ?? '',
        });
        return choice?.message?.content || choice?.message?.refusal;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const content = [];
    const refusals = [];
    let buffer = '';
    let dataLines = [];
    let finished = false;
    let finishReason = null;
    let receivedBytes = 0;
    let responseModel = model;
    const checkAbort = () => {
        if (signal?.aborted) throw new Error('上下文压缩已取消');
    };
    // Abort also releases a pending read; no dependency on a cooperative upstream.
    const cancelReader = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancelReader, { once: true });

    function dispatch() {
        if (!dataLines.length) return;
        const data = dataLines.join('\n');
        dataLines = [];
        if (data.trim() === '[DONE]') {
            finished = true;
            return;
        }
        let event;
        try { event = JSON.parse(data); }
        catch { throw new Error('上下文压缩流返回了无效 JSON'); }
        if (event?.error) throw new Error('压缩服务器返回流式错误，未生成快照，请检查服务端日志');
        if (typeof event?.model === 'string') responseModel = event.model;
        const choice = event?.choices?.find(item => item.index === 0)
            ?? (event?.choices?.[0]?.index == null ? event?.choices?.[0] : undefined);
        if (!choice) return; // Usage-only chunks and heartbeat events have no choice.
        if (choice.finish_reason != null) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (typeof delta?.content === 'string') content.push(delta.content);
        else if (Array.isArray(delta?.content)) {
            for (const part of delta.content) {
                if (['text', 'output_text'].includes(part?.type) && typeof part.text === 'string') content.push(part.text);
            }
        }
        if (typeof delta?.refusal === 'string') refusals.push(delta.refusal);
    }

    function consumeLines(eof = false) {
        let start = 0;
        for (let index = 0; index < buffer.length; index++) {
            const character = buffer[index];
            if (character !== '\r' && character !== '\n') continue;
            if (character === '\r' && index === buffer.length - 1 && !eof) break;
            const line = buffer.slice(start, index);
            if (character === '\r' && buffer[index + 1] === '\n') index++;
            start = index + 1;
            if (!line) dispatch();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
            if (finished) break;
        }
        buffer = buffer.slice(start);
        if (eof && !finished) {
            if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, ''));
            buffer = '';
            dispatch();
        }
    }

    try {
        checkAbort();
        while (!finished) {
            const { value, done } = await reader.read();
            checkAbort();
            if (done) {
                buffer += decoder.decode();
                consumeLines(true);
                break;
            }
            receivedBytes += value.byteLength;
            if (receivedBytes > 32 * 1024 * 1024) throw new Error('上下文压缩流超过32MiB安全上限');
            buffer += decoder.decode(value, { stream: true });
            consumeLines();
        }
        checkAbort();
        if (!finished && finishReason == null) throw new Error('上下文压缩流提前断开，未保存不完整快照，请重试');
        const text = content.join('') || refusals.join('');
        onResponse({ model: responseModel, finishReason: finishReason ?? '未提供', content: text });
        return text;
    } finally {
        signal?.removeEventListener('abort', cancelReader);
        // DONE may arrive before the transport closes; never leave the connection hanging.
        try { await reader.cancel(); } catch { /* Preserve the original stream error. */ }
        reader.releaseLock();
    }
}