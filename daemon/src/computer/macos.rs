//! The macOS calls computer use makes (PLX-897, 0077): Accessibility to read an app's window and
//! act on its elements, `CGWindowList` to find its windows, and Quartz events posted to the app's
//! process, so clicks and keys reach it without moving the user's pointer or taking focus. This is
//! the only module besides `windows.rs` allowed `unsafe` code, and every `unsafe` block says why it
//! is sound. Everything here blocks on the app's answer, so callers run it off the async runtime.

#![allow(unsafe_code)]

use std::ffi::c_void;
use std::time::Duration;

use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFType, CFTypeID, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};

use super::{Info, Point, Rect};

type AxError = i32;
type Pid = i32;

const AX_SUCCESS: AxError = 0;
const AX_VALUE_CG_POINT: u32 = 1;
const AX_VALUE_CG_SIZE: u32 = 2;
const AX_VALUE_ERROR: u32 = 5;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CgPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CgSize {
    width: f64,
    height: f64,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
    fn AXUIElementGetTypeID() -> CFTypeID;
    fn AXUIElementCreateApplication(pid: Pid) -> CFTypeRef;
    fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> AxError;
    fn AXUIElementCopyAttributeValue(
        element: CFTypeRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AxError;
    fn AXUIElementCopyMultipleAttributeValues(
        element: CFTypeRef,
        attributes: CFArrayRef,
        options: u32,
        values: *mut CFArrayRef,
    ) -> AxError;
    fn AXUIElementCopyActionNames(element: CFTypeRef, names: *mut CFArrayRef) -> AxError;
    fn AXUIElementPerformAction(element: CFTypeRef, action: CFStringRef) -> AxError;
    fn AXUIElementSetAttributeValue(
        element: CFTypeRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AxError;
    fn AXValueGetTypeID() -> CFTypeID;
    fn AXValueGetType(value: CFTypeRef) -> u32;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
    fn CGEventCreateMouseEvent(
        source: CFTypeRef,
        kind: u32,
        location: CgPoint,
        button: u32,
    ) -> CFTypeRef;
    fn CGEventCreateKeyboardEvent(source: CFTypeRef, key: u16, down: bool) -> CFTypeRef;
    fn CGEventCreateScrollWheelEvent2(
        source: CFTypeRef,
        units: u32,
        wheels: u32,
        vertical: i32,
        horizontal: i32,
        unused: i32,
    ) -> CFTypeRef;
    fn CGEventKeyboardSetUnicodeString(event: CFTypeRef, length: usize, text: *const u16);
    fn CGEventSetFlags(event: CFTypeRef, flags: u64);
    fn CGEventSetLocation(event: CFTypeRef, location: CgPoint);
    fn CGEventSetIntegerValueField(event: CFTypeRef, field: u32, value: i64);
    fn CGEventPostToPid(pid: Pid, event: CFTypeRef);
}

/// A retained Accessibility element of another app: a window, a button, a text field.
#[derive(Clone)]
pub struct Element(CFType);

// SAFETY: an AXUIElement is an immutable reference to another process's UI object, and
// Accessibility calls on it may come from any thread. CFType's retain and release are atomic.
unsafe impl Send for Element {}
// SAFETY: as above; no method mutates the reference itself.
unsafe impl Sync for Element {}

/// Whether plxd has the Accessibility permission, after showing macOS's prompt for it when
/// `prompt` and it doesn't.
pub fn accessibility(prompt: bool) -> bool {
    if !prompt {
        // SAFETY: takes no arguments and only reads this process's permission.
        return unsafe { AXIsProcessTrusted() };
    }
    // SAFETY: the key is a constant the framework exports, valid for the process's lifetime.
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
    // SAFETY: `options` is a valid dictionary that outlives the call.
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
}

/// Whether plxd has the Screen Recording permission, after asking macOS for it when `request`.
pub fn screen_recording(request: bool) -> bool {
    // SAFETY: neither takes arguments; both only read or ask for this process's permission.
    unsafe { CGPreflightScreenCaptureAccess() || (request && CGRequestScreenCaptureAccess()) }
}

/// The app with process `pid`'s Accessibility element, waiting at most a few seconds on each of
/// its answers.
pub fn application(pid: i32) -> Element {
    // SAFETY: returns a new reference (the create rule), for any pid; a pid without an app only
    // fails the calls made on it.
    let app = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid)) };
    // SAFETY: `app` is a valid element.
    unsafe { AXUIElementSetMessagingTimeout(app.as_CFTypeRef(), 3.0) };
    Element(app)
}

