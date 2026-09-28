package store

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// renameRetries is how often a rename is retried after a sharing violation (§11.2:
// another process, such as an antivirus or `has-active`, has the target open).
const (
	renameRetries    = 10
	renameRetryDelay = 50 * time.Millisecond
)

// statePerm makes state.json, state.prev.json and backups/state.v*.json private
// (SYSTEM and Administrators): the data directory grants Users read, and a standard
// user holding a share-mode-0 handle on a readable snapshot would make every
// MoveFileEx over it fail (no state saves, a frozen rollback anchor) and the next
// start read it as corrupt. `has-active` runs elevated from the installers.
const statePerm = secretPerm

// privateCreateSDDL is the DACL of a file created with a private perm: SYSTEM,
// Administrators and the file's owner (the elevated guardian: SYSTEM or
// Administrators; a non-elevated test process: its own user), not inherited.
const privateCreateSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)"

// openFile is platform.OpenRegularFile, except that a file created with O_EXCL and a
// perm granting nothing to group and others gets the private DACL from the start:
// set at creation, there is no window in which another account could open it.
func openFile(name string, flag int, perm fs.FileMode) (*os.File, error) {
	if flag&(os.O_CREATE|os.O_EXCL) != os.O_CREATE|os.O_EXCL || perm&0o077 != 0 {
		return platform.OpenRegularFile(name, flag, perm)
	}
	return createPrivate(name, flag)
}

// createPrivate creates name (CREATE_NEW, never through a link) with privateCreateSDDL.
// The handle shares read, write and delete like platform.OpenRegularFile.
func createPrivate(name string, flag int) (*os.File, error) {
	sd, err := windows.SecurityDescriptorFromString(privateCreateSDDL)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	p, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	access := uint32(windows.GENERIC_WRITE | windows.FILE_READ_ATTRIBUTES)
	switch {
	case flag&os.O_RDWR != 0:
		access |= windows.GENERIC_READ
	case flag&os.O_APPEND != 0:
		access = windows.FILE_APPEND_DATA | windows.FILE_WRITE_ATTRIBUTES | windows.FILE_WRITE_EA |
			windows.STANDARD_RIGHTS_WRITE | windows.SYNCHRONIZE | windows.FILE_READ_ATTRIBUTES
	}
	h, err := windows.CreateFile(p, access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, &sa,
		windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}
	return os.NewFile(uintptr(h), name), nil
}

// setMode is a no-op: Windows files get their DACL at creation (openFile) or inherit
// the directory's protected DACL.
func setMode(*os.File, fs.FileMode) error { return nil }

// renameReplace replaces newpath with oldpath using MoveFileEx(MOVEFILE_REPLACE_EXISTING
// | MOVEFILE_WRITE_THROUGH): atomic on NTFS, and it returns once the move is on disk.
func renameReplace(oldpath, newpath string) error {
	from, err := windows.UTF16PtrFromString(oldpath)
	if err != nil {
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: err}
	}
	to, err := windows.UTF16PtrFromString(newpath)
	if err != nil {
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: err}
	}
	for attempt := 0; ; attempt++ {
		err = windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
		if err == nil {
			return nil
		}
		if attempt == renameRetries || !transientRename(err) {
			return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: err}
		}
		time.Sleep(renameRetryDelay)
	}
}

func transientRename(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_ACCESS_DENIED)
}

// syncDir is a no-op on Windows: MoveFileEx with MOVEFILE_WRITE_THROUGH returns only
// once the rename is flushed, and NTFS journals the directory entries.
func syncDir(string) error { return nil }

func isDiskFull(err error) bool {
	return errors.Is(err, windows.ERROR_DISK_FULL) || errors.Is(err, windows.ERROR_HANDLE_DISK_FULL)
}

// trustedOwner checks that path is a regular file owned by SYSTEM or Administrators
// (§10.12 step 4). A process without administrator rights (development, unit tests)
// also trusts its own user.
func trustedOwner(path string) error {
	fi, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", path)
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	if owner == nil {
		return fmt.Errorf("%s has no owner", path)
	}
	if owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		return nil
	}
	if !platform.IsElevated() {
		if tu, err := windows.GetCurrentProcessToken().GetTokenUser(); err == nil && tu.User.Sid.Equals(owner) {
			return nil
		}
	}
	return fmt.Errorf("%s is owned by %s, not SYSTEM or Administrators", path, owner.String())
}
