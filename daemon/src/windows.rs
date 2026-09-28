//! Every Win32 call wispd makes that std and tokio don't wrap (0023). This is the only module
//! allowed `unsafe` code, and every `unsafe` block says why it is sound.
//!
//! - [`create_pipe`]: a named pipe instance whose DACL grants only this user.
//! - [`pipe_client_pid`], [`pipe_server_pid`], and [`runs_as_this_user`]: the SID checks on both
//!   ends of the pipe.
//! - [`stop_inheriting_handles`]: so a process wispd starts gets only the handles it is given.
//! - [`Job`]: the job object an agent CLI runs in.

#![allow(unsafe_code)]

use std::ffi::OsStr;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle as _, OwnedHandle, RawHandle};
use std::ptr;

use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use windows_sys::Win32::Foundation::{
    GetHandleInformation, HANDLE_FLAG_INHERIT, LocalFree, SetHandleInformation,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{
    GetLengthSid, GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::{
    GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, PIPE_READMODE_BYTE,
    SetNamedPipeHandleState,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetProcessHandleCount, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Turns a `BOOL` result into an `io::Result`, reading the error right after the call.
fn check(succeeded: i32) -> io::Result<()> {
    if succeeded == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// The SDDL that grants only this process's user full access, and nobody else anything:
/// `D:P(A;;GA;;;<SID>)`. Windows' default pipe DACL gives Everyone read access.
///
/// # Errors
///
/// If this process's user can't be read.
pub fn this_user_only_sddl() -> io::Result<String> {
    let sid = user_of(current_process())?;
    Ok(format!("D:P(A;;GA;;;{})", sid_string(&sid)?))
}

/// Creates an instance of the pipe `name` with `options` and the security descriptor `sddl`.
/// Must be called inside a tokio runtime.
///
/// # Errors
///
/// If `sddl` isn't valid, or creating the instance fails. With `first_pipe_instance(true)`, a
/// pipe that already exists fails with `ERROR_ACCESS_DENIED`.
pub fn create_pipe(
    options: &ServerOptions,
    name: &OsStr,
    sddl: &str,
) -> io::Result<NamedPipeServer> {
    let wide: Vec<u16> = sddl.encode_utf16().chain([0]).collect();
    let mut descriptor = ptr::null_mut();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call, and `descriptor`
    // is a valid place for the returned pointer. The size out-pointer may be null.
    check(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1,
            &raw mut descriptor,
            ptr::null_mut(),
        )
    })?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: u32::try_from(size_of::<SECURITY_ATTRIBUTES>()).unwrap_or(u32::MAX),
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    // SAFETY: `attributes` is a valid SECURITY_ATTRIBUTES whose descriptor stays allocated until
    // after the call, which copies it into the new pipe.
    let created =
        unsafe { options.create_with_security_attributes_raw(name, (&raw mut attributes).cast()) };
    // SAFETY: `descriptor` came from ConvertStringSecurityDescriptorToSecurityDescriptorW, which
    // says to free it with LocalFree, and nothing uses it after this.
    unsafe { LocalFree(descriptor) };
    // Keep the pipe's message type for the empty-message input marker, but read its data as
    // bytes. mio can mistake a synchronously completed partial message read for EOF.
    let pipe = created?;
    // SAFETY: `pipe` owns a live server pipe handle, and `PIPE_READMODE_BYTE` is a valid mode
    // value. The other two optional settings are not changed.
    let mode = PIPE_READMODE_BYTE;
    check(unsafe {
        SetNamedPipeHandleState(
            pipe.as_raw_handle(),
            &raw const mode,
            ptr::null(),
            ptr::null(),
        )
    })?;
    Ok(pipe)
}

/// The process id of the client connected to the server end `pipe`.
///
/// # Errors
///
/// If Windows can't say, such as when no client is connected.
pub fn pipe_client_pid(pipe: &impl AsRawHandle) -> io::Result<u32> {
    let mut pid = 0;
    // SAFETY: `pipe` is an open pipe handle for the duration of the call, and `pid` is a valid
    // out pointer.
    check(unsafe { GetNamedPipeClientProcessId(pipe.as_raw_handle(), &raw mut pid) })?;
    Ok(pid)
}

/// The process id of the server at the other end of the client end `pipe`.
///
/// # Errors
///
/// If Windows can't say.
pub fn pipe_server_pid(pipe: &impl AsRawHandle) -> io::Result<u32> {
    let mut pid = 0;
    // SAFETY: as in `pipe_client_pid`.
    check(unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle(), &raw mut pid) })?;
    Ok(pid)
}

