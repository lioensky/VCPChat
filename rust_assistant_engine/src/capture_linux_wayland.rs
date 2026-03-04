use device_query::{DeviceQuery, DeviceState, Keycode};

use crate::windows_event_source::SelectionSignal;

#[derive(Debug, Clone)]
pub struct LinuxWaylandEventSource {
    last_copy_pressed: bool,
}

impl LinuxWaylandEventSource {
    pub fn new() -> Self {
        Self {
            last_copy_pressed: false,
        }
    }

    pub fn poll_signal(&mut self) -> Option<SelectionSignal> {
        let device_state = DeviceState::new();
        let mouse_state = device_state.get_mouse();
        let keys = device_state.get_keys();

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
    let has_c = has_key(keys, "C");
    let has_control = has_any_key(keys, &["LControl", "RControl", "Control"]);
    has_c && has_control
}

fn has_any_key(keys: &[Keycode], names: &[&str]) -> bool {
    names.iter().any(|name| has_key(keys, name))
}

fn has_key(keys: &[Keycode], name: &str) -> bool {
    keys.iter().any(|key| format!("{:?}", key).eq_ignore_ascii_case(name))
}
