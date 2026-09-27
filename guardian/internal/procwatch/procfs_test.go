package procwatch

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"
)

type fakeProcEntry struct {
	exe     string // "" means readlink fails
	exeErr  error  // error returned by readlink when exe is ""
	comm    string
	gone    bool // no files at all: vanished between readdir and read
	cmdline string
	stat    string // written verbatim instead of the generated stat
	state   byte   // 0 means 'S'
	ppid    int
	flags   uint64
	uid     uint32 // effective UID; 0 means 1000 unless root is set
	root    bool   // effective UID 0
	status  string // written verbatim instead of the generated status
}

// fakeProcFS builds a procfs tree under a temp dir. exe links are served by
// the returned readlink, because symlinks need privileges on Windows. Its
// UID_MIN is 1000.
func fakeProcFS(t *testing.T, entries map[int]fakeProcEntry, extraDirs ...string) procFS {
	t.Helper()
	root := t.TempDir()
	links := map[string]string{}
	errs := map[string]error{}
	for pid, e := range entries {
		dir := filepath.Join(root, strconv.Itoa(pid))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if e.gone {
			continue
		}
		stat, status := e.stat, e.status
		if stat == "" {
			state := e.state
			if state == 0 {
				state = 'S'
			}
			stat = fmt.Sprintf("%d (%s) %c %d %d %d 0 -1 %d 12 0 0 0 1 2 0 0 20 0 1 0 12345\n", pid, e.comm, state, e.ppid, pid, pid, e.flags)
		}
		if status == "" {
			uid := e.uid
			switch {
			case e.root:
				uid = 0
			case uid == 0:
				uid = 1000
			}
			// Real UID 4242 differs from the effective one on purpose.
			status = fmt.Sprintf("Name:\t%s\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t%d\nPid:\t%d\nPPid:\t%d\nUid:\t4242\t%d\t%d\t%d\nGid:\t100\t100\t100\t100\n", e.comm, pid, pid, e.ppid, uid, uid, uid)
		}
		writeFile(t, filepath.Join(dir, "stat"), stat)
		writeFile(t, filepath.Join(dir, "status"), status)
		if e.cmdline != "" {
			writeFile(t, filepath.Join(dir, "cmdline"), e.cmdline)
		}
		if e.exe != "" {
			links[filepath.Join(dir, "exe")] = e.exe
		} else if e.exeErr != nil {
			errs[filepath.Join(dir, "exe")] = e.exeErr
		}
	}
	for _, d := range extraDirs {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return procFS{
		root: root,
		readlink: func(path string) (string, error) {
			if l, ok := links[path]; ok {
				return l, nil
			}
			if err, ok := errs[path]; ok {
				return "", &fs.PathError{Op: "readlink", Path: path, Err: err}
			}
			return "", &fs.PathError{Op: "readlink", Path: path, Err: fs.ErrNotExist}
		},
		uidMin: func() int { return 1000 },
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestProcFSList(t *testing.T) {
	fsys := fakeProcFS(t, map[int]fakeProcEntry{
		// Normal process: exe link wins.
		100: {exe: "/usr/share/discord/Discord", comm: "Discord", ppid: 1, cmdline: "/usr/share/discord/Discord\x00--type=renderer\x00"},
		// Deleted binary (updated while running).
		101: {exe: "/home/ana/.local/share/Steam/ubuntu12_32/steam (deleted)", comm: "steam", ppid: 1},
		// Script run by an interpreter: exe is python, comm is the script.
		102: {exe: "/usr/bin/python3.12", comm: "lutris", ppid: 1, cmdline: "/usr/bin/python3\x00/usr/bin/lutris\x00"},
		// Script with a long name through its #! line: comm is cut, argv[1]
		// continues it.
		103: {exe: "/usr/bin/python3.12", comm: "minecraft-launc", ppid: 1, cmdline: "/usr/bin/python3\x00/usr/bin/minecraft-launcher\x00--debug\x00"},
		// Same with an interpreter flag: argv[2].
		104: {exe: "/usr/bin/python3.12", comm: "minecraft-launc", ppid: 1, cmdline: "/usr/bin/python3\x00-I\x00/usr/bin/minecraft-launcher\x00"},
		// Windows game under Wine: exe is the preloader, argv[0] a Windows
		// path.
		105: {exe: "/usr/bin/wine64-preloader", comm: "RobloxPlayerBet", ppid: 1, cmdline: `C:\users\ana\AppData\Local\Roblox\Versions\v1\RobloxPlayerBeta.exe` + "\x00"},
		// Cut comm, command line that does not continue it: nothing added.
		106: {exe: "/usr/lib/firefox/firefox", comm: "Isolated Web Co", ppid: 1, cmdline: "/usr/lib/firefox/firefox\x00-contentproc\x00"},
		// No exe (another user's process without root): comm cut at 15
		// bytes, continued by argv[0].
		200: {exeErr: fs.ErrPermission, comm: "telegram-deskto", ppid: 1, cmdline: "/usr/bin/telegram-desktop\x00--\x00"},
		// No exe, comm cut, argv[0] rewritten: keep comm.
		201: {exeErr: fs.ErrPermission, comm: "Isolated Web Co", ppid: 1, cmdline: "/usr/lib/firefox/firefox\x00-contentproc\x00"},
		// No exe, short comm: comm.
		202: {exeErr: fs.ErrPermission, comm: "Discord", ppid: 1, cmdline: "/opt/discord/Discord\x00"},
		// Kernel threads: no exe, empty cmdline, PF_KTHREAD.
		2:   {comm: "kthreadd", root: true, flags: 0x00208040},
		300: {comm: "kworker/0:1-events", root: true, ppid: 2, flags: 0x04208060},
		// Name with spaces and parentheses.
		301: {exe: "/opt/My Game/My Game", comm: "My (Game) ", ppid: 1},
		// Root and system accounts.
		400: {exe: "/usr/bin/python3.12", comm: "unattended-upgr", ppid: 1, root: true, cmdline: "/usr/bin/python3\x00/usr/share/unattended-upgrades/unattended-upgrade-shutdown\x00"},
		401: {exe: "/usr/sbin/dnsmasq", comm: "dnsmasq", ppid: 1, uid: 65534},
		402: {exe: "/usr/lib/systemd/systemd-timesyncd", comm: "systemd-timesyn", ppid: 1, uid: 998},
		403: {exe: "/usr/bin/node", comm: "node", ppid: 1, uid: 61200}, // systemd DynamicUser
		404: {exe: "/usr/bin/node", comm: "node", ppid: 1, uid: 1234567890},
		// Vanished between readdir and read, and a zombie.
		500: {gone: true},
		501: {comm: "Discord", ppid: 100, state: 'Z'},
	}, "self", "sys", "net", "0123", "1a")

	procs, err := fsys.list()
	if err != nil {
		t.Fatal(err)
	}
	got := map[int]Process{}
	for _, p := range procs {
		got[p.PID] = p
	}
	python := "/usr/bin/python3.12"
	want := map[int]Process{
		100: {PID: 100, PPID: 1, Name: "Discord", Path: "/usr/share/discord/Discord", Comm: "Discord"},
		101: {PID: 101, PPID: 1, Name: "steam", Path: "/home/ana/.local/share/Steam/ubuntu12_32/steam", Comm: "steam"},
		102: {PID: 102, PPID: 1, Name: "python3.12", Path: python, Comm: "lutris"},
		103: {PID: 103, PPID: 1, Name: "python3.12", Path: python, Comm: "minecraft-launc", CmdName: "minecraft-launcher"},
		104: {PID: 104, PPID: 1, Name: "python3.12", Path: python, Comm: "minecraft-launc", CmdName: "minecraft-launcher"},
		105: {PID: 105, PPID: 1, Name: "wine64-preloader", Path: "/usr/bin/wine64-preloader", Comm: "RobloxPlayerBet", CmdName: "RobloxPlayerBeta.exe"},
		106: {PID: 106, PPID: 1, Name: "firefox", Path: "/usr/lib/firefox/firefox", Comm: "Isolated Web Co"},
		200: {PID: 200, PPID: 1, Name: "telegram-desktop", Comm: "telegram-deskto"},
		201: {PID: 201, PPID: 1, Name: "Isolated Web Co", Comm: "Isolated Web Co"},
		202: {PID: 202, PPID: 1, Name: "Discord", Comm: "Discord"},
		2:   {PID: 2, Name: "kthreadd", Comm: "kthreadd", System: true},
		300: {PID: 300, PPID: 2, Name: "kworker/0:1-events", Comm: "kworker/0:1-events", System: true},
		301: {PID: 301, PPID: 1, Name: "My Game", Path: "/opt/My Game/My Game", Comm: "My (Game) "},
		400: {PID: 400, PPID: 1, Name: "python3.12", Path: python, Comm: "unattended-upgr", CmdName: "unattended-upgrade-shutdown", System: true},
		401: {PID: 401, PPID: 1, Name: "dnsmasq", Path: "/usr/sbin/dnsmasq", Comm: "dnsmasq", System: true},
		402: {PID: 402, PPID: 1, Name: "systemd-timesyncd", Path: "/usr/lib/systemd/systemd-timesyncd", Comm: "systemd-timesyn", System: true},
		403: {PID: 403, PPID: 1, Name: "node", Path: "/usr/bin/node", Comm: "node", System: true},
		404: {PID: 404, PPID: 1, Name: "node", Path: "/usr/bin/node", Comm: "node"},
	}
	if !reflect.DeepEqual(got, want) {
		for pid := range want {
			if !reflect.DeepEqual(got[pid], want[pid]) {
				t.Errorf("pid %d:\n got: %+v\nwant: %+v", pid, got[pid], want[pid])
			}
		}
		for pid := range got {
			if _, ok := want[pid]; !ok {
				t.Errorf("unexpected pid %d: %+v", pid, got[pid])
			}
		}
		t.FailNow()
	}

	m := NewMatcherFor("linux", []string{"Discord", "steam", "lutris", "telegram-desktop", "minecraft-launcher", "RobloxPlayerBeta.exe", "python3.12", "node", "dnsmasq", "unattended-upgr"})
	matched := map[int]string{}
	for _, p := range procs {
		if target, ok := m.Match(p); ok {
			matched[p.PID] = target
		}
	}
	// The interpreter target matches the user's scripts through Name, never
	// the root ones; system accounts and kernel threads never match.
	wantMatched := map[int]string{
		100: "Discord", 101: "steam", 102: "python3.12", 103: "python3.12", 104: "python3.12",
		105: "RobloxPlayerBeta.exe", 200: "telegram-desktop", 202: "Discord", 404: "node",
	}
	if !reflect.DeepEqual(matched, wantMatched) {
		t.Errorf("matched %v, want %v", matched, wantMatched)
	}
	// Without the interpreter as a target, the script names match.
	m = NewMatcherFor("linux", []string{"lutris", "minecraft-launcher"})
	for pid, want := range map[int]string{102: "lutris", 103: "minecraft-launcher", 104: "minecraft-launcher"} {
		if target, ok := m.Match(got[pid]); !ok || target != want {
			t.Errorf("Match(%+v) = %q, %v; want %q", got[pid], target, ok, want)
		}
	}
}

func TestProcFSMalformed(t *testing.T) {
	fsys := fakeProcFS(t, map[int]fakeProcEntry{
		10: {comm: "a", stat: "10 (a) S"},
		11: {comm: "b", status: "Name:\tb\n"},
		12: {comm: "c", status: "Uid:\t1000\n"},
		13: {comm: "d", status: "Uid:\t1000\tx\t1000\t1000\n"},
	})
	for _, pid := range []int{10, 11, 12, 13} {
		if _, err := fsys.read(pid); err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("read(%d) = %v, want a malformed-file error", pid, err)
		}
	}
	if procs, err := fsys.list(); err != nil || len(procs) != 0 {
		t.Errorf("list() = %+v, %v; want malformed processes skipped", procs, err)
	}
}

func TestParseStat(t *testing.T) {
	tests := []struct {
		in   string
		want statFields
		ok   bool
	}{
		{"1 (systemd) S 0 1 1 0 -1 4194560 1 2", statFields{comm: "systemd", state: 'S', ppid: 0, flags: 4194560}, true},
		{"42 (a) b) c) R 7 42 42 0 -1 2097216 0", statFields{comm: "a) b) c", state: 'R', ppid: 7, flags: 2097216}, true},
		{"42 (x) S 1 1 1 0 -1", statFields{}, false},       // no flags
		{"42 (x) S -1 1 1 0 -1 0", statFields{}, false},    // negative ppid
		{"42 (x) SS 1 1 1 0 -1 0", statFields{}, false},    // bad state
		{"42 (x) S 1 1 1 0 -1 flags", statFields{}, false}, // bad flags
		{"42 x) S 1 1 1 0 -1 0", statFields{}, false},      // no '('
		{"", statFields{}, false},
	}
	for _, tc := range tests {
		got, ok := parseStat([]byte(tc.in))
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseStat(%q) = %+v, %v; want %+v, %v", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

func TestLinuxHumanUID(t *testing.T) {
	tests := []struct {
		uid    uint32
		uidMin int
		want   bool
	}{
		{0, 1000, false},
		{0, 0, false},
		{1, 1000, false},
		{999, 1000, false},
		{1000, 1000, true},
		{1001, 1000, true},
		{500, 500, true},
		{499, 500, false},
		{60000, 1000, true},
		{60513, 1000, true}, // systemd-homed users are people
		{61184, 1000, false},
		{65519, 1000, false},
		{65520, 1000, true},
		{65534, 1000, false},
		{65535, 1000, false},
		{100000, 1000, true},
		{1234567890, 1000, true}, // directory (SSSD, AD) users
		{4294967295, 1000, false},
	}
	for _, tc := range tests {
		if got := linuxHumanUID(tc.uid, tc.uidMin); got != tc.want {
			t.Errorf("linuxHumanUID(%d, %d) = %v, want %v", tc.uid, tc.uidMin, got, tc.want)
		}
	}
}

func TestReadUIDMin(t *testing.T) {
	dir := t.TempDir()
	tests := map[string]int{
		"# UID_MIN 5\nUID_MIN\t\t\t 2000\nUID_MAX 60000\n": 2000,
		"UID_MAX 60000\n": defaultUIDMin,
		"UID_MIN 1\n":     defaultUIDMin,
		"UID_MIN lots\n":  defaultUIDMin,
		"UID_MIN 500\n":   500,
		"":                defaultUIDMin,
	}
	i := 0
	for content, want := range tests {
		path := filepath.Join(dir, strconv.Itoa(i))
		i++
		writeFile(t, path, content)
		if got := readUIDMin(path); got != want {
			t.Errorf("readUIDMin(%q) = %d, want %d", content, got, want)
		}
	}
	if got := readUIDMin(filepath.Join(dir, "missing")); got != defaultUIDMin {
		t.Errorf("readUIDMin(missing) = %d", got)
	}
}

func TestProcFSReadMissing(t *testing.T) {
	fsys := fakeProcFS(t, map[int]fakeProcEntry{400: {gone: true}, 402: {comm: "z", state: 'Z'}})
	for _, pid := range []int{400, 401, 402} {
		if _, err := fsys.read(pid); !errors.Is(err, ErrNotFound) {
			t.Errorf("read(%d) error = %v, want ErrNotFound", pid, err)
		}
	}
}

func TestProcFSListMissingRoot(t *testing.T) {
	fsys := procFS{root: filepath.Join(t.TempDir(), "nope"), readlink: os.Readlink}
	if _, err := fsys.list(); err == nil {
		t.Fatal("list of a missing root succeeded")
	}
}

func TestProcFSExited(t *testing.T) {
	fsys := fakeProcFS(t, map[int]fakeProcEntry{
		10: {comm: "a", stat: "10 (a) S 1 10 10 0 -1"},
		11: {comm: "b", stat: "11 (b) Z 1 11 11 0 -1"},
		12: {comm: "c", stat: "12 (weird) name) R 1"},
		13: {comm: "d", stat: "13 (d) X 1"},
		14: {comm: "e", stat: "garbage"},
	})
	tests := map[int]bool{10: false, 11: true, 12: false, 13: true, 14: false, 99: true}
	for pid, want := range tests {
		if got := fsys.exited(pid); got != want {
			t.Errorf("exited(%d) = %v, want %v", pid, got, want)
		}
	}
}

func TestStatState(t *testing.T) {
	tests := []struct {
		in    string
		state byte
		ok    bool
	}{
		{"1 (systemd) S 0 1", 'S', true},
		{"42 (a (b) c) Z 1", 'Z', true},
		{"42 (x)", 0, false},
		{"42 (x)Z", 0, false},
		{"", 0, false},
	}
	for _, tc := range tests {
		s, ok := statState([]byte(tc.in))
		if s != tc.state || ok != tc.ok {
			t.Errorf("statState(%q) = %q, %v; want %q, %v", tc.in, s, ok, tc.state, tc.ok)
		}
	}
}

func TestParsePID(t *testing.T) {
	tests := map[string]int{"1": 1, "4194304": 4194304, "self": 0, "": 0, "0": 0, "01": 0, "+1": 0, "-1": 0, "1a": 0, "99999999999": 0}
	for in, want := range tests {
		got, ok := parsePID(in)
		if ok != (want != 0) || (ok && got != want) {
			t.Errorf("parsePID(%q) = %d, %v; want %d", in, got, ok, want)
		}
	}
}