/// Whether the process `pid` runs as this process's user.
///
/// # Errors
///
/// If either process's user can't be read. Another user's process usually can't be opened at
/// all, so callers treat an error as "not this user".
pub fn runs_as_this_user(pid: u32) -> io::Result<bool> {
    // SAFETY: OpenProcess has no preconditions; a null result is an error.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcess returned a handle that nothing else owns.
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    Ok(user_of(process.as_raw_handle())? == user_of(current_process())?)
}

fn current_process() -> RawHandle {
    // SAFETY: GetCurrentProcess has no preconditions. Its pseudo-handle needs no closing.
    unsafe { GetCurrentProcess() }
}

/// The SID, as bytes, of the user the process behind `process` runs as. Two SIDs are equal
/// exactly when their bytes are.
fn user_of(process: RawHandle) -> io::Result<Vec<u8>> {
    let mut token = ptr::null_mut();
    // SAFETY: `process` is a process handle with query access, and `token` is a valid out
    // pointer.
    check(unsafe { OpenProcessToken(process, TOKEN_QUERY, &raw mut token) })?;
    // SAFETY: OpenProcessToken returned a handle that nothing else owns.
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut len = 0;
    // SAFETY: a null buffer of length 0 only asks for the size, which goes in `len`. It "fails"
    // with ERROR_INSUFFICIENT_BUFFER, which is expected.
    unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            ptr::null_mut(),
            0,
            &raw mut len,
        )
    };
    // u64s, so the TOKEN_USER at the start of the buffer is aligned.
    let mut buffer = vec![0_u64; (len as usize).div_ceil(8)];
    // SAFETY: `buffer` is at least `len` bytes and aligned for TOKEN_USER.
    check(unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            len,
            &raw mut len,
        )
    })?;
    // SAFETY: GetTokenInformation wrote a TOKEN_USER at the start of `buffer`.
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    // SAFETY: `sid` points to a valid SID inside `buffer`, which is still alive.
    let sid_len = unsafe { GetLengthSid(sid) } as usize;
    // SAFETY: the SID is `sid_len` bytes starting at `sid`, all inside `buffer`.
    Ok(unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), sid_len) }.to_vec())
}

/// `sid` in its string form, such as `S-1-5-21-...`.
fn sid_string(sid: &[u8]) -> io::Result<String> {
    let mut text = ptr::null_mut();
    // SAFETY: `sid` holds a valid SID (from `user_of`) and isn't written to; `text` is a valid
    // out pointer.
    check(unsafe { ConvertSidToStringSidW(sid.as_ptr().cast_mut().cast(), &raw mut text) })?;
    let mut len = 0;
    // SAFETY: ConvertSidToStringSidW returned a NUL-terminated UTF-16 string, so every unit up
    // to and including the NUL can be read.
    while unsafe { *text.add(len) } != 0 {
        len += 1;
    }
    // SAFETY: the string has `len` UTF-16 units before its NUL.
    let string = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    // SAFETY: the string came from ConvertSidToStringSidW, which says to free it with LocalFree,
    // and nothing uses it after this.
    unsafe { LocalFree(text.cast()) };
    Ok(string)
}

