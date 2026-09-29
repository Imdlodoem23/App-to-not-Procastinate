package hosts

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// settableAttrs are the attributes SetFileAttributes accepts that a hosts file
// may carry and the replacement should keep.
const settableAttrs = windows.FILE_ATTRIBUTE_READONLY | windows.FILE_ATTRIBUTE_HIDDEN |
	windows.FILE_ATTRIBUTE_SYSTEM | windows.FILE_ATTRIBUTE_ARCHIVE |
	windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED

// fileMeta is what the replacement file inherits from the original: its
// attributes (some tools mark hosts read-only) and its security descriptor
// (owner, group and DACL, including explicit ACEs and inheritance protection).
type fileMeta struct {
	exists bool
	attrs  uint32
	sd     *windows.SECURITY_DESCRIPTOR
}

func captureMeta(path string) fileMeta {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return fileMeta{}
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		return fileMeta{}
	}
	fm := fileMeta{exists: true, attrs: attrs}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err == nil {
		fm.sd = sd
	}
	return fm
}

func (fileMeta) applyOpen(*os.File) {}

// applyClosed copies the original's owner, group and DACL to the temporary
// file. Protected DACLs stay protected; unprotected ones keep inheriting from
// the directory (SetNamedSecurityInfo drops the inherited ACEs we pass and
// re-inherits them). Best effort: setting an owner other than the caller or
// one of its groups needs SeRestorePrivilege to be enabled; when that fails
// the service account stays the owner and the DACL is still copied.
func (fm fileMeta) applyClosed(name string) {
	if fm.sd == nil {
		return
	}
	if owner, _, err := fm.sd.Owner(); err == nil && owner != nil {
		_ = windows.SetNamedSecurityInfo(name, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, owner, nil, nil, nil)
	}
	if group, _, err := fm.sd.Group(); err == nil && group != nil {
		_ = windows.SetNamedSecurityInfo(name, windows.SE_FILE_OBJECT, windows.GROUP_SECURITY_INFORMATION, nil, group, nil, nil)
	}
	dacl, _, err := fm.sd.DACL()
	if err != nil || dacl == nil {
		return
	}
	info := windows.SECURITY_INFORMATION(windows.DACL_SECURITY_INFORMATION | windows.UNPROTECTED_DACL_SECURITY_INFORMATION)
	if ctrl, _, err := fm.sd.Control(); err == nil && ctrl&windows.SE_DACL_PROTECTED != 0 {
		info = windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION
	}
	_ = windows.SetNamedSecurityInfo(name, windows.SE_FILE_OBJECT, info, nil, nil, dacl, nil)
}

// blockingAttrs make MoveFileEx or an in-place open of the destination fail
// with ERROR_ACCESS_DENIED (read-only), or are known to upset some replace
// paths (hidden, system).
const blockingAttrs = windows.FILE_ATTRIBUTE_READONLY | windows.FILE_ATTRIBUTE_HIDDEN |
	windows.FILE_ATTRIBUTE_SYSTEM

// prepare clears the blocking attributes of the original before it is
// replaced (some tools mark hosts read-only to protect it). undo puts them back
// when the write fails; finish applies the original attributes to the new
// file.
func (fm fileMeta) prepare(path string) (undo func()) {
	if !fm.exists || fm.attrs&blockingAttrs == 0 {
		return func() {}
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return func() {}
	}
	if windows.SetFileAttributes(p, normalAttrs(fm.attrs&^blockingAttrs)) != nil {
		return func() {}
	}
	return func() { _ = windows.SetFileAttributes(p, normalAttrs(fm.attrs)) }
}

func (fm fileMeta) finish(path string) {
	if !fm.exists {
		return
	}
	if p, err := windows.UTF16PtrFromString(path); err == nil {
		_ = windows.SetFileAttributes(p, normalAttrs(fm.attrs))
	}
}

// normalAttrs keeps the settable attributes; FILE_ATTRIBUTE_NORMAL is only
// valid on its own.
func normalAttrs(attrs uint32) uint32 {
	if attrs &= settableAttrs; attrs == 0 {
		return windows.FILE_ATTRIBUTE_NORMAL
	}
	return attrs
}

// replaceFile replaces dst with src with MoveFileEx(MOVEFILE_REPLACE_EXISTING
// | MOVEFILE_WRITE_THROUGH): atomic on NTFS, and it returns only once the
// move has been flushed to disk.
func replaceFile(src, dst string) error {
	from, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return &os.LinkError{Op: "MoveFileEx", Old: src, New: dst, Err: err}
	}
	return nil
}

// isTransientLock reports the errors an antivirus or backup agent holding the
// file open produces. ERROR_ACCESS_DENIED is included because MoveFileEx
// returns it when the destination is open without FILE_SHARE_DELETE.
func isTransientLock(err error) bool {
	return errors.Is(err, errLocked) ||
		errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_ACCESS_DENIED) ||
		errors.Is(err, windows.ERROR_USER_MAPPED_FILE)
}

// replaceUnsupported reports rename failures that an in-place write avoids
// besides locks: moving across volumes (a hosts path redirected elsewhere).
func replaceUnsupported(err error) bool {
	return errors.Is(err, windows.ERROR_NOT_SAME_DEVICE)
}

// syncDir is not needed on Windows: MOVEFILE_WRITE_THROUGH already waits for
// the directory change to reach the disk.
func syncDir(string) {}
