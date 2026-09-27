package svc

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

// The service manager runs the registered binary as root/LocalSystem at every
// boot, so whoever can replace that file (or rename a folder above it) owns
// the machine and can end any block. The checks below decide whether a path
// is safe to register. The Windows ACL evaluation is plain Go over SID strings
// so it can be tested on every OS.

// Access rights (winnt.h) that matter for replacing a file or a folder entry.
const (
	rightWriteData    = 0x00000002 // FILE_WRITE_DATA; FILE_ADD_FILE on a folder
	rightAppendData   = 0x00000004 // FILE_APPEND_DATA; FILE_ADD_SUBDIRECTORY on a folder
	rightDeleteChild  = 0x00000040 // FILE_DELETE_CHILD
	rightDelete       = 0x00010000 // DELETE
	rightWriteDAC     = 0x00040000 // WRITE_DAC
	rightWriteOwner   = 0x00080000 // WRITE_OWNER
	rightGenericAll   = 0x10000000 // GENERIC_ALL
	rightGenericWrite = 0x40000000 // GENERIC_WRITE
)

// Rights a non-administrator must not hold on each part of the path.
const (
	// takeoverRights let the holder delete the object or change who may.
	takeoverRights = rightDelete | rightWriteDAC | rightWriteOwner | rightGenericAll
	// exeRights: the binary itself.
	exeRights = takeoverRights | rightWriteData | rightAppendData | rightGenericWrite
	// parentRights: the folder holding the binary (adding files there would
	// also allow planting DLLs next to it).
	parentRights = takeoverRights | rightDeleteChild | rightWriteData | rightAppendData | rightGenericWrite
	// ancestorRights: folders further up, where only renaming or deleting an
	// existing entry matters (C:\ lets users create folders, which is fine).
	ancestorRights = takeoverRights | rightDeleteChild
)

// ACE types and flags (winnt.h).
const (
	aceAccessAllowed               = 0x0
	aceAccessAllowedCompound       = 0x4
	aceAccessAllowedObject         = 0x5
	aceAccessAllowedCallback       = 0x9
	aceAccessAllowedCallbackObject = 0xB
	aceFlagInheritOnly             = 0x8
)

// SIDs allowed to own and modify the binary and the folders above it.
const (
	sidSystem           = "S-1-5-18"
	sidAdministrators   = "S-1-5-32-544"
	sidTrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
	// Placeholders that never match a caller on an effective entry: CREATOR
	// OWNER only appears in inherit-only entries, OWNER RIGHTS applies to the
	// owner, which is checked separately.
	sidCreatorOwner = "S-1-3-0"
	sidOwnerRights  = "S-1-3-4"
)

// aceInfo is one access control entry, reduced to what the check needs.
type aceInfo struct {
	aceType uint8
	flags   uint8
	mask    uint32
	sid     string // empty for types whose SID is not read
}

// objectACL is the owner and DACL of one file or folder.
type objectACL struct {
	owner    string
	nullDACL bool // no DACL at all: everyone has full access
	aces     []aceInfo
}

func trustedOwnerSID(sid string, extra []string) bool {
	return sid == sidSystem || sid == sidAdministrators || sid == sidTrustedInstaller || slices.Contains(extra, sid)
}

func trustedACESID(sid string, extra []string) bool {
	return trustedOwnerSID(sid, extra) || sid == sidCreatorOwner || sid == sidOwnerRights
}

// checkACL returns why a non-administrator could replace the object at path
// (or change who may), or nil. dangerous is exeRights, parentRights or
// ancestorRights; extra lists SIDs trusted like Administrators (see
// installerSIDs). Deny, audit and label entries grant nothing and are
// skipped; allowed entries of object or compound types, which NTFS never
// uses, are refused rather than guessed at.
func checkACL(path string, acl objectACL, dangerous uint32, extra []string) error {
	if !trustedOwnerSID(acl.owner, extra) {
		return fmt.Errorf("%s is owned by %s", path, acl.owner)
	}
	if acl.nullDACL {
		return fmt.Errorf("%s has no DACL", path)
	}
	for _, a := range acl.aces {
		if a.flags&aceFlagInheritOnly != 0 {
			continue
		}
		switch a.aceType {
		case aceAccessAllowed, aceAccessAllowedCallback:
		case aceAccessAllowedCompound, aceAccessAllowedObject, aceAccessAllowedCallbackObject:
			return fmt.Errorf("%s has an access entry of unsupported type %#x", path, a.aceType)
		default:
			continue
		}
		if trustedACESID(a.sid, extra) {
			continue
		}
		if a.mask&dangerous != 0 {
			return fmt.Errorf("%s lets %s modify it (rights %#x)", path, a.sid, a.mask&dangerous)
		}
	}
	return nil
}

// unitSafe reports whether p can be written into a systemd unit as is.
// kardianos' cmdEscape only escapes spaces, so p must be absolute, valid
// UTF-8, without control characters and without the characters systemd
// treats specially in ExecStart= and ConditionFileIsExecutable= (specifiers
// %, variables $, escapes \, quotes and ;).
func unitSafe(p string) bool {
	if !strings.HasPrefix(p, "/") || !utf8.ValidString(p) {
		return false
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f || strings.ContainsRune("%$\\\"';`", r) {
			return false
		}
	}
	return true
}
