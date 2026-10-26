//! The controller brings Black Flag back: holding the Xbox/PS button, or View + Menu together,
//! shows the window again from inside a game. The page reads the controller only while it has
//! the focus (Gamepad API), so this is read natively, through XInput (Xbox controllers, and
//! PlayStation controllers through Steam Input or DS4Windows).
//!
//! The same thread watches the controllers: one that drops, or whose battery runs low, is told
//! about over the game (lib.rs `pad_alert`).

use serde::Serialize;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub const GUIDE: u16 = 0x0400;
pub const BACK: u16 = 0x0020;
pub const START: u16 = 0x0010;
/// How long the buttons must be held: a short press of the Xbox button is the Game Bar's.
pub const HOLD: Duration = Duration::from_millis(700);
const TICK: Duration = Duration::from_millis(100);
/// Asking an empty slot is slow in XInput, so empty slots are asked only every 2 s.
const EMPTY_EVERY: u32 = 20;
/// The battery changes slowly: asked every 30 s.
const BATTERY_EVERY: u32 = 300;

#[repr(C)]
#[derive(Default)]
#[allow(dead_code)]
struct XState {
    packet: u32,
    buttons: u16,
    left_trigger: u8,
    right_trigger: u8,
    lx: i16,
    ly: i16,
    rx: i16,
    ry: i16,
}

#[repr(C)]
#[derive(Default)]
struct XBattery {
    kind: u8,
    level: u8,
}

type GetState = unsafe extern "system" fn(u32, *mut XState) -> u32;
type GetBattery = unsafe extern "system" fn(u32, u8, *mut XBattery) -> u32;

struct XInput {
    state: GetState,
    battery: Option<GetBattery>,
}

/// XInputGetStateEx (ordinal 100) also reports the Xbox button; plain XInputGetState does not.
fn xinput() -> Option<&'static XInput> {
    static X: OnceLock<Option<XInput>> = OnceLock::new();
    X.get_or_init(|| {
        use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
        for dll in ["xinput1_4.dll", "xinput1_3.dll"] {
            let name: Vec<u16> = dll.encode_utf16().chain(std::iter::once(0)).collect();
            // SAFETY: a NUL-terminated name; the library stays loaded for the life of the program.
            unsafe {
                let lib = LoadLibraryW(name.as_ptr());
                if lib.is_null() {
                    continue;
                }
                let f = GetProcAddress(lib, 100usize as *const u8).or_else(|| GetProcAddress(lib, b"XInputGetState\0".as_ptr()));
                if let Some(f) = f {
                    let battery = GetProcAddress(lib, b"XInputGetBatteryInformation\0".as_ptr())
                        .map(|b| std::mem::transmute::<unsafe extern "system" fn() -> isize, GetBattery>(b));
                    return Some(XInput { state: std::mem::transmute::<unsafe extern "system" fn() -> isize, GetState>(f), battery });
                }
            }
        }
        None
    })
    .as_ref()
}

/// A controller seen through XInput, for the "Testar controle" screen.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct PadInfo {
    /// 1 to 4, as the light on an Xbox controller.
    pub number: u32,
    pub wireless: bool,
    /// 0 empty, 1 low, 2 medium, 3 full; None when wired or not told.
    pub battery: Option<u8>,
}

const BATTERY_WIRED: u8 = 1;
const BATTERY_ALKALINE: u8 = 2;
const BATTERY_NIMH: u8 = 3;

/// (wireless, level) of the controller in `slot`.
fn battery_of(x: &XInput, slot: u32) -> (bool, Option<u8>) {
    let Some(get) = x.battery else { return (false, None) };
    let mut b = XBattery::default();
    // SAFETY: `b` has XINPUT_BATTERY_INFORMATION's layout; 0 asks about the controller itself.
    if unsafe { get(slot, 0, &mut b) } != 0 {
        return (false, None);
    }
    match b.kind {
        BATTERY_WIRED => (false, None),
        BATTERY_ALKALINE | BATTERY_NIMH => (true, Some(b.level.min(3))),
        // Unknown: a wireless controller that does not tell.
        _ => (true, None),
    }
}

/// The controllers connected now.
pub fn status() -> Vec<PadInfo> {
    let Some(x) = xinput() else { return Vec::new() };
    (0..4u32)
        .filter_map(|slot| {
            let mut s = XState::default();
            // SAFETY: `s` has XInput's XINPUT_STATE layout and lives across the call.
            if unsafe { (x.state)(slot, &mut s) } != 0 {
                return None;
            }
            let (wireless, battery) = battery_of(x, slot);
            Some(PadInfo { number: slot + 1, wireless, battery })
        })
        .collect()
}

/// What is worth telling about a controller (its number, 1 to 4).
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Alert {
    Lost(u32),
    Back(u32),
    Low(u32),
    Empty(u32),
}

/// Remembers each slot, so that only changes are told: nothing on the first look, a battery
/// warning once per level going down, and "de volta" only after "desconectado".
#[derive(Default)]
pub struct Alerts {
    connected: [Option<bool>; 4],
    lost: [bool; 4],
    warned: [Option<u8>; 4],
}

