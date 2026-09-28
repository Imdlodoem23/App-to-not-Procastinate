package store

import (
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The snapshots get a protected DACL naming only SYSTEM, Administrators and the
// owner at creation: a standard user can no longer open them, so none can hold a
// share-mode-0 handle that makes MoveFileEx over them fail.
func TestStateFilesPrivateOnWindows(t *testing.T) {
	if statePerm&0o077 != 0 {
		t.Fatalf("statePerm %v is not private", statePerm)
	}
	e := newEnv(t)
	s := e.started()
	mustAppend(t, s, batchOf(1, "a"))
	for gen := 1; gen <= 2; gen++ {
		if err := s.SaveState(snapshot(s, gen)); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{stateFile, statePrevFile} {
		p := filepath.Join(e.dir, f)
		sd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			t.Fatal(err)
		}
		ctrl, _, err := sd.Control()
		if err != nil || ctrl&windows.SE_DACL_PROTECTED == 0 {
			t.Fatalf("%s: DACL not protected (%v)", f, err)
		}
		dacl, _, err := sd.DACL()
		if err != nil || dacl == nil {
			t.Fatalf("%s: no DACL (%v)", f, err)
		}
		for i := uint32(0); i < uint32(dacl.AceCount); i++ {
			var ace *windows.ACCESS_ALLOWED_ACE
			if err := windows.GetAce(dacl, i, &ace); err != nil {
				t.Fatal(err)
			}
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			for _, wk := range []windows.WELL_KNOWN_SID_TYPE{windows.WinBuiltinUsersSid, windows.WinWorldSid, windows.WinAuthenticatedUserSid} {
				if sid.IsWellKnown(wk) {
					t.Fatalf("%s grants %s", f, sid.String())
				}
			}
		}
		// The guardian still reads it (has-active runs elevated; here: the owner).
		if _, err := ReadEnforcement(e.dir); err != nil {
			t.Fatal(err)
		}
	}
}
