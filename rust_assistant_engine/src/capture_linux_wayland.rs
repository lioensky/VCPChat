use device_query::{DeviceQuery, DeviceState, Keycode};

use crate::windows_event_source::SelectionSignal;

#[derive(Debug)]
pub struct LinuxWaylandEventSource {
    device_state: DeviceState,
    last_copy_pressed: bool,
}

impl LinuxWaylandEventSource {
    pub fn new() -> Self {
        Self {
            device_state: DeviceState::new(),
            last_copy_pressed: false,
        }
    }

    pub fn poll_signal(&mut self) -> Option<SelectionSignal> {
        // 问题6修复：使用成员变量而非每次创建
        let mouse_state = self.device_state.get_mouse();
        let keys = self.device_state.get_keys();

        let copy_pressed = is_copy_pressed(&keys);
        let keyboard_copy_triggered = self.last_copy_pressed && !copy_pressed;
        self.last_copy_pressed = copy_pressed;

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
