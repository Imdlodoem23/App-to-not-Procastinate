package store

import (
	"errors"
	"io/fs"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// lockFileSDDL is the lock file's protected DACL: SYSTEM, Administrators and the
// file's owner only (the descriptor of platform.WriteSecretFile). A standard user who
// could open run/guardian.lock, even read-only, could wait for the exclusive lock and
// take it the moment the guardian exits, keeping every later start out (ErrLocked).
const lockFileSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)"

// dirLock is the exclusive lock on run/guardian.lock (§10.12 step 1): the file is
// opened with share mode 0 (no other handle while it is held) and locked with
// LockFileEx on the first byte.
type dirLock struct {
	f  *os.File
	ol windows.Overlapped
}

func acquireLock(path string) (*dirLock, error) {
	f, err := openLockFile(path)
	if err != nil {
		if errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
			return nil, ErrLocked
		}
		return nil, err
	}
	l := &dirLock{f: f}
	err = windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &l.ol)
	if err != nil {
		_ = f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
			return nil, ErrLocked
		}
		return nil, err
	}
	return l, nil
}

// openLockFile opens or creates path with the private descriptor and share mode 0,
// without following a link or junction (FILE_FLAG_OPEN_REPARSE_POINT), and fails
// unless it is a regular file with one hard link (as platform.OpenRegularFile). The
// private descriptor is then set through the handle as well, so a file an older build
// created (inheriting run/'s Users-readable DACL) is fixed too.
func openLockFile(path string) (*os.File, error) {
	fail := func(err error) (*os.File, error) { return nil, &fs.PathError{Op: "open", Path: path, Err: err} }
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return fail(err)
	}
	sd, err := windows.SecurityDescriptorFromString(lockFileSDDL)
	if err != nil {
		return fail(err)
	}
	sa := windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
	}
	const access = windows.GENERIC_READ | windows.GENERIC_WRITE | windows.READ_CONTROL | windows.WRITE_DAC
	h, err := windows.CreateFile(p, access, 0, &sa, windows.OPEN_ALWAYS,
		windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return fail(err)
	}
	closeFail := func(err error) (*os.File, error) {
		_ = windows.CloseHandle(h)
		return fail(err)
	}
	var bhfi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &bhfi); err != nil {
		return closeFail(err)
	}
	switch {
	case bhfi.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0:
		return closeFail(errors.New("is a link or junction"))
	case bhfi.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0:
		return closeFail(errors.New("not a regular file"))
	case bhfi.NumberOfLinks > 1:
		return closeFail(errors.New("has more than one hard link"))
	}
	// Always (re)set the descriptor: CreateFile applies sa only when it creates the file.
	dacl, _, err := sd.DACL()
	if err != nil {
		return closeFail(err)
	}
	if err := windows.SetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil); err != nil {
		return closeFail(err)
	}
	return os.NewFile(uintptr(h), path), nil
}

func (l *dirLock) release() error {
	_ = windows.UnlockFileEx(windows.Handle(l.f.Fd()), 0, 1, 0, &l.ol)
	return l.f.Close()
}
