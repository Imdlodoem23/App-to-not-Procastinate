package platform

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func needElevation(t *testing.T) {
	t.Helper()
	if !IsElevated() {
		t.Skip("needs an elevated token")
	}
}

// aceSIDs returns the DACL of path as SID string -> access mask, and whether
// the DACL is protected from inheritance.
func aceSIDs(t *testing.T, path string) (map[string]windows.ACCESS_MASK, bool, *windows.SID) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		t.Fatal(err)
	}
	ctrl, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	aces := map[string]windows.ACCESS_MASK{}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			t.Fatalf("unexpected ACE type %d", ace.Header.AceType)
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		aces[sid.String()] |= ace.Mask
	}
	return aces, ctrl&windows.SE_DACL_PROTECTED != 0, owner
}

func TestEnsureDirSetsDACLWhenElevated(t *testing.T) {
	needElevation(t)
	dir := filepath.Join(t.TempDir(), "Centrate")
	forceElevated(t, true)
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	aces, protected, owner := aceSIDs(t, dir)
	if !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		t.Fatalf("owner = %s, want BUILTIN\\Administrators", owner)
	}
	if !protected {
		t.Fatal("DACL must be protected from inheritance")
	}
	want := map[string]windows.ACCESS_MASK{
		"S-1-5-18":     fileAllAccess,
		"S-1-5-32-544": fileAllAccess,
		"S-1-5-32-545": fileReadExecute,
	}
	if len(aces) != len(want) {
		t.Fatalf("ACEs = %v, want %v", aces, want)
	}
	for sid, mask := range want {
		if aces[sid]&mask != mask {
			t.Errorf("%s mask = %#x, want at least %#x", sid, aces[sid], mask)
		}
	}
	if aces["S-1-5-32-545"]&(windows.FILE_WRITE_DATA|windows.FILE_APPEND_DATA|windows.DELETE) != 0 {
		t.Errorf("Users must not be able to write: mask %#x", aces["S-1-5-32-545"])
	}
}

func TestEnsurePrivateDirExcludesUsers(t *testing.T) {
	needElevation(t)
	dir := filepath.Join(t.TempDir(), "Centrate", "secret")
	forceElevated(t, true)
	if err := EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	aces, protected, _ := aceSIDs(t, dir)
	if !protected || len(aces) != 2 || aces["S-1-5-18"] == 0 || aces["S-1-5-32-544"] == 0 {
		t.Fatalf("ACEs = %v protected=%v, want SYSTEM and Administrators only", aces, protected)
	}
	// The parent created on the way gets the normal descriptor.
	aces, _, _ = aceSIDs(t, filepath.Dir(dir))
	if aces["S-1-5-32-545"] == 0 {
		t.Fatalf("parent ACEs = %v, want Users read", aces)
	}
}

func currentUserSID(t *testing.T) *windows.SID {
	t.Helper()
	tu, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := tu.User.Sid
	if sid.IsWellKnown(windows.WinLocalSystemSid) {
		t.Skip("running as SYSTEM: no other owner to plant")
	}
	return sid
}

func setOwner(t *testing.T, path string, sid *windows.SID) {
	t.Helper()
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, sid, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
}

func asideEntries(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(dir))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), filepath.Base(dir)+".untrusted-") {
			out = append(out, filepath.Join(filepath.Dir(dir), e.Name()))
		}
	}
	return out
}

func TestEnsureDirMovesAsideForeignOwnedDir(t *testing.T) {
	needElevation(t)
	user := currentUserSID(t)
	dir := filepath.Join(t.TempDir(), "Centrate")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte("planted"), 0o644); err != nil {
		t.Fatal(err)
	}
	setOwner(t, dir, user)
	forceElevated(t, true)
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	if _, _, owner := aceSIDs(t, dir); !owner.IsWellKnown(windows.WinBuiltinAdministratorsSid) {
		t.Fatalf("owner = %s", owner)
	}
	if _, err := os.Stat(filepath.Join(dir, "state.json")); !os.IsNotExist(err) {
		t.Fatalf("planted file still inside: %v", err)
	}
	aside := asideEntries(t, dir)
	if len(aside) != 1 {
		t.Fatalf("aside = %v", aside)
	}
	if _, err := os.Stat(filepath.Join(aside[0], "state.json")); err != nil {
		t.Fatalf("planted file not moved aside: %v", err)
	}
}

