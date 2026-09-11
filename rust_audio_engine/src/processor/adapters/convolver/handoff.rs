use std::marker::PhantomData;
use std::ptr::{self, NonNull};
use std::sync::atomic::{AtomicPtr, Ordering};

/// Unique ownership withdrawn by the audio consumer.
///
/// The wrapper does not reconstruct a `Box` during hand-off. Its destructor is
/// only a shutdown fallback, so every normal audio-path transition must move it
/// into another owner. The containing processor must be destroyed off RT.
pub(super) struct AudioOwned<T> {
    ptr: NonNull<T>,
    _owns_value: PhantomData<Box<T>>,
}

impl<T> AudioOwned<T> {
    /// # Safety
    ///
    /// `ptr` must be non-null, originate from exactly one `Box<T>`, and no
    /// other owner may access or reconstruct that allocation.
    unsafe fn from_raw(ptr: *mut T) -> Self {
        Self {
            // SAFETY: The caller establishes that `ptr` is non-null.
            ptr: unsafe { NonNull::new_unchecked(ptr) },
            _owns_value: PhantomData,
        }
    }

    fn into_raw(self) -> *mut T {
        let ptr = self.ptr.as_ptr();
        std::mem::forget(self);
        ptr
    }

    pub(super) fn get(&self) -> &T {
        // SAFETY: This wrapper is the unique owner and shared access is tied to
        // its borrow.
        unsafe { self.ptr.as_ref() }
    }

    pub(super) fn get_mut(&mut self) -> &mut T {
        // SAFETY: This wrapper is the unique owner and mutable access is tied
        // to its exclusive borrow.
        unsafe { self.ptr.as_mut() }
    }
}

// SAFETY: `AudioOwned<T>` transfers the same unique ownership as `Box<T>` and
// exposes no shared mutable access.
unsafe impl<T: Send> Send for AudioOwned<T> {}

impl<T> Drop for AudioOwned<T> {
    fn drop(&mut self) {
        // SAFETY: `self` still owns the allocation. This fallback is reached
        // only when the processor is destroyed off the realtime thread.
        unsafe { drop(Box::from_raw(self.ptr.as_ptr())) };
    }
}

/// Fixed single-slot ownership mailbox.
///
/// There is one logical producer and one logical consumer per direction. The
/// control side serializes cloned publishers before touching a slot. Slot
/// destruction is only valid after all users have stopped and off RT.
pub(super) struct AtomicBoxSlot<T> {
    ptr: AtomicPtr<T>,
}

impl<T> AtomicBoxSlot<T> {
    pub(super) const fn empty() -> Self {
        Self {
            ptr: AtomicPtr::new(ptr::null_mut()),
        }
    }

    /// Install a control-owned value, returning the previous value to the same
    /// control thread for destruction.
    pub(super) fn replace_on_control(&self, value: Box<T>) -> Option<Box<T>> {
        let replacement = Box::into_raw(value);
        let previous = self.ptr.swap(replacement, Ordering::AcqRel);
        if previous.is_null() {
            None
        } else {
            // SAFETY: The swap removed the unique slot owner and no audio
            // consumer can withdraw the same pointer afterward.
            Some(unsafe { Box::from_raw(previous) })
        }
    }

    /// Withdraw the current publication into audio-local unique ownership.
    pub(super) fn take_for_audio(&self) -> Option<AudioOwned<T>> {
        let ptr = self.ptr.swap(ptr::null_mut(), Ordering::AcqRel);
        if ptr.is_null() {
            None
        } else {
            // SAFETY: The exchange removed the only shared slot owner.
            Some(unsafe { AudioOwned::from_raw(ptr) })
        }
    }

    /// Hand audio-local ownership to an empty retirement slot.
    pub(super) fn try_store_from_audio(&self, value: AudioOwned<T>) -> Result<(), AudioOwned<T>> {
        let ptr = value.into_raw();
        match self
            .ptr
            .compare_exchange(ptr::null_mut(), ptr, Ordering::AcqRel, Ordering::Acquire)
        {
            Ok(_) => Ok(()),
            Err(_) => {
                // SAFETY: Failed CAS leaves `ptr` unpublished and uniquely
                // owned by this call.
                Err(unsafe { AudioOwned::from_raw(ptr) })
            }
        }
    }

    /// Withdraw a retired value for destruction on the control/offline thread.
    pub(super) fn reclaim_on_control(&self) -> Option<Box<T>> {
        let ptr = self.ptr.swap(ptr::null_mut(), Ordering::AcqRel);
        if ptr.is_null() {
            None
        } else {
            // SAFETY: The exchange removed the unique slot owner.
            Some(unsafe { Box::from_raw(ptr) })
        }
    }

    pub(super) fn is_empty(&self) -> bool {
        self.ptr.load(Ordering::Acquire).is_null()
    }
}

impl<T> Drop for AtomicBoxSlot<T> {
    fn drop(&mut self) {
        let ptr = *self.ptr.get_mut();
        if !ptr.is_null() {
            // SAFETY: `&mut self` proves no concurrent slot operation remains,
            // and the slot still uniquely owns this pointer.
            unsafe { drop(Box::from_raw(ptr)) };
        }
    }
}