impl Element {
    fn raw(&self) -> CFTypeRef {
        self.0.as_CFTypeRef()
    }

    /// The value of `attribute`, if the element has one.
    fn attribute(&self, attribute: &str) -> Option<CFType> {
        let name = CFString::new(attribute);
        let mut value: CFTypeRef = std::ptr::null();
        // SAFETY: the element and name are valid, and `value` receives a new reference or stays
        // null.
        let error = unsafe {
            AXUIElementCopyAttributeValue(self.raw(), name.as_concrete_TypeRef(), &raw mut value)
        };
        // SAFETY: a successful copy returned a new, non-null reference.
        (error == AX_SUCCESS && !value.is_null())
            .then(|| unsafe { CFType::wrap_under_create_rule(value) })
    }

    /// The element `attribute` names, such as `AXFocusedWindow`.
    pub fn element(&self, attribute: &str) -> Option<Element> {
        self.attribute(attribute).filter(is_element).map(Element)
    }

    /// The elements `attribute` lists, such as `AXWindows` or `AXChildren`.
    pub fn elements(&self, attribute: &str) -> Vec<Element> {
        let Some(list) = self
            .attribute(attribute)
            .and_then(|v| v.downcast::<CFArray>())
        else {
            return Vec::new();
        };
        // SAFETY: an Accessibility attribute's array holds CF objects.
        let list: CFArray<CFType> =
            unsafe { CFArray::wrap_under_get_rule(list.as_concrete_TypeRef()) };
        list.iter()
            .filter(|item| is_element(item))
            .map(|item| Element(item.clone()))
            .collect()
    }

    /// The element's on-screen frame, in points from the main display's top left.
    pub fn frame(&self) -> Option<Rect> {
        let origin = self.attribute("AXPosition").and_then(|v| point(&v))?;
        let size = self.attribute("AXSize").and_then(|v| size(&v))?;
        Some(Rect {
            x: origin.x,
            y: origin.y,
            width: size.width,
            height: size.height,
        })
    }

