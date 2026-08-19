/* Backward-compatible facade. Next implementation lives in NextShellController. */
(() => {
    const controller = () => window.VCPNextShellController;
    window.topTabManager = Object.freeze({
        init: (...args) => controller()?.init(...args),
        mount: (...args) => controller()?.mount(...args),
        unmount: (...args) => controller()?.unmount(...args),
        isMounted: () => controller()?.isMounted?.() === true,
        openAccountMenu: (...args) => controller()?.openAccountMenu(...args),
        openLaunchpad: (...args) => controller()?.openLaunchpad(...args),
        openCreateDialog: (...args) => controller()?.openCreateDialog(...args),
        openInternalApp: (...args) => controller()?.openInternalApp(...args),
        openEmbeddedApp: (...args) => controller()?.openEmbeddedApp(...args),
        closeView: (...args) => controller()?.closeView(...args),
        setView: (...args) => controller()?.setView(...args),
        acquireOverlay: (...args) => controller()?.acquireOverlay(...args),
        releaseOverlay: (...args) => controller()?.releaseOverlay(...args),
        getSnapshot: () => controller()?.getAppTabSnapshot?.() || null,
        whenSettled: (...args) => controller()?.whenAppTabsSettled?.(...args) || Promise.resolve(null),
    });
})();
