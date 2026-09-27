package platform

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
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
)

// secureAttempts bounds how often secureDir moves an untrusted directory
// aside and recreates it before giving up.
const secureAttempts = 3

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

func defaultHostsPath() string {
	sys, err := windows.GetSystemDirectory()
	if err != nil || sys == "" {
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		sys = filepath.Join(root, "System32")
	}
	return filepath.Join(sys, "drivers", "etc", "hosts")
}

// IsElevated reports whether the process token is elevated (an administrator
// past UAC, or a service running as LocalSystem).
func IsElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

// UseSystemPATH is a no-op on Windows: the guardian runs no binary by name there.
func UseSystemPATH() {}

// secureDir creates dir (and missing parents) atomically with the guardian's
// security descriptor, moves aside any existing tree it cannot trust, and
// resets the directory's owner and DACL. See EnsureDir.
func secureDir(dir string, private bool) error {
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
	for attempt := 1; ; attempt++ {
		if err := createSecure(dir, sd, parentSD); err != nil {
			return err
		}
		problem, err := untrustedEntry(dir, true)
		if err != nil {
			return err
		}
		if problem == "" {
			break
		}
		if attempt == secureAttempts {
			return fmt.Errorf("cannot trust %s: %s", dir, problem)
		}
		if err := moveAside(dir); err != nil {
			return fmt.Errorf("cannot trust %s (%s) and could not move it aside: %w", dir, problem, err)
		}
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	// Also pushes the inheritable entries down to the (verified) children.
	return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner, nil, dacl, nil)
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

// untrustedEntry walks the tree at path without following links and returns
// why it cannot be trusted, or "" when every entry is a plain file or
// directory owned by SYSTEM or Administrators and no file has extra hard
// links. Only a failure to inspect the root itself is returned as an error.
func untrustedEntry(path string, root bool) (string, error) {
	info, err := inspect(path)
	if err != nil {
		if root {
			return "", err
		}
		return fmt.Sprintf("%s cannot be inspected (%v)", path, err), nil
	}
	switch {
	case info.reparse:
		return path + " is a link or junction", nil
	case !info.ownerTrusted:
		return path + " is owned by another account", nil
	case !info.dir && info.links > 1:
		return path + " has more than one hard link", nil
	case !info.dir:
		return "", nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return fmt.Sprintf("%s cannot be listed (%v)", path, err), nil
	}
	for _, e := range entries {
		if problem, _ := untrustedEntry(filepath.Join(path, e.Name()), false); problem != "" {
			return problem, nil
		}
	}
	return "", nil
}

type entryInfo struct {
	dir, reparse, ownerTrusted bool
	links                      uint32
}

// inspect reads an entry's attributes, link count and owner through a handle
// opened on the entry itself (never on a link's target).
func inspect(path string) (entryInfo, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return entryInfo{}, err
	}
	h, err := windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES|windows.READ_CONTROL,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return entryInfo{}, err
	}
	defer windows.CloseHandle(h)
	var bhfi windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &bhfi); err != nil {
		return entryInfo{}, err
	}
	info := entryInfo{
		dir:     bhfi.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0,
		reparse: bhfi.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0,
		links:   bhfi.NumberOfLinks,
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return entryInfo{}, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return entryInfo{}, err
	}
	info.ownerTrusted = trustedOwner(owner)
	return info, nil
}

func trustedOwner(owner *windows.SID) bool {
	return owner != nil && (owner.IsWellKnown(windows.WinLocalSystemSid) || owner.IsWellKnown(windows.WinBuiltinAdministratorsSid))
}

// moveAside renames dir to "<dir>.untrusted-<unix time>" so a fresh one can be
// created. Renaming touches only the top entry: nothing inside a tree another
// account controls is ever opened, changed or deleted.
func moveAside(dir string) error {
	base := dir + ".untrusted-" + strconv.FormatInt(time.Now().Unix(), 10)
	aside := base
	for i := 1; ; i++ {
		if _, err := os.Lstat(aside); errors.Is(err, fs.ErrNotExist) {
			break
		}
		aside = base + "-" + strconv.Itoa(i)
	}
	return os.Rename(dir, aside)
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
