'use strict';

document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('captureInput');
    const state = document.getElementById('captureState');
    let composing = false;
    let sessionId = null;

    const report = () => {
        window.voiceCaptureAPI.update({
            text: input.value,
            composing,
            updatedAt: Date.now(),
            sessionId,
        });
    };

    const focusAndConfirm = () => {
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);

        requestAnimationFrame(() => {
            const focused = document.activeElement === input;
            state.textContent = focused ? '正在听写' : '等待焦点';
            if (focused) {
                window.voiceCaptureAPI.focusReady();
            }
        });
    };

    input.addEventListener('compositionstart', () => {
        composing = true;
        state.textContent = '正在识别';
        report();
    });

    input.addEventListener('compositionupdate', report);

    input.addEventListener('compositionend', () => {
        composing = false;
        state.textContent = '正在听写';
        report();
    });

    input.addEventListener('input', report);

    window.voiceCaptureAPI.onPrepare(payload => {
        sessionId = payload?.sessionId || null;
        input.value = '';
        composing = false;
        state.textContent = '准备听写';
        report();
        focusAndConfirm();
    });

    window.voiceCaptureAPI.onStop(() => {
        state.textContent = composing ? '等待文字上屏' : '听写结束';
        report();
    });

    window.addEventListener('focus', focusAndConfirm);
    window.voiceCaptureAPI.ready();
});