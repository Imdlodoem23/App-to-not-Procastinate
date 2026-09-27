// Package platform answers the OS-level questions the guardian needs: where its
// protected data and logs live, where the system hosts file is, whether the
// process runs with administrator rights, and how to create folders and files
// that normal users cannot modify.
//
// Default locations:
//
//	Windows  C:\ProgramData\Centrate             %SystemRoot%\System32\drivers\etc\hosts
//	macOS    /Library/Application Support/Centrate  /etc/hosts
//	Linux    /var/lib/centrate                    /etc/hosts
//
// # Overrides
//
// CENTRATE_DATA_DIR and CENTRATE_HOSTS_PATH redirect DataDir and HostsPath for
// tests and development. They are honoured only by test binaries, by builds
// with the centrate_dev tag (see DevBuild) and by processes without
// administrator rights. An elevated process always uses the defaults: that
// covers the service itself and the install, uninstall and cleanup-hosts
// commands, which installers start with the user's environment (UAC, sudo -E,
// pkexec helpers). Relative overrides are ignored.
//
// # Files
//
// Ordinary files inherit the folder's permissions (readable by every local
// account, writable only by administrators). Secrets such as the API token must
// be written with WriteSecretFile, inside a folder made with EnsurePrivateDir:
// on Windows a file mode means nothing, only the DACL does. Files that an
// elevated process appends to or rewrites in place must be opened with
// OpenRegularFile, which never follows a planted link.
package platform

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	// EnvDataDir overrides DataDir (tests and development only; see the package doc).
	EnvDataDir = "CENTRATE_DATA_DIR"
	// EnvHostsPath overrides HostsPath (tests and development only; see the package doc).
	EnvHostsPath = "CENTRATE_HOSTS_PATH"

	// DirMode is the Unix mode of guardian directories: root writes, everyone reads.
	DirMode fs.FileMode = 0o755
	// PrivateDirMode is the Unix mode of directories made by EnsurePrivateDir.
	PrivateDirMode fs.FileMode = 0o700
	// FileMode is the Unix mode of ordinary guardian files (readable by every
	// local account). It is ignored on Windows, where the folder's DACL applies.
	FileMode fs.FileMode = 0o644
	// SecretFileMode is the Unix mode WriteSecretFile uses.
	SecretFileMode fs.FileMode = 0o600

	// DataDirMarker is the file EnsureDataDir writes inside DataDir.
	// RemoveDataDir refuses to delete a directory other than the default one
	// unless it holds this marker.
	DataDirMarker = ".centrate-data"

	// dataDirBase is the base name every data directory must have for
	// RemoveDataDir to delete it (compared case-insensitively).
	dataDirBase   = "centrate"
	logDirName    = "logs"
	backupDirName = "backups"
)

// Test seams.
var (
	// elevated is IsElevated.
	elevated = IsElevated
	// inTest reports whether this is a test binary (overrides always allowed).
	inTest = testing.Testing
	// sleep waits between RemoveDataDir attempts.
	sleep = time.Sleep
	// removeAll is os.RemoveAll.
	removeAll = os.RemoveAll
)

// DataDir returns the absolute path of the guardian data directory. It does
// not create it; call EnsureDataDir for that.
func DataDir() string {
	return fromEnv(EnvDataDir, defaultDataDir)
}

// LogDir returns the directory for the guardian's rotating logs (inside DataDir).
func LogDir() string {
	return filepath.Join(DataDir(), logDirName)
}

// BackupDir returns the directory for the hosts file backups (inside DataDir).
// The engine and the uninstall cleanup must both use it.
func BackupDir() string {
	return filepath.Join(DataDir(), backupDirName)
}

// HostsPath returns the absolute path of the system hosts file.
func HostsPath() string {
	return fromEnv(EnvHostsPath, defaultHostsPath)
}

// DefaultHostsPath returns the system hosts file, ignoring CENTRATE_HOSTS_PATH.
func DefaultHostsPath() string {
	return defaultHostsPath()
}

// EnsureDataDir creates DataDir if needed (see EnsureDir) and writes the
// DataDirMarker inside it.
func EnsureDataDir() error {
	dir := DataDir()
	if err := EnsureDir(dir); err != nil {
		return err
	}
	f, err := OpenRegularFile(filepath.Join(dir, DataDirMarker), os.O_WRONLY|os.O_CREATE, FileMode)
	if err != nil {
		return fmt.Errorf("platform: write marker: %w", err)
	}
	return f.Close()
}

