//! Login-session state (lock screen, display sleep) and the assertion that
//! keeps the display awake while the agent acts.

use objc2_core_foundation::{CFBoolean, CFDictionary, CFRetained, CFString, CFType};
use objc2_core_graphics::{CGDisplayIsAsleep, CGMainDisplayID, CGSessionCopyCurrentDictionary};

use super::super::types::ScreenState;
use crate::power::platform::{AssertionInner, AssertionKind};

/// Session dictionary key `WindowServer` sets to true while the lock screen is
/// up; absent while unlocked.
const SCREEN_LOCKED_KEY: &str = "CGSSessionScreenIsLocked";
/// Shown by `pmset -g assertions` next to the holding process.
const DISPLAY_AWAKE_REASON: &str = "oh-my-pi computer tool is operating the desktop";

pub(super) fn screen_state() -> ScreenState {
	ScreenState {
		locked:         screen_locked(),
		display_asleep: CGDisplayIsAsleep(CGMainDisplayID()),
	}
}

fn screen_locked() -> bool {
	let Some(session) = CGSessionCopyCurrentDictionary() else {
		// No GUI session (e.g. an SSH login): there is no lock screen to report.
		return false;
	};
	// SAFETY: the session dictionary's keys are CFStrings and its values
	// CFTypes; the copy is owned here and never mutated.
	let session = unsafe { CFRetained::cast_unchecked::<CFDictionary<CFString, CFType>>(session) };
	let key = CFString::from_static_str(SCREEN_LOCKED_KEY);
	// SAFETY: `session` is an immutable copy that outlives the borrow.
	unsafe { session.get_unchecked(&key) }
		.and_then(|value| value.downcast_ref::<CFBoolean>())
		.is_some_and(CFBoolean::value)
}

/// Prevent-idle-display-sleep assertion, held while `Some`.
#[derive(Default)]
pub(super) struct DisplayAwake(Option<AssertionInner>);

impl DisplayAwake {
	pub(super) fn set(&mut self, awake: bool) {
		match (awake, self.0.is_some()) {
			(true, false) => {
				// A refused assertion only means the display may sleep as it
				// would without the agent; screen-state reporting covers that.
				self.0 =
					AssertionInner::start(AssertionKind::PreventDisplaySleep, DISPLAY_AWAKE_REASON).ok();
			},
			(false, true) => self.0 = None,
			_ => {},
		}
	}
}
