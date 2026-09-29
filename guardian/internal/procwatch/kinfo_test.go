package procwatch

import (
	"encoding/binary"
	"testing"
)

func TestDarwinProcess(t *testing.T) {
	const discord = "/Applications/Discord.app/Contents/MacOS/Discord"
	tests := []struct {
		name     string
		uid      uint32
		comm     string
		execPath string
		want     Process
	}{
		{
			name: "app launched by Finder", uid: 501, comm: "Discord", execPath: discord,
			want: Process{Name: "Discord", Path: discord, Bundle: "Discord"},
		},
		{
			// exec -a Notes …/Discord: argv[0] is not read at all.
			name: "decoy argv[0]", uid: 501, comm: "Discord", execPath: discord,
			want: Process{Name: "Discord", Path: discord, Bundle: "Discord"},
		},
		{
			name: "launched through a symlink with another name", uid: 501, comm: "Discord", execPath: "/Users/u/Notes",
			want: Process{Name: "Discord"},
		},
		{
			name: "relative exec path", uid: 501, comm: "Discord", execPath: "./Discord",
			want: Process{Name: "Discord"},
		},
		{
			name: "exec path with dot-dot", uid: 501, comm: "Discord",
			execPath: "/Applications/Céntrate.app/Contents/MacOS/../../../../Users/u/Discord",
			want:     Process{Name: "Discord"},
		},
		{
			name: "p_comm cut at 16 bytes", uid: 501, comm: "Minecraft Launch",
			execPath: "/Applications/Minecraft Launcher.app/Contents/MacOS/Minecraft Launcher",
			want: Process{
				Name: "Minecraft Launcher", Path: "/Applications/Minecraft Launcher.app/Contents/MacOS/Minecraft Launcher",
				Bundle: "Minecraft Launcher",
			},
		},
		{
			name: "cut p_comm without exec path", uid: 501, comm: "Minecraft Launch",
			want: Process{Name: "Minecraft Launch"},
		},
		{
			name: "short p_comm must equal the file name", uid: 501, comm: "Disc", execPath: discord,
			want: Process{Name: "Disc"},
		},
		{
			name: "renamed bundle", uid: 501, comm: "Discord", execPath: "/Users/u/Applications/CentrateX.app/Contents/MacOS/Discord",
			want: Process{Name: "Discord", Path: "/Users/u/Applications/CentrateX.app/Contents/MacOS/Discord", Bundle: "CentrateX"},
		},
		{
			name: "helper bundle", uid: 501, comm: "Discord Helper (",
			execPath: "/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/Contents/MacOS/Discord Helper (Renderer)",
			want: Process{
				Name:   "Discord Helper (Renderer)",
				Path:   "/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/Contents/MacOS/Discord Helper (Renderer)",
				Bundle: "Discord Helper (Renderer)",
			},
		},
		{
			name: "command-line tool", uid: 501, comm: "steamcmd", execPath: "/opt/homebrew/bin/steamcmd",
			want: Process{Name: "steamcmd", Path: "/opt/homebrew/bin/steamcmd"},
		},
		{name: "root daemon", uid: 0, comm: "mDNSResponder", want: Process{Name: "mDNSResponder", System: true}},
		{name: "system account", uid: 65, comm: "mDNSResponder", want: Process{Name: "mDNSResponder", System: true}},
		{name: "nobody", uid: 4294967294, comm: "x", want: Process{Name: "x", System: true}},
		{name: "network account", uid: 1234567, comm: "Discord", want: Process{Name: "Discord"}},
		{name: "no p_comm", uid: 501, comm: "", execPath: discord, want: Process{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := darwinProcess(42, 1, tc.uid, tc.comm, tc.execPath)
			tc.want.PID, tc.want.PPID = 42, 1
			if got != tc.want {
				t.Errorf("darwinProcess(%q, %q) =\n %+v\nwant %+v", tc.comm, tc.execPath, got, tc.want)
			}
		})
	}
}