func TestEnsureDirMovesAsideTreeWithForeignChild(t *testing.T) {
	needElevation(t)
	user := currentUserSID(t)
	dir := filepath.Join(t.TempDir(), "Centrate")
	forceElevated(t, true)
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(dir, "logs")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}
	setOwner(t, child, user)
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(child); !os.IsNotExist(err) {
		t.Fatalf("foreign child still inside: %v", err)
	}
	if len(asideEntries(t, dir)) != 1 {
		t.Fatal("the tree must be moved aside")
	}
}

func TestEnsureDirMovesAsideTreeWithLink(t *testing.T) {
	needElevation(t)
	dir := filepath.Join(t.TempDir(), "Centrate")
	forceElevated(t, true)
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	if err := os.Symlink(target, filepath.Join(dir, "backups")); err != nil {
		t.Skipf("cannot create a symlink: %v", err)
	}
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "backups")); !os.IsNotExist(err) {
		t.Fatalf("link still inside: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("link target touched: %v", err)
	}
}

func TestEnsureDirKeepsTrustedTree(t *testing.T) {
	needElevation(t)
	dir := filepath.Join(t.TempDir(), "Centrate")
	forceElevated(t, true)
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	// Files this (elevated) process creates are owned by Administrators.
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDir(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "state.json")); err != nil {
		t.Fatalf("trusted content lost: %v", err)
	}
	if aside := asideEntries(t, dir); len(aside) != 0 {
		t.Fatalf("trusted tree moved aside: %v", aside)
	}
}

func TestWriteSecretFileDACL(t *testing.T) {
	forceElevated(t, false)
	p := filepath.Join(t.TempDir(), "extensions.json")
	if err := WriteSecretFile(p, []byte("secret")); err != nil {
		t.Fatal(err)
	}
	aces, protected, _ := aceSIDs(t, p)
	if !protected {
		t.Fatal("the secret's DACL must be protected from inheritance")
	}
	for _, sid := range []string{
		"S-1-5-32-545", // BUILTIN\Users
		"S-1-5-11",     // Authenticated Users
		"S-1-1-0",      // Everyone
		"S-1-5-4",      // INTERACTIVE
	} {
		if _, ok := aces[sid]; ok {
			t.Errorf("secret readable by %s: %v", sid, aces)
		}
	}
	for sid := range aces {
		switch sid {
		case "S-1-5-18", "S-1-5-32-544", "S-1-3-4":
		default:
			t.Errorf("unexpected ACE for %s", sid)
		}
	}
}

func TestOpenRegularFileSharesDelete(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "logs")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "guardian.log")
	f, err := OpenRegularFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, FileMode)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(p, p+".1"); err != nil {
		t.Fatalf("rename while open: %v", err)
	}
}

func TestRemoveDataDirRetriesTransientErrors(t *testing.T) {
	makeDataDir(t)
	calls, slept := 0, 0
	prevRemove, prevSleep := removeAll, sleep
	t.Cleanup(func() { removeAll, sleep = prevRemove, prevSleep })
	removeAll = func(p string) error {
		calls++
		if calls < 3 {
			return &os.PathError{Op: "remove", Path: p, Err: windows.ERROR_SHARING_VIOLATION}
		}
		return os.RemoveAll(p)
	}
	sleep = func(time.Duration) { slept++ }
	if err := RemoveDataDir(); err != nil {
		t.Fatal(err)
	}
	if calls != 3 || slept != 2 {
		t.Fatalf("calls=%d slept=%d, want 3 and 2", calls, slept)
	}
}
