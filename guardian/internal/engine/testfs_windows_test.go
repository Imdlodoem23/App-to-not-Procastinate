package engine

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// renameNoFlush is the store's Windows rename (MoveFileEx with MOVEFILE_REPLACE_EXISTING:
// atomic on NTFS, retried while another process such as an antivirus has the target
// open) without MOVEFILE_WRITE_THROUGH, which waits for the disk (see testFS).
func renameNoFlush(oldpath, newpath string) error {
	from, err := windows.UTF16PtrFromString(oldpath)
	if err != nil {
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: err}
	}
	to, err := windows.UTF16PtrFromString(newpath)
	if err != nil {
		return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: err}
	}
	const retries, delay = 10, 50 * time.Millisecond
	for attempt := 0; ; attempt++ {
		err = windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING)
		if err == nil {
			return nil
		}
		transient := errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
			errors.Is(err, windows.ERROR_ACCESS_DENIED)
		if attempt == retries || !transient {
			return &os.LinkError{Op: "rename", Old: oldpath, New: newpath, Err: err}
		}
		time.Sleep(delay)
	}
}