    /// What the tree shows of the element, read in two calls rather than one per attribute.
    pub fn info(&self) -> Info {
        const NAMES: [&str; 11] = [
            "AXRole",
            "AXRoleDescription",
            "AXTitle",
            "AXDescription",
            "AXValue",
            "AXPlaceholderValue",
            "AXEnabled",
            "AXFocused",
            "AXSelected",
            "AXPosition",
            "AXSize",
        ];
        let names: Vec<CFString> = NAMES.iter().map(|name| CFString::new(name)).collect();
        let names = CFArray::from_CFTypes(&names);
        let mut values: CFArrayRef = std::ptr::null();
        // SAFETY: the element and array are valid, and `values` receives a new array or stays
        // null.
        let error = unsafe {
            AXUIElementCopyMultipleAttributeValues(
                self.raw(),
                names.as_concrete_TypeRef(),
                0,
                &raw mut values,
            )
        };
        let mut info = Info::default();
        if error == AX_SUCCESS && !values.is_null() {
            // SAFETY: a successful copy returned a new array of CF objects, one per name.
            let values: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(values) };
            let value = |at: isize| values.get(at).map(|v| v.clone()).filter(|v| !is_error(v));
            let text = |at: isize| value(at).and_then(|v| text(&v));
            let flag = |at: isize| {
                value(at)
                    .and_then(|v| v.downcast::<CFBoolean>())
                    .map(bool::from)
            };
            info.role = text(0).unwrap_or_default();
            info.kind = text(1).unwrap_or_default();
            info.title = text(2).unwrap_or_default();
            info.description = text(3).unwrap_or_default();
            info.value = text(4).unwrap_or_default();
            info.placeholder = text(5).unwrap_or_default();
            info.enabled = flag(6).unwrap_or(true);
            info.focused = flag(7).unwrap_or(false);
            info.selected = flag(8).unwrap_or(false);
            if let (Some(origin), Some(size)) = (
                value(9).and_then(|v| point(&v)),
                value(10).and_then(|v| size(&v)),
            ) {
                info.frame = Some(Rect {
                    x: origin.x,
                    y: origin.y,
                    width: size.width,
                    height: size.height,
                });
            }
        }
        info.actions = self.actions();
        info
    }

    /// The actions the element offers, such as `AXPress` and `AXShowMenu`.
    pub fn actions(&self) -> Vec<String> {
        let mut names: CFArrayRef = std::ptr::null();
        // SAFETY: the element is valid, and `names` receives a new array or stays null.
        let error = unsafe { AXUIElementCopyActionNames(self.raw(), &raw mut names) };
        if error != AX_SUCCESS || names.is_null() {
            return Vec::new();
        }
        // SAFETY: a successful copy returned a new array of strings.
        let names: CFArray<CFType> = unsafe { CFArray::wrap_under_create_rule(names) };
        names.iter().filter_map(|name| text(&name)).collect()
    }

    /// Performs `action`, such as `AXPress`.
    pub fn perform(&self, action: &str) -> Result<(), String> {
        let name = CFString::new(action);
        // SAFETY: the element and name are valid for the call.
        let error = unsafe { AXUIElementPerformAction(self.raw(), name.as_concrete_TypeRef()) };
        checked(error, action)
    }

    /// Sets the element's value, as typing into a text field or moving a slider does.
    pub fn set_value(&self, value: &str) -> Result<(), String> {
        let name = CFString::new("AXValue");
        let value = CFString::new(value);
        // SAFETY: the element, name, and value are valid for the call.
        let error = unsafe {
            AXUIElementSetAttributeValue(
                self.raw(),
                name.as_concrete_TypeRef(),
                value.as_CFTypeRef(),
            )
        };
        checked(error, "setting its value")
    }
}

fn checked(error: AxError, what: &str) -> Result<(), String> {
    match error {
        AX_SUCCESS => Ok(()),
        // kAXErrorAPIDisabled
        -25211 => Err(super::NO_ACCESSIBILITY.to_owned()),
        // kAXErrorActionUnsupported, kAXErrorAttributeUnsupported
        -25206 | -25205 => Err(format!("The element doesn't support {what}.")),
        // kAXErrorCannotComplete
        -25204 => Err(format!("The app didn't answer {what} in time.")),
        // kAXErrorInvalidUIElement
        -25202 => Err("The element is gone. Call computer_get_app_state again.".to_owned()),
        other => Err(format!("{what} failed (Accessibility error {other}).")),
    }
}

fn is_element(value: &CFType) -> bool {
    // SAFETY: takes no arguments.
    value.type_of() == unsafe { AXUIElementGetTypeID() }
}

/// Whether `value` stands for an attribute the element lacks, in a multiple-attribute answer.
fn is_error(value: &CFType) -> bool {
    // SAFETY: the type is checked before the value is read as an AXValue.
    value.type_of() == unsafe { AXValueGetTypeID() }
        && unsafe { AXValueGetType(value.as_CFTypeRef()) } == AX_VALUE_ERROR
}

/// A string, number, or boolean attribute, as text.
fn text(value: &CFType) -> Option<String> {
    if let Some(string) = value.downcast::<CFString>() {
        return Some(string.to_string());
    }
    if let Some(number) = value.downcast::<CFNumber>() {
        return number
            .to_i64()
            .map(|n| n.to_string())
            .or_else(|| number.to_f64().map(|n| n.to_string()));
    }
    value
        .downcast::<CFBoolean>()
        .map(|flag| bool::from(flag).to_string())
}

