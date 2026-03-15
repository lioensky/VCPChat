use device_query::{DeviceQuery, DeviceState, Keycode};

use crate::windows_event_source::SelectionSignal;

#[derive(Debug)]
pub struct LinuxX11EventSource {
    last_left_pressed: bool,
    last_copy_pressed: bool,
    mouse_press_origin: Option<(i32, i32)>,
}

impl LinuxX11EventSource {
    pub fn new() -> Self {
        Self {
            last_left_pressed: false,
            last_copy_pressed: false,
            mouse_press_origin: None,
        }
    }

    pub fn poll_signal(&mut self) -> Option<SelectionSignal> {
        // 注意: DeviceState 内部包含 Rc<X11Connection>，不支持跨线程 Send
        // 每次创建实例是必要的，以避免线程安全问题
        let device_state = DeviceState::new();
        let mouse_state = device_state.get_mouse();
        let keys = device_state.get_keys();

        let left_pressed = mouse_state.button_pressed.get(0).copied().unwrap_or(false);
        let copy_pressed = is_copy_pressed(&keys);

        if !self.last_left_pressed && left_pressed {
            self.mouse_press_origin = Some((mouse_state.coords.0, mouse_state.coords.1));
        }

        let mouse_release_triggered = self.last_left_pressed && !left_pressed;
        let keyboard_copy_triggered = self.last_copy_pressed && !copy_pressed;

        self.last_left_pressed = left_pressed;
        self.last_copy_pressed = copy_pressed;

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

fn is_copy_pressed(keys: &[Keycode]) -> bool {
    let has_c = keys.contains(&Keycode::C);
    let has_control = keys
        .iter()
        .any(|key| matches!(key, Keycode::LControl | Keycode::RControl));
    has_c && has_control
}
