package svc

import "testing"

const (
	sidUsers         = "S-1-5-32-545"
	sidAuthenticated = "S-1-5-11"
	sidSomeUser      = "S-1-5-21-1-2-3-1001"
	sidAppPackages   = "S-1-15-2-1"

	maskReadExecute = 0x1200a9
	maskModify      = 0x1301bf
	maskFull        = 0x1f01ff
)

func allow(sid string, mask uint32) aceInfo {
	return aceInfo{aceType: aceAccessAllowed, mask: mask, sid: sid}
}

// programFilesACL is the usual DACL of C:\Program Files and what installers
// create below it.
func programFilesACL(owner string) objectACL {
	return objectACL{owner: owner, aces: []aceInfo{
		allow(sidTrustedInstaller, maskFull),
		allow(sidSystem, maskModify),
		{aceType: aceAccessAllowed, flags: aceFlagInheritOnly | 0x3, mask: rightGenericAll, sid: sidSystem},
		allow(sidAdministrators, maskModify),
		allow(sidUsers, maskReadExecute),
		{aceType: aceAccessAllowed, flags: aceFlagInheritOnly | 0x3, mask: rightGenericAll, sid: sidCreatorOwner},
		allow(sidAppPackages, maskReadExecute),
	}}
}

func TestCheckACL(t *testing.T) {
	// The root of C:\: Authenticated Users may create folders there (this
	// folder only) and modify what they create (inherit-only entry).
	driveRoot := objectACL{owner: sidSystem, aces: []aceInfo{
		allow(sidAdministrators, maskFull),
		allow(sidSystem, maskFull),
		allow(sidUsers, maskReadExecute),
		allow(sidAuthenticated, rightAppendData),
		{aceType: aceAccessAllowed, flags: aceFlagInheritOnly | 0x3, mask: maskModify, sid: sidAuthenticated},
	}}
	cases := []struct {
		name   string
		acl    objectACL
		rights uint32
		ok     bool
	}{
		{"program files binary", programFilesACL(sidAdministrators), exeRights, true},
		{"program files folder", programFilesACL(sidTrustedInstaller), parentRights, true},
		{"drive root as an ancestor", driveRoot, ancestorRights, true},
		{"drive root holding the binary", driveRoot, parentRights, false},
		{"owned by a user", objectACL{owner: sidSomeUser, aces: []aceInfo{allow(sidAdministrators, maskFull)}}, exeRights, false},
		{"owned by Users", objectACL{owner: sidUsers}, ancestorRights, false},
		{"user profile folder", objectACL{owner: sidAdministrators, aces: []aceInfo{
			allow(sidSystem, maskFull), allow(sidAdministrators, maskFull), allow(sidSomeUser, maskFull),
		}}, parentRights, false},
		{"data drive: Authenticated Users modify", objectACL{owner: sidAdministrators, aces: []aceInfo{
			allow(sidAdministrators, maskFull), allow(sidAuthenticated, maskModify),
		}}, exeRights, false},
		{"users may append to the binary", objectACL{owner: sidAdministrators, aces: []aceInfo{
			allow(sidUsers, rightAppendData),
		}}, exeRights, false},
		{"users may delete entries of an ancestor", objectACL{owner: sidAdministrators, aces: []aceInfo{
			allow(sidUsers, maskReadExecute|rightDeleteChild),
		}}, ancestorRights, false},
		{"users may change the DACL", objectACL{owner: sidAdministrators, aces: []aceInfo{
			allow(sidUsers, maskReadExecute|rightWriteDAC),
		}}, ancestorRights, false},
		{"generic write", objectACL{owner: sidAdministrators, aces: []aceInfo{
			allow(sidUsers, rightGenericWrite),
		}}, exeRights, false},
		{"deny entries grant nothing", objectACL{owner: sidAdministrators, aces: []aceInfo{
			{aceType: 0x1, mask: maskFull, sid: sidUsers},
		}}, exeRights, true},
		{"callback entries count as allow", objectACL{owner: sidAdministrators, aces: []aceInfo{
			{aceType: aceAccessAllowedCallback, mask: maskModify, sid: sidUsers},
		}}, exeRights, false},
		{"object entries are refused", objectACL{owner: sidAdministrators, aces: []aceInfo{
			{aceType: aceAccessAllowedObject, mask: maskReadExecute},
		}}, exeRights, false},
		{"no DACL", objectACL{owner: sidAdministrators, nullDACL: true}, ancestorRights, false},
		{"owner rights placeholder", objectACL{owner: sidSystem, aces: []aceInfo{
			allow(sidOwnerRights, maskFull),
		}}, exeRights, true},
	}
	for _, tc := range cases {
		err := checkACL(`C:\x`, tc.acl, tc.rights, nil)
		if (err == nil) != tc.ok {
			t.Errorf("%s: checkACL = %v, want ok=%v", tc.name, err, tc.ok)
		}
	}
}

// With UAC off the installing account owns what the installer creates and
// gets the CREATOR OWNER entry; it is trusted only when passed as extra.
func TestCheckACLTrustsInstallerWhenUACIsOff(t *testing.T) {
	folder := objectACL{owner: sidSomeUser, aces: []aceInfo{
		allow(sidAdministrators, maskModify),
		allow(sidUsers, maskReadExecute),
		allow(sidSomeUser, maskFull),
	}}
	if err := checkACL(`C:\Program Files\Céntrate`, folder, parentRights, nil); err == nil {
		t.Fatal("an account's own folder must not be trusted by default")
	}
	if err := checkACL(`C:\Program Files\Céntrate`, folder, parentRights, []string{sidSomeUser}); err != nil {
		t.Fatalf("installer account passed as trusted: %v", err)
	}
	if err := checkACL(`C:\Program Files\Céntrate`, folder, parentRights, []string{"S-1-5-21-9-9-9-1002"}); err == nil {
		t.Fatal("another account must stay untrusted")
	}
}

func TestUnitSafe(t *testing.T) {
	cases := map[string]bool{
		"/opt/Céntrate/resources/guardian/centrate-guardian": true,
		"/usr/local/lib/centrate/centrate-guardian":          true,
		"/opt/My Apps/centrate-guardian":                     true,
		"relative/centrate-guardian":                         false,
		"/opt/100%/centrate-guardian":                        false,
		"/opt/$HOME/centrate-guardian":                       false,
		"/opt/a\\x20b/centrate-guardian":                     false,
		"/opt/a\"b/centrate-guardian":                        false,
		"/opt/a'b/centrate-guardian":                         false,
		"/opt/a;b/centrate-guardian":                         false,
		"/opt/a\nExecStartPre=/bin/sh":                       false,
		"/opt/a\tb":                                          false,
		"/opt/\xff/centrate-guardian":                        false,
	}
	for in, want := range cases {
		if got := unitSafe(in); got != want {
			t.Errorf("unitSafe(%q) = %v, want %v", in, got, want)
		}
	}
}