fn ax_value<T: Default>(value: &CFType, kind: u32) -> Option<T> {
    // SAFETY: the type is checked first, and `out` is a `T` of the size `kind` writes: a
    // `CgPoint` for kAXValueCGPointType and a `CgSize` for kAXValueCGSizeType.
    unsafe {
        if value.type_of() != AXValueGetTypeID() || AXValueGetType(value.as_CFTypeRef()) != kind {
            return None;
        }
        let mut out = T::default();
        AXValueGetValue(value.as_CFTypeRef(), kind, (&raw mut out).cast()).then_some(out)
    }
}

fn point(value: &CFType) -> Option<CgPoint> {
    ax_value(value, AX_VALUE_CG_POINT)
}

fn size(value: &CFType) -> Option<CgSize> {
    ax_value(value, AX_VALUE_CG_SIZE)
}

/// One of an app's windows on screen, as the window server lists it.
pub struct Window {
    /// The window server's number for it, which `screencapture -l` takes.
    pub number: u32,
    pub bounds: Rect,
}

/// Process `pid`'s normal windows on screen, front to back.
pub fn windows(pid: i32) -> Vec<Window> {
    // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
    // SAFETY: returns a new array of dictionaries, or null.
    let list = unsafe { CGWindowListCopyWindowInfo(1 | 16, 0) };
    if list.is_null() {
        return Vec::new();
    }
    // SAFETY: a new array (the create rule) of CFDictionary.
    let list: CFArray<CFDictionary<CFString, CFType>> =
        unsafe { CFArray::wrap_under_create_rule(list) };
    let number = |entry: &CFDictionary<CFString, CFType>, key: &'static str| {
        entry
            .find(CFString::from_static_string(key))
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_f64())
    };
    let mut windows = Vec::new();
    for entry in list.iter() {
        if number(&entry, "kCGWindowOwnerPID") != Some(f64::from(pid))
            || number(&entry, "kCGWindowLayer") != Some(0.0)
        {
            continue;
        }
        let Some(bounds) = entry
            .find(CFString::from_static_string("kCGWindowBounds"))
            .and_then(|value| value.downcast::<CFDictionary>())
        else {
            continue;
        };
        // SAFETY: kCGWindowBounds is a dictionary of CFString to CFNumber.
        let bounds: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(bounds.as_concrete_TypeRef()) };
        let side = |key| number(&bounds, key).unwrap_or_default();
        #[expect(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "a window number is a small positive integer"
        )]
        let id = number(&entry, "kCGWindowNumber").unwrap_or_default() as u32;
        windows.push(Window {
            number: id,
            bounds: Rect {
                x: side("X"),
                y: side("Y"),
                width: side("Width"),
                height: side("Height"),
            },
        });
    }
    windows
}

/// A mouse button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

impl Button {
    /// Its down, up, and dragged event types, and its number.
    fn events(self) -> (u32, u32, u32, u32) {
        match self {
            Self::Left => (1, 2, 6, 0),
            Self::Right => (3, 4, 7, 1),
            Self::Middle => (25, 26, 27, 2),
        }
    }
}

/// A Quartz event, released when dropped.
struct Event(CFType);

impl Event {
    /// Takes a new event, or `None` when Quartz couldn't make one.
    fn new(raw: CFTypeRef) -> Option<Self> {
        // SAFETY: every CGEventCreate function returns a new reference or null.
        (!raw.is_null()).then(|| Self(unsafe { CFType::wrap_under_create_rule(raw) }))
    }

    fn post(&self, pid: i32) {
        // SAFETY: the event is valid; posting copies it.
        unsafe { CGEventPostToPid(pid, self.0.as_CFTypeRef()) }
    }
}