impl Alerts {
    pub fn connection(&mut self, slot: usize, on: bool) -> Option<Alert> {
        let was = self.connected[slot].replace(on);
        let number = slot as u32 + 1;
        match (was, on) {
            (Some(true), false) => {
                self.lost[slot] = true;
                self.warned[slot] = None;
                Some(Alert::Lost(number))
            }
            (Some(false), true) if self.lost[slot] => {
                self.lost[slot] = false;
                Some(Alert::Back(number))
            }
            _ => None,
        }
    }

    /// `level` as in `PadInfo::battery`.
    pub fn battery(&mut self, slot: usize, level: Option<u8>) -> Option<Alert> {
        let number = slot as u32 + 1;
        match level {
            Some(l) if l <= 1 => {
                if self.warned[slot].map(|w| l < w).unwrap_or(true) {
                    self.warned[slot] = Some(l);
                    return Some(if l == 0 { Alert::Empty(number) } else { Alert::Low(number) });
                }
                None
            }
            // Charged again (or new batteries): the next drop is told again.
            Some(_) => {
                self.warned[slot] = None;
                None
            }
            None => None,
        }
    }
}

/// The buttons that call Black Flag back.
pub fn calls_back(buttons: u16) -> bool {
    buttons & GUIDE != 0 || (buttons & BACK != 0 && buttons & START != 0)
}

/// Holding state: fires once per hold, after `HOLD`.
#[derive(Default)]
pub struct Hold {
    since: Option<Instant>,
    fired: bool,
}

impl Hold {
    pub fn update(&mut self, pressed: bool, now: Instant) -> bool {
        if !pressed {
            *self = Hold::default();
            return false;
        }
        let since = *self.since.get_or_insert(now);
        if !self.fired && now.duration_since(since) >= HOLD {
            self.fired = true;
            return true;
        }
        false
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(x) = xinput() else { return };
        let mut connected = [true; 4];
        let mut alerts = Alerts::default();
        let mut hold = Hold::default();
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(TICK);
            tick = tick.wrapping_add(1);
            let mut pressed = false;
            for (slot, on) in connected.iter_mut().enumerate() {
                if !*on && tick % EMPTY_EVERY != 0 {
                    continue;
                }
                let mut s = XState::default();
                // SAFETY: `s` has XInput's XINPUT_STATE layout and lives across the call.
                let now_on = unsafe { (x.state)(slot as u32, &mut s) } == 0;
                let came = now_on && !*on;
                *on = now_on;
                pressed |= now_on && calls_back(s.buttons);
                if let Some(a) = alerts.connection(slot, now_on) {
                    crate::pad_alert(&app, a);
                }
                if now_on && (came || tick % BATTERY_EVERY == 1) {
                    if let Some(a) = alerts.battery(slot, battery_of(x, slot as u32).1) {
                        crate::pad_alert(&app, a);
                    }
                }
            }
            if hold.update(pressed, Instant::now()) {
                crate::tray::show_window(&app);
                // show() is carried out by the window thread; give it a moment.
                std::thread::sleep(Duration::from_millis(150));
                crate::play::bring_own_window();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_buttons_call_back() {
        assert!(calls_back(GUIDE));
        assert!(calls_back(BACK | START | 0x1000));
        assert!(!calls_back(BACK));
        assert!(!calls_back(START | 0x1000));
        assert_eq!(std::mem::size_of::<XState>(), 16);
        assert_eq!(std::mem::size_of::<XBattery>(), 2);
    }

    #[test]
    fn tells_only_changes() {
        let mut a = Alerts::default();
        // First look: nothing, connected or not.
        assert_eq!(a.connection(0, true), None);
        assert_eq!(a.connection(1, false), None);
        assert_eq!(a.connection(0, true), None);
        assert_eq!(a.connection(0, false), Some(Alert::Lost(1)));
        assert_eq!(a.connection(0, false), None);
        assert_eq!(a.connection(0, true), Some(Alert::Back(1)));
        // A controller plugged in for the first time is not "de volta".
        assert_eq!(a.connection(1, true), None);
    }

    #[test]
    fn warns_once_per_battery_level() {
        let mut a = Alerts::default();
        assert_eq!(a.battery(0, Some(3)), None);
        assert_eq!(a.battery(0, Some(2)), None);
        assert_eq!(a.battery(0, Some(1)), Some(Alert::Low(1)));
        assert_eq!(a.battery(0, Some(1)), None);
        assert_eq!(a.battery(0, Some(0)), Some(Alert::Empty(1)));
        assert_eq!(a.battery(0, Some(0)), None);
        assert_eq!(a.battery(0, Some(1)), None);
        assert_eq!(a.battery(0, None), None);
        // Charged, then low again: told again.
        assert_eq!(a.battery(0, Some(3)), None);
        assert_eq!(a.battery(0, Some(1)), Some(Alert::Low(1)));
        // Already empty on the first look: told as empty.
        assert_eq!(a.battery(2, Some(0)), Some(Alert::Empty(3)));
    }

    #[test]
    fn fires_once_after_holding() {
        let t = Instant::now();
        let mut h = Hold::default();
        assert!(!h.update(true, t));
        assert!(!h.update(true, t + Duration::from_millis(300)));
        assert!(h.update(true, t + HOLD));
        assert!(!h.update(true, t + HOLD * 3));
        assert!(!h.update(false, t + HOLD * 4));
        assert!(!h.update(true, t + HOLD * 5));
        assert!(h.update(true, t + HOLD * 6));
    }
}