/// Clears `HANDLE_FLAG_INHERIT` on every handle this process has (0023). Call it before any other
/// thread starts.
///
/// A process started with std's `Command` inherits every inheritable handle. std opens its own
/// handles as non-inheritable, so the inheritable ones are all inherited from the parent: the std
/// handles, and whatever else it passed down. Under Windows' sshd, that includes more copies of
/// the session's pipes than the three std handles, and a `serve` holding one keeps the session
/// open after attach exits. So without this, `serve` and agent CLIs would inherit attach's SSH
/// session pipes or `serve`'s log.
///
/// Windows has no call that lists a process's own handles, but their values are multiples of 4
/// from 4 up, so this tries each one until it has seen as many as the process has, or up to a
/// bound far past what a new process holds.
pub fn stop_inheriting_handles() {
    const MAX_HANDLE_VALUE: usize = 1 << 24;

    let mut count = 0;
    // SAFETY: the pseudo-handle is always valid, and `count` is a valid out pointer. On failure
    // `count` stays 0 and the loop runs to its bound.
    unsafe { GetProcessHandleCount(current_process(), &raw mut count) };
    let mut seen = 0;
    for value in (4..MAX_HANDLE_VALUE).step_by(4) {
        let handle = ptr::without_provenance_mut(value);
        let mut flags = 0;
        // SAFETY: a value that isn't an open handle makes the call fail, and `flags` is a valid
        // out pointer. Nothing but the flags is read.
        if unsafe { GetHandleInformation(handle, &raw mut flags) } == 0 {
            continue;
        }
        if flags & HANDLE_FLAG_INHERIT != 0 {
            // SAFETY: `handle` is one of this process's open handles, and only its inherit flag
            // changes, which nothing else in wispd relies on.
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
        }
        seen += 1;
        if count != 0 && seen >= count {
            break;
        }
    }
}

/// A job object that kills every process in it once its last handle closes, so dropping it
/// kills whatever an agent CLI left running (0023).
#[derive(Debug)]
pub struct Job(OwnedHandle);

impl Job {
    /// A new, empty job.
    ///
    /// # Errors
    ///
    /// If Windows can't create it.
    pub fn new() -> io::Result<Self> {
        // SAFETY: null attributes and a null name are allowed: an unnamed job with a default
        // security descriptor and a non-inheritable handle.
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateJobObjectW returned a handle that nothing else owns.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle) });
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is a valid JOBOBJECT_EXTENDED_LIMIT_INFORMATION of the size given.
        check(unsafe {
            SetInformationJobObject(
                job.0.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast(),
                u32::try_from(size_of_val(&limits)).unwrap_or(u32::MAX),
            )
        })?;
        Ok(job)
    }

    /// Puts `child` in the job. Processes it starts afterwards join too.
    ///
    /// # Errors
    ///
    /// If Windows refuses, or the child has already exited.
    pub fn assign(&self, child: &tokio::process::Child) -> io::Result<()> {
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("the process has already exited"))?;
        // SAFETY: tokio keeps the handle of a child it hasn't reaped open, and `child` is
        // borrowed for the whole call; the job's handle is ours.
        check(unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), process) })
    }

    /// Kills every process in the job.
    ///
    /// # Errors
    ///
    /// If Windows refuses.
    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: the job handle is open for the duration of the call.
        check(unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn this_process_runs_as_this_user() {
        assert!(super::runs_as_this_user(std::process::id()).unwrap());
        let sddl = super::this_user_only_sddl().unwrap();
        assert!(sddl.starts_with("D:P(A;;GA;;;S-1-5-"), "{sddl}");
    }

    #[tokio::test]
    async fn terminating_a_job_kills_what_is_in_it() {
        let job = super::Job::new().unwrap();
        let mut child = tokio::process::Command::new("cmd")
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        job.assign(&child).unwrap();
        job.terminate().unwrap();
        assert!(!child.wait().await.unwrap().success());
    }
}
