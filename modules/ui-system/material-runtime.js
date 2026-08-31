// MaterialRuntime owns opacity/blur/saturation/brightness/shadow CSS variables.
(() => {
    class MaterialRuntime {
        apply(resolved, documentRef = globalThis.document) {
            let node = documentRef.getElementById('vcpAppearanceMaterialVariables');
            if (!node) { node = documentRef.createElement('style'); node.id = 'vcpAppearanceMaterialVariables'; documentRef.head.append(node); }
            const shadowColorStrength = Math.round(resolved.surfaceShadow * 0.4);
            const softSheenStrength = Math.round(resolved.surfaceSheen * 0.35);
            const liquidBlur = Math.round(resolved.surfaceBlur * 0.55 * 10) / 10;
            node.textContent = `:root{--vcp-material-opacity:${resolved.surfaceOpacity}%;--vcp-material-blur:${resolved.surfaceBlur}px;--vcp-material-saturation:${resolved.surfaceSaturation}%;--vcp-material-brightness:${resolved.surfaceBrightness}%;--vcp-material-border:${resolved.surfaceBorder}%;--vcp-material-shadow:${resolved.surfaceShadow}%;--vcp-material-shadow-color:${shadowColorStrength}%;--vcp-material-sheen:${resolved.surfaceSheen}%;--vcp-material-sheen-soft:${softSheenStrength}%;--vcp-material-liquid-blur:${liquidBlur}px;}`;
            return node;
        }
    }
    globalThis.VCPMaterialRuntime = MaterialRuntime;
})();
