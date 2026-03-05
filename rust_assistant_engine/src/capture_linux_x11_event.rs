use std::time::{Duration, Instant};

use log::info;
use x11rb::connection::Connection;
use x11rb::protocol::xfixes::{ConnectionExt as XfixesConnectionExt, SelectionEventMask};
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as XprotoConnectionExt, Window};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

use crate::windows_event_source::SelectionSignal;

const X11_EVENT_DEBOUNCE_MS: u64 = 40;

#[derive(Debug)]
pub struct X11SelectionEventBackend {
    connection: RustConnection,
    root: Window,
    primary_atom: u32,
    clipboard_atom: u32,
    last_signal_at: Option<Instant>,
}

impl X11SelectionEventBackend {
    pub fn connect() -> Option<Self> {
        let (connection, screen_index) = match RustConnection::connect(None) {
            Ok(pair) => pair,
            Err(error) => {
                info!("[LinuxX11Event] Connect failed: {}", error);
                return None;
            }
        };

        if let Err(error) = connection.xfixes_query_version(5, 0).and_then(|cookie| cookie.reply()) {
            info!("[LinuxX11Event] XFixes unavailable: {}", error);
            return None;
        }

        let root = match connection.setup().roots.get(screen_index) {
            Some(screen) => screen.root,
            None => {
                info!("[LinuxX11Event] Invalid screen index: {}", screen_index);
                return None;
            }
        };

        let primary_atom = match intern_atom(&connection, b"PRIMARY") {
            Some(atom) => atom,
            None => {
                info!("[LinuxX11Event] Failed to intern PRIMARY atom");
                return None;
            }
        };

        let clipboard_atom = match intern_atom(&connection, b"CLIPBOARD") {
            Some(atom) => atom,
            None => {
                info!("[LinuxX11Event] Failed to intern CLIPBOARD atom");
                return None;
            }
        };

        let mask = SelectionEventMask::SET_SELECTION_OWNER
            | SelectionEventMask::SELECTION_WINDOW_DESTROY
            | SelectionEventMask::SELECTION_CLIENT_CLOSE;

        if let Err(error) = connection
            .xfixes_select_selection_input(root, primary_atom, mask)
            .and_then(|cookie| cookie.check())
        {
            info!(
                "[LinuxX11Event] Subscribe PRIMARY failed (fallback to polling): {}",
                error
            );
            return None;
        }

        if let Err(error) = connection
            .xfixes_select_selection_input(root, clipboard_atom, mask)
            .and_then(|cookie| cookie.check())
        {
            info!(
                "[LinuxX11Event] Subscribe CLIPBOARD failed (fallback to polling): {}",
                error
            );
            return None;
        }

        if let Err(error) = connection.flush() {
            info!("[LinuxX11Event] Flush failed: {}", error);
            return None;
        }

        info!("[LinuxX11Event] XFixes selection backend enabled");

        Some(Self {
            connection,
            root,
            primary_atom,
            clipboard_atom,
            last_signal_at: None,
        })
    }

    pub fn poll_signal(&mut self) -> Option<SelectionSignal> {
        let event = match self.connection.poll_for_event() {
            Ok(event) => event,
            Err(error) => {
                info!(
                    "[LinuxX11Event] poll_for_event failed, fallback path continues: {}",
                    error
                );
                return None;
            }
        }?;

        let selection = match event {
            Event::XfixesSelectionNotify(notify) => notify.selection,
            _ => return None,
        };

        if selection != self.primary_atom && selection != self.clipboard_atom {
            return None;
        }

        if let Some(last_signal_at) = self.last_signal_at {
            if last_signal_at.elapsed() < Duration::from_millis(X11_EVENT_DEBOUNCE_MS) {
                return None;
            }
        }

        self.last_signal_at = Some(Instant::now());

        let pointer = match self.connection.query_pointer(self.root).and_then(|cookie| cookie.reply()) {
            Ok(reply) => reply,
            Err(error) => {
                info!("[LinuxX11Event] query_pointer failed: {}", error);
                return None;
            }
        };

        let keyboard_triggered = selection == self.clipboard_atom;

        Some(SelectionSignal {
            mouse_start_x: pointer.root_x.into(),
            mouse_start_y: pointer.root_y.into(),
            mouse_x: pointer.root_x.into(),
            mouse_y: pointer.root_y.into(),
            keyboard_triggered,
            mouse_origin_known: false,
        })
    }
}

fn intern_atom(connection: &RustConnection, name: &[u8]) -> Option<u32> {
    connection
        .intern_atom(false, name)
        .ok()?
        .reply()
        .ok()
        .map(|reply| reply.atom)
        .filter(|atom| *atom != u32::from(AtomEnum::NONE))
}