fn mouse(kind: u32, at: Point, button: u32, clicks: i64, flags: u64) -> Option<Event> {
    let location = CgPoint { x: at.x, y: at.y };
    // SAFETY: a null source makes an event with no source state, as the docs allow.
    let event =
        Event::new(unsafe { CGEventCreateMouseEvent(std::ptr::null(), kind, location, button) })?;
    // SAFETY: the event is valid. Field 1 is kCGMouseEventClickState.
    unsafe {
        CGEventSetIntegerValueField(event.0.as_CFTypeRef(), 1, clicks);
        CGEventSetFlags(event.0.as_CFTypeRef(), flags);
    }
    Some(event)
}

/// Clicks `button` `count` times at `at`, in screen points, in app `pid`.
pub fn click(pid: i32, at: Point, button: Button, count: u32, flags: u64) {
    let (down, up, _, number) = button.events();
    // Moving there first lets the app track the pointer, as a real mouse would.
    if let Some(moved) = mouse(5, at, 0, 0, 0) {
        moved.post(pid);
    }
    for click in 1..=i64::from(count.max(1)) {
        for kind in [down, up] {
            if let Some(event) = mouse(kind, at, number, click, flags) {
                event.post(pid);
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
}

/// How many moves a drag makes between pressing and letting go.
const DRAG_STEPS: u32 = 12;

/// Presses at `from`, moves to `to` in steps, and lets go, in app `pid`.
pub fn drag(pid: i32, from: Point, to: Point) {
    let (down, up, dragged, number) = Button::Left.events();
    let post = |kind, at| {
        if let Some(event) = mouse(kind, at, number, 1, 0) {
            event.post(pid);
        }
    };
    post(down, from);
    for step in 1..=DRAG_STEPS {
        let t = f64::from(step) / f64::from(DRAG_STEPS);
        let at = Point {
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t,
        };
        std::thread::sleep(Duration::from_millis(16));
        post(dragged, at);
    }
    post(up, to);
}

/// Scrolls by `dx` and `dy` pixels at `at` in app `pid`; a positive `dy` scrolls up.
pub fn scroll(pid: i32, at: Point, dx: i32, dy: i32) {
    // SAFETY: a null source is allowed; unit 0 is kCGScrollEventUnitPixel, with two wheels.
    let Some(event) =
        Event::new(unsafe { CGEventCreateScrollWheelEvent2(std::ptr::null(), 0, 2, dy, dx, 0) })
    else {
        return;
    };
    // SAFETY: the event is valid.
    unsafe { CGEventSetLocation(event.0.as_CFTypeRef(), CgPoint { x: at.x, y: at.y }) };
    event.post(pid);
}

/// Presses and releases virtual key `key` with modifier `flags` in app `pid`.
pub fn key(pid: i32, key: u16, flags: u64) {
    for down in [true, false] {
        // SAFETY: a null source is allowed.
        if let Some(event) =
            Event::new(unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), key, down) })
        {
            // SAFETY: the event is valid.
            unsafe { CGEventSetFlags(event.0.as_CFTypeRef(), flags) };
            event.post(pid);
        }
    }
}

/// Types `text` in app `pid` as the keyboard would, a few characters per event.
pub fn type_text(pid: i32, text: &str) {
    let units: Vec<u16> = text.encode_utf16().collect();
    // Quartz carries at most 20 UTF-16 units in one event.
    for chunk in units.chunks(20) {
        for down in [true, false] {
            // SAFETY: a null source is allowed; key 0 is replaced by the string.
            if let Some(event) =
                Event::new(unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, down) })
            {
                // SAFETY: the event is valid, and `chunk` holds `chunk.len()` units.
                unsafe {
                    CGEventKeyboardSetUnicodeString(
                        event.0.as_CFTypeRef(),
                        chunk.len(),
                        chunk.as_ptr(),
                    );
                }
                event.post(pid);
            }
        }
        std::thread::sleep(Duration::from_millis(8));
    }
}