// EnsureDir creates dir and its missing parents and makes sure it is a real
// directory (not a symlink or junction planted by someone else). dir must be
// absolute. When the process is elevated it also takes the directory over:
//
//   - Unix: owner root (uid 0, gid 0) and mode DirMode, set through a
//     descriptor opened without following links.
//   - Windows: every missing directory is created atomically with its final
//     security descriptor (owner BUILTIN\Administrators; protected DACL:
//     SYSTEM and Administrators full control, Users read & execute, inherited
//     by everything inside), so it never carries C:\ProgramData's inherited
//     ACL, which lets every user add files. An existing tree is trusted only
//     if the directory and everything inside it are plain files and folders
//     owned by SYSTEM or Administrators, with no link, junction or file with
//     several hard links. Otherwise (a standard user can pre-create folders in
//     C:\ProgramData and plant files there) the directory is renamed to
//     "<dir>.untrusted-<unix time>", without opening anything inside, and
//     created again. Finally its owner and DACL are reset, which also resets
//     the inherited entries of what it contains. The call also makes
//     Administrators the default owner of everything the process creates
//     afterwards, so the guardian's own files always pass that check.
//
// Without elevation (development and unit tests) it only creates the directory.
func EnsureDir(dir string) error {
	return ensureDir(dir, false)
}

// EnsurePrivateDir is EnsureDir for directories only administrators may read,
// such as the one holding secrets: Unix mode PrivateDirMode; Windows DACL with
// SYSTEM and Administrators only.
func EnsurePrivateDir(dir string) error {
	return ensureDir(dir, true)
}

func ensureDir(dir string, private bool) error {
	if dir == "" {
		return errors.New("platform: empty directory path")
	}
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("platform: %q is not an absolute path", dir)
	}
	dir = filepath.Clean(dir)
	if elevated() {
		if err := secureDir(dir, private); err != nil {
			return fmt.Errorf("platform: secure %s: %w", dir, err)
		}
		return nil
	}
	mode := DirMode
	if private {
		mode = PrivateDirMode
	}
	if err := os.MkdirAll(dir, mode); err != nil {
		return fmt.Errorf("platform: create %s: %w", dir, err)
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("platform: stat %s: %w", dir, err)
	}
	if !isPlainDir(fi) {
		return fmt.Errorf("platform: %s is not a plain directory", dir)
	}
	return nil
}

func isPlainDir(fi fs.FileInfo) bool {
	return fi.IsDir() && fi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) == 0
}

// removeAttempts bounds RemoveDataDir retries on transient errors (Windows:
// a file still open by the stopping service or scanned by an antivirus).
const removeAttempts = 6

// RemoveDataDir deletes DataDir and everything inside it. Removing a missing
// directory is not an error, so it is safe to call twice. As a guard against a
// stray CENTRATE_DATA_DIR it refuses a relative path, a filesystem root and any
// directory whose name is not "Centrate"/"centrate", and it refuses any
// directory other than the default one unless it holds DataDirMarker. If the
// path is a link, only the link is removed.
func RemoveDataDir() error {
	dir := DataDir()
	if !safeToRemove(dir) {
		return fmt.Errorf("platform: refusing to remove %q", dir)
	}
	fi, err := os.Lstat(dir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return nil
	case err != nil:
		return fmt.Errorf("platform: stat %s: %w", dir, err)
	case fi.Mode()&(fs.ModeSymlink|fs.ModeIrregular) != 0:
		// A link or junction: remove the link, never what it points to.
		if err := os.Remove(dir); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("platform: remove %s: %w", dir, err)
		}
		return nil
	case !fi.IsDir():
		return fmt.Errorf("platform: refusing to remove %q: not a directory", dir)
	}
	if !samePath(dir, defaultDataDir()) && !hasMarker(dir) {
		return fmt.Errorf("platform: refusing to remove %q: it has no %s marker", dir, DataDirMarker)
	}
	delay := 100 * time.Millisecond
	for attempt := 1; ; attempt++ {
		err = removeAll(dir)
		if err == nil || attempt == removeAttempts || !transientRemoveError(err) {
			break
		}
		sleep(delay)
		delay *= 2
	}
	if err != nil {
		return fmt.Errorf("platform: remove %s: %w", dir, err)
	}
	return nil
}

func safeToRemove(dir string) bool {
	if dir == "" || !filepath.IsAbs(dir) {
		return false
	}
	clean := filepath.Clean(dir)
	if filepath.Dir(clean) == clean {
		return false
	}
	return strings.EqualFold(filepath.Base(clean), dataDirBase)
}

func hasMarker(dir string) bool {
	fi, err := os.Lstat(filepath.Join(dir, DataDirMarker))
	return err == nil && fi.Mode().IsRegular()
}

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if caseInsensitivePaths {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// overridesAllowed reports whether CENTRATE_DATA_DIR and CENTRATE_HOSTS_PATH
// are honoured in this process (see the package doc).
func overridesAllowed() bool {
	return DevBuild || inTest() || !elevated()
}

func fromEnv(key string, fallback func() string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" || !filepath.IsAbs(v) || !overridesAllowed() {
		return fallback()
	}
	return filepath.Clean(v)
}
