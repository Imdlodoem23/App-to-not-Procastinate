package hosts

import (
	"os"
	"testing"

	"golang.org/x/sys/windows"
)

func fileAttrs(t *testing.T, path string) uint32 {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	a, err := windows.GetFileAttributes(p)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func setAttrs(t *testing.T, path string, attrs uint32) {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetFileAttributes(p, attrs); err != nil {
		t.Fatal(err)
	}
}

func TestApplyKeepsReadOnlyAndHiddenAttributes(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	setAttrs(t, path, windows.FILE_ATTRIBUTE_READONLY|windows.FILE_ATTRIBUTE_HIDDEN)
	t.Cleanup(func() { setAttrs(t, path, windows.FILE_ATTRIBUTE_NORMAL) })

	mustApply(t, m, "a.com")
	if got := readString(t, path); got != windowsDefaultHosts+"\r\n"+section("\r\n", "a.com") {
		t.Fatalf("got %q", got)
	}
	a := fileAttrs(t, path)
	if a&windows.FILE_ATTRIBUTE_READONLY == 0 || a&windows.FILE_ATTRIBUTE_HIDDEN == 0 {
		t.Fatalf("attributes %#x lost read-only or hidden", a)
	}
	mustRemove(t, m)
	if got := readString(t, path); got != windowsDefaultHosts {
		t.Fatalf("after Remove got %q", got)
	}
}

func TestApplyKeepsProtectedDACL(t *testing.T) {
	m, path := newManager(t, []byte(windowsDefaultHosts))
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Skip("no token user:", err)
	}
	sddl := "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + user.User.Sid.String() + ")(A;;FR;;;BU)"
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Skip("cannot set a DACL here:", err)
	}
	want := daclString(t, path)

	mustApply(t, m, "a.com")
	if got := daclString(t, path); got != want {
		t.Fatalf("DACL after Apply\n got %s\nwant %s", got, want)
	}
}

func daclString(t *testing.T, path string) string {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	return sd.String()
}

func TestWindowsLockErrorsAreTransient(t *testing.T) {
	for _, errno := range []windows.Errno{
		windows.ERROR_SHARING_VIOLATION, windows.ERROR_LOCK_VIOLATION,
		windows.ERROR_ACCESS_DENIED, windows.ERROR_USER_MAPPED_FILE,
	} {
		err := &os.LinkError{Op: "MoveFileEx", Old: "a", New: "b", Err: errno}
		if !isTransientLock(err) || !canWriteInPlace(err) {
			t.Errorf("%v should be retried and then written in place", errno)
		}
	}
	if isTransientLock(&os.LinkError{Err: windows.ERROR_FILE_NOT_FOUND}) {
		t.Error("ERROR_FILE_NOT_FOUND is not a lock")
	}
}

func TestReplaceFileOverwrites(t *testing.T) {
	dir := t.TempDir()
	src, dst := dir+`\src`, dir+`\dst`
	if err := os.WriteFile(src, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := replaceFile(src, dst); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, dst); got != "new" {
		t.Fatalf("got %q", got)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("source still exists: %v", err)
	}
}
