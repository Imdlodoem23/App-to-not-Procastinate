package platform

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// NTFS and ReFS paths are case-insensitive.
const caseInsensitivePaths = true

// fileAllAccess is FILE_ALL_ACCESS (STANDARD_RIGHTS_REQUIRED | SYNCHRONIZE | 0x1FF).
const fileAllAccess = windows.STANDARD_RIGHTS_ALL | 0x1FF

// fileReadExecute is the "Read & execute" permission of the Explorer dialog (0x1200a9).
const fileReadExecute = windows.FILE_GENERIC_READ | windows.FILE_GENERIC_EXECUTE

// Security descriptors, in SDDL. "PAI": protected from inheritance, children
// inherit automatically. OICI: inherited by files and subfolders.
const (
	// dataDirSDDL: owner Administrators; SYSTEM and Administrators full
	// control, Users read & execute.
	dataDirSDDL = "O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)"
	// privateDirSDDL: owner Administrators; SYSTEM and Administrators only.
	privateDirSDDL = "O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	// secretFileSDDL: SYSTEM, Administrators and the file's owner only
	// (Administrators or SYSTEM when elevated; the developer otherwise).
	secretFileSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)"
	// dataFileSDDL and privateFileSDDL are what the takeover gives files:
	// the entries of dataDirSDDL and privateDirSDDL without inheritance
	// flags, owner Administrators.
	dataFileSDDL    = "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)"
	privateFileSDDL = "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)"
)

func defaultDataDir() string {
	base, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil || base == "" {
		base = os.Getenv("ProgramData")
	}
	if base == "" {
		base = `C:\ProgramData`
	}
	return filepath.Join(base, "Centrate")
}

// defaultHostsPath follows the DataBasePath registry value; see
// hostspath_windows.go.
func defaultHostsPath() string {
	p, _ := systemHostsPath()
	return p
}

// IsElevated reports whether the process token is elevated (an administrator
// past UAC, or a service running as LocalSystem).
func IsElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

// UseSystemPATH is a no-op on Windows: the guardian runs no binary by name there.
func UseSystemPATH() {}

// secureDir creates dir (and missing parents) atomically with the guardian's
// security descriptor and takes over the whole tree (see takeover.go): an
// untrusted tree is moved aside and created again; in a trusted one links,
// junctions and multi-linked files are deleted and every entry gets owner
// Administrators and the protected DACL, set through handles opened on the
// entry itself (never on a link's target) with SetKernelObjectSecurity, which
// changes that one object and propagates nothing.
func secureDir(dir string, private bool, rep *TakeoverReport) error {
	// Objects this process creates from now on are owned by Administrators
	// even where local policy makes the creating account the owner.
	setDefaultOwnerAdministrators()
	sddl := dataDirSDDL
	if private {
		sddl = privateDirSDDL
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	parentSD, err := windows.SecurityDescriptorFromString(dataDirSDDL)
	if err != nil {
		return err
	}
	return secureLoop(windowsTree{}, dir, private, func() error { return createSecure(dir, sd, parentSD) }, rep)
}

// createSecure creates dir with sd if it does not exist, creating missing
// parents with parentSD first. Creating with the final descriptor leaves no
// window in which the folder carries C:\ProgramData's inherited ACL (which
// lets every user add files).
func createSecure(dir string, sd, parentSD *windows.SECURITY_DESCRIPTOR) error {
	_, err := os.Lstat(dir)
	if err == nil {
		return nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if parent := filepath.Dir(dir); parent != dir {
		if err := createSecure(parent, parentSD, parentSD); err != nil {
			return err
		}
	}
	p, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
	}
	if err := windows.CreateDirectory(p, &sa); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return &fs.PathError{Op: "mkdir", Path: dir, Err: err}
	}
	// On ERROR_ALREADY_EXISTS someone else created it first: untrustedEntry
	// decides whether to keep it.
	return nil
}

// windowsTree implements treeOps with handles opened with
// FILE_FLAG_OPEN_REPARSE_POINT: no operation follows a link or junction.
type windowsTree struct{}

func (windowsTree) inspect(path string) (treeEntry, error) {
	h, err := openEntry(path, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL)
	if err != nil {
		return treeEntry{}, err
	}
	defer windows.CloseHandle(h)
	var bhfi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &bhfi); err != nil {
		return treeEntry{}, err
	}
	e := treeEntry{kind: entryKindOf(bhfi.FileAttributes), links: uint64(bhfi.NumberOfLinks)}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return treeEntry{}, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return treeEntry{}, err
	}
	e.trusted = trustedOwner(owner)
	e.private = privateDescriptor(sd)
	return e, nil
}

func entryKindOf(attrs uint32) entryKind {
	switch {
	case attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0:
		return entryLink
	case attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0:
		return entryDir
	}
	return entryFile
}

