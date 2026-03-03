use device_query::{DeviceQuery, DeviceState};

#[derive(Debug, Clone)]
pub struct SelectionSignal {
    pub mouse_start_x: i32,
    pub mouse_start_y: i32,
    pub mouse_x: i32,
    pub mouse_y: i32,
    pub keyboard_triggered: bool,
    pub mouse_origin_known: bool,
}

#[derive(Debug, Clone)]
pub struct WindowsEventSource {
    last_left_pressed: bool,
    last_ctrl_c_pressed: bool,
    mouse_press_origin: Option<(i32, i32)>,
}

impl WindowsEventSource {
    pub fn new() -> Self {
        Self {
            last_left_pressed: false,
            last_ctrl_c_pressed: false,
            mouse_press_origin: None,
        }
    }

    pub fn poll_signal(&mut self) -> Option<SelectionSignal> {
        let device_state = DeviceState::new();
        let mouse_state = device_state.get_mouse();

        let left_pressed = current_left_button_pressed(&mouse_state.button_pressed);
        let ctrl_c_pressed = current_ctrl_c_pressed();

        if !self.last_left_pressed && left_pressed {
            self.mouse_press_origin = Some((mouse_state.coords.0, mouse_state.coords.1));
        }

        let mouse_release_triggered = self.last_left_pressed && !left_pressed;
        let keyboard_copy_triggered = self.last_ctrl_c_pressed && !ctrl_c_pressed;

        self.last_left_pressed = left_pressed;
        self.last_ctrl_c_pressed = ctrl_c_pressed;

        if mouse_release_triggered {
            let (start_x, start_y, mouse_origin_known) = match self.mouse_press_origin {
                Some((x, y)) => (x, y, true),
                None => (mouse_state.coords.0, mouse_state.coords.1, false),
            };
            self.mouse_press_origin = None;

            return Some(SelectionSignal {
                mouse_start_x: start_x,
                mouse_start_y: start_y,
                mouse_x: mouse_state.coords.0,
                mouse_y: mouse_state.coords.1,
                keyboard_triggered: false,
                mouse_origin_known,
            });
        }

        if keyboard_copy_triggered {
            return Some(SelectionSignal {
                mouse_start_x: mouse_state.coords.0,
                mouse_start_y: mouse_state.coords.1,
                mouse_x: mouse_state.coords.0,
                mouse_y: mouse_state.coords.1,
                keyboard_triggered: true,
                mouse_origin_known: false,
            });
        }

        None
    }
}

#[cfg(target_os = "windows")]
fn is_key_pressed(vk: i32) -> bool {
    use winapi::um::winuser::GetAsyncKeyState;
    unsafe { ((GetAsyncKeyState(vk) as i32) & 0x8000) != 0 }
}

#[cfg(not(target_os = "windows"))]
fn is_key_pressed(_vk: i32) -> bool {
    false
}

fn current_ctrl_c_pressed() -> bool {
    const VK_C: i32 = 0x43;
    const VK_CONTROL: i32 = 0x11;
    is_key_pressed(VK_CONTROL) && is_key_pressed(VK_C)
}

#[cfg(target_os = "windows")]
fn current_left_button_pressed(_buttons: &[bool]) -> bool {
    const VK_LBUTTON: i32 = 0x01;
    is_key_pressed(VK_LBUTTON)
}

#[cfg(not(target_os = "windows"))]
fn current_left_button_pressed(buttons: &[bool]) -> bool {
    buttons.get(0).copied().unwrap_or(false)
}
