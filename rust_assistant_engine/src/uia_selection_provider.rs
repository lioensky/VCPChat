#[derive(Debug, Clone, Default)]
pub struct UiaSelectionProvider;

impl UiaSelectionProvider {
    pub fn new() -> Self {
        Self
    }

    pub fn get_selected_text(&self) -> Option<String> {
        #[cfg(target_os = "windows")]
        {
            get_selected_text_windows()
        }

        #[cfg(not(target_os = "windows"))]
        {
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn get_selected_text_windows() -> Option<String> {
    use windows::core::Interface;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationTextPattern, IUIAutomationTextRangeArray,
        UIA_TextPatternId,
    };

    struct ComScope;
    impl Drop for ComScope {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return None;
        }
    }
    let _com_scope = ComScope;

    let automation: IUIAutomation = unsafe {
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?
    };

    let focused = unsafe { automation.GetFocusedElement().ok()? };

    let pattern = unsafe { focused.GetCurrentPattern(UIA_TextPatternId).ok()? };
    let text_pattern: IUIAutomationTextPattern = pattern.cast().ok()?;

    let selection: IUIAutomationTextRangeArray = unsafe { text_pattern.GetSelection().ok()? };
    let length = unsafe { selection.Length().ok()? };
    if length <= 0 {
        return None;
    }

    let range = unsafe { selection.GetElement(0).ok()? };
    let text = unsafe { range.GetText(-1).ok()? };
    let normalized = text.to_string().replace("\r\n", "\n").trim().to_string();

    if normalized.is_empty() {
        return None;
    }

    Some(normalized)
}
