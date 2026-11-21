pub mod ecs;
pub mod physics;

use std::alloc::{alloc, dealloc, Layout};

pub const ABI_VERSION: u32 = 1;
const ALLOC_ALIGN: usize = 16;

pub struct EngineCore {
    _reserved: u32,
}

impl EngineCore {
    pub fn new() -> Self {
        Self { _reserved: 0 }
    }
}

impl Default for EngineCore {
    fn default() -> Self {
        Self::new()
    }
}

#[no_mangle]
pub extern "C" fn core_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn quark_alloc(len: usize) -> *mut u8 {
    let size = len.max(1);
    let Ok(layout) = Layout::from_size_align(size, ALLOC_ALIGN) else {
        return std::ptr::null_mut();
    };
    // SAFETY: `size >= 1` and `ALLOC_ALIGN` is a non-zero power of two.
    unsafe { alloc(layout) }
}

/// # Safety
/// `ptr` must have been returned by `quark_alloc(len)` and not yet freed.
#[no_mangle]
pub unsafe extern "C" fn quark_dealloc(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let size = len.max(1);
    if let Ok(layout) = Layout::from_size_align(size, ALLOC_ALIGN) {
        dealloc(ptr, layout);
    }
}

#[no_mangle]
pub extern "C" fn core_create() -> *mut EngineCore {
    Box::into_raw(Box::new(EngineCore::new()))
}

/// # Safety
/// `ptr` must have been returned by `core_create()` and not yet destroyed.
#[no_mangle]
pub unsafe extern "C" fn core_destroy(ptr: *mut EngineCore) {
    if !ptr.is_null() {
        drop(Box::from_raw(ptr));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_abi_version_and_lifecycle() {
        assert_eq!(core_abi_version(), 1);
        let core = core_create();
        assert!(!core.is_null());
        unsafe { core_destroy(core) };
    }

    #[test]
    fn test_allocator_roundtrip() {
        let ptr = quark_alloc(64);
        assert!(!ptr.is_null());
        unsafe {
            std::ptr::write_bytes(ptr, 0xAB, 64);
            assert_eq!(*ptr, 0xAB);
            quark_dealloc(ptr, 64);
        }
    }
}