// openEntry opens the entry itself (a link or junction, not its target;
// directories too) with access and every sharing mode.
func openEntry(path string, access uint32) (windows.Handle, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	h, err := windows.CreateFile(p, access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return windows.InvalidHandle, &fs.PathError{Op: "open", Path: path, Err: err}
	}
	return h, nil
}

func trustedOwner(owner *windows.SID) bool {
	return owner != nil && (owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid))
}

// privateDescriptor reports whether sd has a protected DACL whose allow
// entries only name SYSTEM, Administrators and OWNER RIGHTS (deny entries
// are fine): the descriptors of secret/ and of WriteSecretFile.
func privateDescriptor(sd *windows.SECURITY_DESCRIPTOR) bool {
	ctrl, _, err := sd.Control()
	if err != nil || ctrl&windows.SE_DACL_PROTECTED == 0 {
		return false
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		return false // a NULL DACL grants everyone everything
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return false
		}
		switch ace.Header.AceType {
		case windows.ACCESS_DENIED_ACE_TYPE:
			continue
		case windows.ACCESS_ALLOWED_ACE_TYPE:
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			if !sid.IsWellKnown(windows.WinLocalSystemSid) && !sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) &&
				!sid.IsWellKnown(windows.WinCreatorOwnerRightsSid) {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func (windowsTree) list(dir string) ([]string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, len(ents))
	for i, e := range ents {
		names[i] = e.Name()
	}
	return names, nil
}

// remove deletes the entry: DeleteFile removes a file link or one name of a
// multi-linked file, RemoveDirectory a directory symlink or junction, never
// what it points to.
func (windowsTree) remove(path string) error { return os.Remove(path) }

// secure sets owner Administrators and the protected DACL through a handle
// on the entry itself, after checking through that handle that it is still
// the kind inspect saw. Directories get dataDirSDDL (privateDirSDDL when
// private); files the same entries without inheritance flags.
func (windowsTree) secure(path string, e treeEntry, root, private bool) error {
	sddl := dataDirSDDL
	switch {
	case e.kind == entryDir && private:
		sddl = privateDirSDDL
	case e.kind == entryFile && private:
		sddl = privateFileSDDL
	case e.kind == entryFile:
		sddl = dataFileSDDL
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	const access = windows.READ_CONTROL | windows.WRITE_DAC | windows.WRITE_OWNER | windows.FILE_READ_ATTRIBUTES
	h, err := openEntry(path, access)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		// A DACL that denies SYSTEM WRITE_DAC or WRITE_OWNER: with backup
		// semantics, SeRestorePrivilege grants them anyway.
		enableTakeoverPrivileges()
		h, err = openEntry(path, access)
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	var bhfi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &bhfi); err != nil {
		return err
	}
	switch now := entryKindOf(bhfi.FileAttributes); {
	case now != e.kind:
		return fmt.Errorf("%s changed while it was secured", path)
	case now == entryFile && bhfi.NumberOfLinks > 1:
		return fmt.Errorf("%s has more than one hard link", path)
	}
	return windows.SetKernelObjectSecurity(h,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, sd)
}

var takeoverPrivileges sync.Once

// enableTakeoverPrivileges enables SeRestorePrivilege and
// SeTakeOwnershipPrivilege in the process token (best effort, once).
func enableTakeoverPrivileges() {
	takeoverPrivileges.Do(func() {
		for _, name := range []string{"SeRestorePrivilege", "SeTakeOwnershipPrivilege"} {
			_ = enablePrivilege(name)
		}
	})
}

// enablePrivilege enables one privilege the process token holds.
func enablePrivilege(name string) error {
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &tok); err != nil {
		return err
	}
	defer tok.Close()
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, namePtr, &luid); err != nil {
		return err
	}
	tp := windows.Tokenprivileges{
		PrivilegeCount: 1,
		Privileges:     [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}},
	}
	return windows.AdjustTokenPrivileges(tok, false, &tp, 0, nil, nil)
}

// tokenOwner is TOKEN_OWNER.
type tokenOwner struct {
	Owner *windows.SID
}

// setDefaultOwnerAdministrators makes BUILTIN\Administrators the default
// owner of objects this process creates. It needs an elevated token (or
// LocalSystem) and is best effort.
func setDefaultOwnerAdministrators() {
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return
	}
	var tok windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_DEFAULT|windows.TOKEN_QUERY, &tok); err != nil {
		return
	}
	defer tok.Close()
	owner := tokenOwner{Owner: admins}
	_ = windows.SetTokenInformation(tok, windows.TokenOwner, (*byte)(unsafe.Pointer(&owner)), uint32(unsafe.Sizeof(owner)))
}