// TestDarwinMatching is the regression for the bypasses the ps-based lister
// allowed: a renamed bundle (even to a protected name) and a decoy argv[0]
// still match; a protected executable name still does not.
func TestDarwinMatching(t *testing.T) {
	m := NewMatcherFor("darwin", []string{"Discord", "Roblox", "Electron"})
	tests := []struct {
		comm, execPath, want string
	}{
		{"Discord", "/Applications/Discord.app/Contents/MacOS/Discord", "Discord"},
		{"Discord", "/Users/u/Applications/CentrateX.app/Contents/MacOS/Discord", "Discord"},
		{"Discord", "/Users/u/Applications/Céntrate.app/Contents/MacOS/Discord", "Discord"},
		{"Discord", "/Users/u/Applications/Activity Monitor.app/Contents/MacOS/Discord", "Discord"},
		{"Discord", "/Users/u/Applications/Finder.app/Contents/MacOS/Discord", "Discord"},
		{"Discord", "/Users/u/x", "Discord"},
		{"RobloxPlayer", "/Applications/Roblox.app/Contents/MacOS/RobloxPlayer", "Roblox"},
		{"Electron", "/Applications/Visual Studio Code.app/Contents/MacOS/Electron", "Electron"},
		{"Finder", "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", ""},
		{"Céntrate", "/Applications/Céntrate.app/Contents/MacOS/Céntrate", ""},
		{"Céntrate Helper", "/Applications/Céntrate.app/Contents/Frameworks/Céntrate Helper (GPU).app/Contents/MacOS/Céntrate Helper (GPU)", ""},
	}
	for _, tc := range tests {
		p := darwinProcess(4242, 1, 501, tc.comm, tc.execPath)
		got, ok := m.Match(p)
		if ok != (tc.want != "") || got != tc.want {
			t.Errorf("Match(%+v) = %q, %v; want %q", p, got, ok, tc.want)
		}
	}
	if _, ok := m.Match(darwinProcess(4242, 1, 0, "Discord", "/Applications/Discord.app/Contents/MacOS/Discord")); ok {
		t.Error("a root process matched")
	}
}

func TestExecPathFromProcargs2(t *testing.T) {
	buf := func(argc uint32, rest string) []byte {
		b := binary.LittleEndian.AppendUint32(nil, argc)
		return append(b, rest...)
	}
	tests := []struct {
		in   []byte
		want string
	}{
		{buf(2, "/Applications/Discord.app/Contents/MacOS/Discord\x00\x00\x00\x00Notes\x00--x\x00"), "/Applications/Discord.app/Contents/MacOS/Discord"},
		{buf(1, "/usr/bin/true\x00true\x00"), "/usr/bin/true"},
		{buf(1, "no terminator"), ""},
		{buf(1, "\x00x\x00"), ""},
		{[]byte{1, 0, 0}, ""},
		{[]byte{1, 0, 0, 0}, ""},
		{nil, ""},
	}
	for _, tc := range tests {
		if got := execPathFromProcargs2(tc.in); got != tc.want {
			t.Errorf("execPathFromProcargs2(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestBundleName(t *testing.T) {
	tests := []struct{ in, want string }{
		{"/Applications/Discord.app/Contents/MacOS/Discord", "Discord"},
		{"/Applications/A.app/Contents/Frameworks/B Helper.app/Contents/MacOS/B Helper", "B Helper"},
		{"/Applications/Discord.app/Contents/Resources/tool", ""},
		{"/usr/bin/true", ""},
		{".app/Contents/MacOS/x", ""},
	}
	for _, tc := range tests {
		if got := bundleName(tc.in); got != tc.want {
			t.Errorf("bundleName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestCommAgreesAndCString(t *testing.T) {
	if !commAgrees("Discord", "Discord") || commAgrees("Discord", "Discord2") || commAgrees("Disc", "Discord") {
		t.Error("short p_comm must equal the base name")
	}
	if !commAgrees("0123456789abcdef", "0123456789abcdefgh") || commAgrees("0123456789abcdef", "x123456789abcdefgh") {
		t.Error("a cut p_comm must prefix the base name")
	}
	var comm [17]byte
	copy(comm[:], "Discord")
	if got := cString(comm[:]); got != "Discord" {
		t.Errorf("cString = %q", got)
	}
	if got := cString([]byte("full")); got != "full" {
		t.Errorf("cString without NUL = %q", got)
	}
}
