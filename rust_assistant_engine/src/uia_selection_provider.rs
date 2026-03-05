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

        #[cfg(target_os = "macos")]
        {
            get_selected_text_macos()
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            None
        }
    }
}

#[cfg(target_os = "macos")]
pub fn macos_ax_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
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

#[cfg(target_os = "macos")]
fn get_selected_text_macos() -> Option<String> {
    if !macos_ax_trusted() {
        return None;
    }

    let focused_attr = create_cfstring("AXFocusedUIElement")?;
    let selected_text_attr = create_cfstring("AXSelectedText")?;

    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        unsafe {
            CFRelease(focused_attr as CFTypeRef);
            CFRelease(selected_text_attr as CFTypeRef);
        }
        return None;
    }

    let mut focused_value: CFTypeRef = std::ptr::null();
    let focused_result = unsafe {
        AXUIElementCopyAttributeValue(system, focused_attr, &mut focused_value as *mut CFTypeRef)
    };

    unsafe {
        CFRelease(system as CFTypeRef);
        CFRelease(focused_attr as CFTypeRef);
    }

    if focused_result != K_AX_ERROR_SUCCESS || focused_value.is_null() {
        unsafe {
            CFRelease(selected_text_attr as CFTypeRef);
        }
        return None;
    }

    let focused_element = focused_value as AXUIElementRef;
    let mut selected_value: CFTypeRef = std::ptr::null();
    let selected_result = unsafe {
        AXUIElementCopyAttributeValue(
            focused_element,
            selected_text_attr,
            &mut selected_value as *mut CFTypeRef,
        )
    };

    unsafe {
        CFRelease(focused_element as CFTypeRef);
        CFRelease(selected_text_attr as CFTypeRef);
    }

    if selected_result != K_AX_ERROR_SUCCESS || selected_value.is_null() {
        return None;
    }

    let output = cf_type_to_text(selected_value)
        .map(|value| value.replace("\r\n", "\n").trim().to_string())
        .filter(|value| !value.is_empty());

    unsafe {
        CFRelease(selected_value);
    }

    output
}

#[cfg(target_os = "macos")]
fn create_cfstring(value: &str) -> Option<CFStringRef> {
    let c_value = std::ffi::CString::new(value).ok()?;
    let cf = unsafe {
        CFStringCreateWithCString(
            std::ptr::null(),
            c_value.as_ptr(),
            K_CF_STRING_ENCODING_UTF8,
        )
    };
    if cf.is_null() {
        None
    } else {
        Some(cf)
    }
}

#[cfg(target_os = "macos")]
fn cf_type_to_text(value: CFTypeRef) -> Option<String> {
    if value.is_null() {
        return None;
    }

    let value_type = unsafe { CFGetTypeID(value) };
    let string_type = unsafe { CFStringGetTypeID() };

    if value_type == string_type {
        return cf_string_to_string(value as CFStringRef);
    }

    let array_type = unsafe { CFArrayGetTypeID() };
    if value_type != array_type {
        return None;
    }

    let array = value as CFArrayRef;
    let count = unsafe { CFArrayGetCount(array) };
    if count <= 0 {
        return None;
    }

    let mut parts = Vec::new();
    for idx in 0..count {
        let item = unsafe { CFArrayGetValueAtIndex(array, idx) } as CFTypeRef;
        if item.is_null() {
            continue;
        }
        let item_type = unsafe { CFGetTypeID(item) };
        if item_type != string_type {
            continue;
        }
        if let Some(text) = cf_string_to_string(item as CFStringRef) {
            if !text.trim().is_empty() {
                parts.push(text);
            }
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

#[cfg(target_os = "macos")]
fn cf_string_to_string(value: CFStringRef) -> Option<String> {
    let len = unsafe { CFStringGetLength(value) };
    if len < 0 {
        return None;
    }

    let cap = unsafe { CFStringGetMaximumSizeForEncoding(len, K_CF_STRING_ENCODING_UTF8) };
    if cap < 0 {
        return None;
    }

    let mut buffer = vec![0i8; cap as usize + 1];
    let ok = unsafe {
        CFStringGetCString(
            value,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            K_CF_STRING_ENCODING_UTF8,
        )
    };
    if ok == 0 {
        return None;
    }

    let cstr = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) };
    Some(cstr.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
type CFTypeRef = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type CFStringRef = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type CFArrayRef = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type CFAllocatorRef = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type AXUIElementRef = *const std::ffi::c_void;
#[cfg(target_os = "macos")]
type CFTypeID = usize;
#[cfg(target_os = "macos")]
type CFIndex = isize;
#[cfg(target_os = "macos")]
type Boolean = u8;
#[cfg(target_os = "macos")]
type AXError = i32;

#[cfg(target_os = "macos")]
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
#[cfg(target_os = "macos")]
const K_AX_ERROR_SUCCESS: AXError = 0;

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> Boolean;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: CFTypeRef);
    fn CFGetTypeID(value: CFTypeRef) -> CFTypeID;
    fn CFArrayGetTypeID() -> CFTypeID;
    fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, index: CFIndex) -> *const std::ffi::c_void;
    fn CFStringGetTypeID() -> CFTypeID;
    fn CFStringCreateWithCString(
        alloc: CFAllocatorRef,
        c_str: *const std::ffi::c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFStringGetLength(value: CFStringRef) -> CFIndex;
    fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
    fn CFStringGetCString(
        value: CFStringRef,
        buffer: *mut std::ffi::c_char,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> Boolean;
}
