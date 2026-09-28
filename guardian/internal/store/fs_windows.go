package store

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"time"

	"golang.org/x/sys/windows"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// renameRetries is how often a rename is retried after a sharing violation (§11.2:
// another process, such as an antivirus or `has-active`, has the target open).
const (
	renameRetries    = 10
	renameRetryDelay = 50 * time.Millisecond
)

// setMode is a no-op: Windows files inherit the directory's protected DACL.
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
