use device_query::{DeviceQuery, DeviceState, Keycode};

use crate::windows_event_source::SelectionSignal;

#[derive(Debug)]
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
        // 注意: DeviceState 内部包含 Rc<X11Connection>，不支持跨线程 Send
        // 每次创建实例是必要的，以避免线程安全问题
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
    let has_c = keys.contains(&Keycode::C);
    let has_control = keys
        .iter()
        .any(|key| matches!(key, Keycode::LControl | Keycode::RControl));
    has_c && has_control
}
