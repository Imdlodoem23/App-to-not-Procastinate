package store

import (
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// guardian.lock has a protected DACL naming only SYSTEM, Administrators and its owner:
// a standard user who could open it, even read-only, could take the lock once the
// guardian exits and keep it out (ErrLocked). A file that inherited a Users-readable
// DACL from an older build gets the private one on the next Open.
func TestLockFileIsPrivate(t *testing.T) {
	e := newEnv(t)
	s := e.started()
	lock := filepath.Join(e.dir, dirRun, lockName)
	checkPrivateLock(t, lock)
	e.closeClean(s)

	users, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatal(err)
	}
	open, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.GRANT_ACCESS,
		Trustee: windows.TRUSTEE{TrusteeForm: windows.TRUSTEE_IS_SID, TrusteeType: windows.TRUSTEE_IS_GROUP,
			TrusteeValue: windows.TrusteeValueFromSID(users)},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(lock, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION, nil, nil, open, nil); err != nil {
		t.Fatal(err)
	}
	s, _ = e.open()
	checkPrivateLock(t, lock)
	e.closeClean(s)
}

func checkPrivateLock(t *testing.T, path string) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	ctrl, _, err := sd.Control()
	if err != nil || ctrl&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("DACL not protected: %v", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		t.Fatalf("no DACL: %v", err)
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			continue
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if !sid.IsWellKnown(windows.WinLocalSystemSid) && !sid.IsWellKnown(windows.WinBuiltinAdministratorsSid) &&
			!sid.IsWellKnown(windows.WinCreatorOwnerRightsSid) {
			t.Fatalf("lock file grants %s", sid)
		}
	}
}
