package svc

import (
	"fmt"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// aceAccessDenied is ACCESS_DENIED_ACE_TYPE (same layout as an allowed entry).
const aceAccessDenied = 0x1

// checkTrustedExecutable refuses to register exe as a LocalSystem service
// unless only SYSTEM, Administrators and TrustedInstaller can replace it:
// they must own the file and every folder above it, and no other account may
// hold write, delete or permission rights on the file, add or delete entries
// in its folder, or delete, rename or re-permission a folder further up (see
// checkACL). The NSIS per-machine install under Program Files passes; a copy
// in Downloads, %LOCALAPPDATA%, a repository or the root of a data drive
// (where Authenticated Users may modify) does not. Dev builds skip the check.
func checkTrustedExecutable(exe string) error {
	if platform.DevBuild {
		return nil
	}
	p, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUntrustedExecutable, err)
	}
	if p, err = filepath.Abs(p); err != nil {
		return fmt.Errorf("%w: %v", ErrUntrustedExecutable, err)
	}
	if isNetworkPath(p) {
		return fmt.Errorf("%w: %s is on a network drive", ErrUntrustedExecutable, p)
	}
	extra := installerSIDs()
	rights := uint32(exeRights)
	for cur, first := p, true; ; first = false {
		acl, err := readACL(cur)
		if err != nil {
			return fmt.Errorf("%w: %s: %v", ErrUntrustedExecutable, cur, err)
		}
		if err := checkACL(cur, acl, rights, extra); err != nil {
			return fmt.Errorf("%w: %v", ErrUntrustedExecutable, err)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return nil
		}
		cur = parent
		if first {
			rights = parentRights
		} else {
			rights = ancestorRights
		}
	}
}

// tokenElevationTypeDefault is TokenElevationTypeDefault: the token has no
// filtered twin (UAC is off, or it is the built-in Administrator or a service
// account).
const tokenElevationTypeDefault = 1

// installerSIDs returns the installing account's SID when UAC is off for it.
// Its processes then always run with full rights, so trusting it adds no
// exposure, and Windows makes it (not Administrators) the owner of what the
// installer creates, including the CREATOR OWNER entry Program Files passes
// down. With UAC on, elevated installs are owned by Administrators and the
// account is not trusted: its unelevated processes must not be able to swap
// the binary.
func installerSIDs() []string {
	tok := windows.GetCurrentProcessToken()
	if !tok.IsElevated() {
		return nil
	}
	var elevationType, n uint32
	if err := windows.GetTokenInformation(tok, windows.TokenElevationType,
		(*byte)(unsafe.Pointer(&elevationType)), uint32(unsafe.Sizeof(elevationType)), &n); err != nil ||
		elevationType != tokenElevationTypeDefault {
		return nil
	}
	user, err := tok.GetTokenUser()
	if err != nil {
		return nil
	}
	return []string{user.User.Sid.String()}
}

func isNetworkPath(p string) bool {
	vol := strings.ToUpper(filepath.VolumeName(p))
	switch {
	case strings.HasPrefix(vol, `\\?\UNC\`):
		return true
	case strings.HasPrefix(vol, `\\?\`), strings.HasPrefix(vol, `\\.\`):
	case strings.HasPrefix(vol, `\\`):
		return true
	}
	root, err := windows.UTF16PtrFromString(vol + `\`)
	if err != nil {
		return true
	}
	return windows.GetDriveType(root) == windows.DRIVE_REMOTE
}

// readACL reads the owner and DACL of path in the form checkACL takes.
func readACL(path string) (objectACL, error) {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return objectACL{}, err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return objectACL{}, err
	}
	acl := objectACL{owner: owner.String()}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		// No DACL (or a NULL one) grants everyone full access.
		acl.nullDACL = true
		return acl, nil
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return objectACL{}, err
		}
		info := aceInfo{aceType: ace.Header.AceType, flags: ace.Header.AceFlags, mask: uint32(ace.Mask)}
		switch info.aceType {
		case aceAccessAllowed, aceAccessDenied, aceAccessAllowedCallback:
			// These types store the SID right after the mask.
			info.sid = (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		}
		acl.aces = append(acl.aces, info)
	}
	return acl, nil
}
