package svc

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/sys/windows"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

func TestQueryStatusMissingService(t *testing.T) {
	st, err := queryStatus("CentrateGuardianTest" + strconv.FormatInt(time.Now().UnixNano(), 36))
	if err != nil {
		t.Fatalf("queryStatus = %v, want no error for a missing service", err)
	}
	if st.Installed || st.Running {
		t.Fatalf("status = %+v, want not installed", st)
	}
}

// The Windows Event Log service always exists and runs; querying it needs
// no administrator rights, like querying the guardian from the desktop app.
func TestQueryStatusWithLowRights(t *testing.T) {
	st, err := queryStatus("EventLog")
	if err != nil {
		t.Fatalf("queryStatus(EventLog) = %v", err)
	}
	if !st.Installed || !st.Running {
		t.Fatalf("status = %+v, want installed and running", st)
	}
}

// TestHelperSleep is the child process of TestOpenServiceProcessWaitsForExit.
func TestHelperSleep(t *testing.T) {
	if os.Getenv("CENTRATE_TEST_HELPER_SLEEP") == "" {
		t.Skip("helper process only")
	}
	time.Sleep(time.Second)
}

func TestOpenServiceProcessWaitsForExit(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestHelperSleep$")
	cmd.Env = append(os.Environ(), "CENTRATE_TEST_HELPER_SLEEP=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Wait() }()
	pid := uint32(cmd.Process.Pid)
	if p := openServiceProcess(pid, `C:\somewhere\other.exe`); p != nil {
		p.close()
		t.Fatal("a process running another image must not be used")
	}
	if openServiceProcess(0, os.Args[0]) != nil {
		t.Fatal("pid 0 must not be opened")
	}
	p := openServiceProcess(pid, os.Args[0])
	if p == nil {
		t.Fatal("could not open the child process")
	}
	defer p.close()
	if p.wait(10 * time.Millisecond) {
		t.Fatal("the child exited too early")
	}
	if !p.wait(30 * time.Second) {
		t.Fatal("wait did not see the child exit")
	}
}

func TestCheckTrustedExecutableRejectsUserFolders(t *testing.T) {
	if platform.DevBuild {
		t.Skip("dev builds skip the check")
	}
	if installerSIDs() != nil {
		t.Skip("UAC is off for this account: its own folders are trusted")
	}
	exe := filepath.Join(t.TempDir(), "centrate-guardian.exe")
	if err := os.WriteFile(exe, []byte("MZ"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := checkTrustedExecutable(exe); !errors.Is(err, ErrUntrustedExecutable) {
		t.Fatalf("checkTrustedExecutable(temp) = %v, want ErrUntrustedExecutable", err)
	}
}

// Whatever the UAC setting, a binary that Everyone may write is refused.
func TestCheckTrustedExecutableRejectsWorldWritableBinary(t *testing.T) {
	if platform.DevBuild {
		t.Skip("dev builds skip the check")
	}
	exe := filepath.Join(t.TempDir(), "centrate-guardian.exe")
	if err := os.WriteFile(exe, []byte("MZ"), 0o755); err != nil {
		t.Fatal(err)
	}
	everyone, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		t.Fatal(err)
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.GRANT_ACCESS,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_WELL_KNOWN_GROUP,
			TrusteeValue: windows.TrusteeValueFromSID(everyone),
		},
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(exe, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		t.Fatal(err)
	}
	if err := checkTrustedExecutable(exe); !errors.Is(err, ErrUntrustedExecutable) {
		t.Fatalf("checkTrustedExecutable = %v, want ErrUntrustedExecutable", err)
	}
}

func TestReadACLOfSystemFolder(t *testing.T) {
	acl, err := readACL(os.Getenv("SystemRoot"))
	if err != nil {
		t.Fatal(err)
	}
	if acl.owner == "" || acl.nullDACL || len(acl.aces) == 0 {
		t.Fatalf("acl = %+v", acl)
	}
}

func TestIsNetworkPath(t *testing.T) {
	cases := map[string]bool{
		`\\server\share\centrate-guardian.exe`:        true,
		`\\?\UNC\server\share\centrate-guardian.exe`:  true,
		os.Getenv("SystemRoot") + `\System32\cmd.exe`: false,
	}
	for in, want := range cases {
		if got := isNetworkPath(in); got != want {
			t.Errorf("isNetworkPath(%q) = %v, want %v", in, got, want)
		}
	}
}
