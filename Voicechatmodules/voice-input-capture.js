'use strict';

document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('captureInput');
    const state = document.getElementById('captureState');
    let composing = false;
    let sessionId = null;
    let focusAttemptToken = 0;
    let focusReadySessionId = null;
    let isStopping = false;

    const report = (settled = false) => {
        window.voiceCaptureAPI.update({
            text: input.value,
            composing,
            updatedAt: Date.now(),
            sessionId,
            settled: Boolean(settled && !composing),
        });
    };

    const hasWritableSelection = () => (
        document.hasFocus()
        && document.activeElement === input
        && input.matches(':focus')
        && !input.disabled
        && !input.readOnly
        && Number.isInteger(input.selectionStart)
        && Number.isInteger(input.selectionEnd)
    );

    const focusAndConfirm = () => {
        const attemptToken = ++focusAttemptToken;
        let retries = 0;

        const establishEditableFocus = () => {
            if (attemptToken !== focusAttemptToken || !sessionId) return;

            input.focus({ preventScroll: true });
            const caretPosition = input.value.length;
            input.setSelectionRange(caretPosition, caretPosition);

            // Chromium can report activeElement before Windows TSF has attached
            // an editable context. Wait for two paints plus a short native-input
            // grace period, then require a real writable caret before allowing
            // Rust to inject Right Alt or Win+H.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        if (attemptToken !== focusAttemptToken || !sessionId) return;

                        if (hasWritableSelection()) {
                            state.textContent = '输入区已选中';
                            if (focusReadySessionId !== sessionId) {
                                focusReadySessionId = sessionId;
                                window.voiceCaptureAPI.focusReady({
                                    sessionId,
                                    editable: true,
                                    selectionStart: input.selectionStart,
                                    selectionEnd: input.selectionEnd,
                                });
                            }
                            return;
                        }

                        retries += 1;
                        state.textContent = '正在选择输入区';
                        if (retries < 10) {
                            setTimeout(establishEditableFocus, 60);
                        } else {
                            state.textContent = '输入区聚焦失败';
                        }
                    }, 120);
                });
            });
        };

        establishEditableFocus();
    };

    input.addEventListener('compositionstart', () => {
        composing = true;
        state.textContent = '正在识别';
        report(false);
    });

    input.addEventListener('compositionupdate', () => report(false));

    input.addEventListener('compositionend', () => {
        composing = false;
        state.textContent = isStopping ? '听写结束' : '正在听写';
        report(isStopping);
    });

    input.addEventListener('input', () => report(false));

    window.voiceCaptureAPI.onPrepare(payload => {
        sessionId = payload?.sessionId || null;
        focusReadySessionId = null;
        isStopping = false;
        input.value = '';
        composing = false;
        state.textContent = '正在选择输入区';
        report(false);
        focusAndConfirm();
    });

    window.voiceCaptureAPI.onStop(() => {
        focusAttemptToken += 1;
        isStopping = true;
        state.textContent = composing ? '等待文字上屏' : '听写结束';
        report(!composing);
    });

    window.addEventListener('focus', () => {
        if (sessionId && focusReadySessionId !== sessionId) {
            focusAndConfirm();
        }
    });
    window.voiceCaptureAPI.ready();
});