// OpenRegularFile opens path like os.OpenFile, but opens a link or junction
// itself instead of its target (FILE_FLAG_OPEN_REPARSE_POINT) and fails unless
// the result is a regular file with exactly one hard link, so a file planted
// by another user cannot redirect an elevated write. O_TRUNC is applied only
// after those checks. The handle shares read, write and delete, so the file
// can be rotated or its folder deleted while it is open.
func OpenRegularFile(path string, flag int, perm fs.FileMode) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: path, Err: err}
	}
	var access uint32
	switch flag & (os.O_RDONLY | os.O_WRONLY | os.O_RDWR) {
	case os.O_WRONLY:
		access = windows.GENERIC_WRITE
	case os.O_RDWR:
		access = windows.GENERIC_READ | windows.GENERIC_WRITE
	default:
		access = windows.GENERIC_READ
	}
	if flag&os.O_CREATE != 0 {
		access |= windows.GENERIC_WRITE
	}
	if flag&os.O_APPEND != 0 && flag&os.O_TRUNC == 0 {
		// Append-only access: every write lands at the end of the file.
		access &^= windows.GENERIC_WRITE
		access |= windows.FILE_APPEND_DATA | windows.FILE_WRITE_ATTRIBUTES | windows.FILE_WRITE_EA |
			windows.STANDARD_RIGHTS_WRITE | windows.SYNCHRONIZE
	}
	access |= windows.FILE_READ_ATTRIBUTES
	var disposition uint32
	switch {
	case flag&(os.O_CREATE|os.O_EXCL) == os.O_CREATE|os.O_EXCL:
		disposition = windows.CREATE_NEW
	case flag&os.O_CREATE != 0:
		disposition = windows.OPEN_ALWAYS
	default:
		disposition = windows.OPEN_EXISTING
	}
	h, err := windows.CreateFile(p, access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		disposition, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: path, Err: err}
	}
	var bhfi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &bhfi); err != nil {
		_ = windows.CloseHandle(h)
		return nil, &fs.PathError{Op: "open", Path: path, Err: err}
	}
	switch {
	case bhfi.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0:
		_ = windows.CloseHandle(h)
		return nil, &fs.PathError{Op: "open", Path: path, Err: errors.New("is a link or junction")}
	case bhfi.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0:
		_ = windows.CloseHandle(h)
		return nil, &fs.PathError{Op: "open", Path: path, Err: errors.New("not a regular file")}
	case bhfi.NumberOfLinks > 1:
		_ = windows.CloseHandle(h)
		return nil, &fs.PathError{Op: "open", Path: path, Err: errors.New("has more than one hard link")}
	}
	f := os.NewFile(uintptr(h), path)
	if flag&os.O_TRUNC != 0 {
		if err := f.Truncate(0); err != nil {
			_ = f.Close()
			return nil, err
		}
	}
	return f, nil
}

// WriteSecretFile atomically replaces path with data, readable only by
// SYSTEM, Administrators and the file's owner. The temporary file is created
// with that protected DACL (never inherited from the folder, which grants
// Users read), written, flushed and moved into place. The directory must
// exist; create it with EnsurePrivateDir.
func WriteSecretFile(path string, data []byte) error {
	if elevated() {
		setDefaultOwnerAdministrators()
	}
	sd, err := windows.SecurityDescriptorFromString(secretFileSDDL)
	if err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	sa := windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
	}
	dir, base := filepath.Split(path)
	var (
		h   windows.Handle
		tmp string
	)
	for i := 0; ; i++ {
		tmp = filepath.Join(dir, "."+base+".tmp-"+strconv.Itoa(os.Getpid())+"-"+strconv.FormatInt(time.Now().UnixNano(), 36))
		p, err := windows.UTF16PtrFromString(tmp)
		if err != nil {
			return fmt.Errorf("platform: write secret: %w", err)
		}
		h, err = windows.CreateFile(p, windows.GENERIC_WRITE|windows.DELETE, 0, &sa,
			windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_FILE_EXISTS) || i == 10 {
			return fmt.Errorf("platform: write secret: %w", &fs.PathError{Op: "create", Path: tmp, Err: err})
		}
	}
	f := os.NewFile(uintptr(h), tmp)
	ok := false
	defer func() {
		if !ok {
			_ = f.Close()
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	if err := f.Sync(); err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	from, err := windows.UTF16PtrFromString(tmp)
	if err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	to, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("platform: write secret: %w", err)
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return fmt.Errorf("platform: write secret: %w", &fs.PathError{Op: "rename", Path: path, Err: err})
	}
	ok = true
	return nil
}

// transientRemoveError reports whether os.RemoveAll may succeed if retried:
// a file still open without delete sharing (the stopping service, an
// antivirus scan) or a directory whose files are pending deletion.
func transientRemoveError(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_ACCESS_DENIED) ||
		errors.Is(err, windows.ERROR_DIR_NOT_EMPTY)
}
