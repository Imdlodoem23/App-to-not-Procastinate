package platform

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// fakeTree is an in-memory treeOps. Paths use filepath.Join.
type fakeTree struct {
	nodes    map[string]*fakeNode
	secured  map[string][2]bool // path -> {root, private}
	removed  []string
	listed   []string
	onList   func(dir string) // hook run before listing (races)
	secureOK func(path string) error
}

type fakeNode struct {
	e        treeEntry
	children []string
}

func newFakeTree(root string) *fakeTree {
	f := &fakeTree{nodes: map[string]*fakeNode{}, secured: map[string][2]bool{}}
	f.add(root, treeEntry{kind: entryDir, trusted: true, links: 1, perm: 0o755})
	return f
}

func (f *fakeTree) add(path string, e treeEntry) {
	if e.links == 0 {
		e.links = 1
	}
	f.nodes[path] = &fakeNode{e: e}
	if parent, ok := f.nodes[filepath.Dir(path)]; ok && filepath.Dir(path) != path {
		parent.children = append(parent.children, filepath.Base(path))
	}
}

func (f *fakeTree) inspect(path string) (treeEntry, error) {
	n, ok := f.nodes[path]
	if !ok {
		return treeEntry{}, fs.ErrNotExist
	}
	if n.e.kind == entryOther && n.e.perm == 0o001 { // marker: cannot be inspected
		return treeEntry{}, errors.New("access denied")
	}
	return n.e, nil
}

func (f *fakeTree) list(dir string) ([]string, error) {
	if f.onList != nil {
		f.onList(dir)
	}
	f.listed = append(f.listed, dir)
	n, ok := f.nodes[dir]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return slices.Clone(n.children), nil
}

func (f *fakeTree) remove(path string) error {
	f.removed = append(f.removed, path)
	delete(f.nodes, path)
	return nil
}

func (f *fakeTree) secure(path string, e treeEntry, root, private bool) error {
	if f.secureOK != nil {
		if err := f.secureOK(path); err != nil {
			return err
		}
	}
	f.secured[path] = [2]bool{root, private}
	return nil
}

func j(parts ...string) string { return filepath.Join(parts...) }

func TestTakeOverTrustedTree(t *testing.T) {
	root := j(string(filepath.Separator), "sys", "Centrate")
	f := newFakeTree(root)
	f.add(j(root, "state.json"), treeEntry{kind: entryFile, trusted: true, perm: 0o666})
	f.add(j(root, "secret"), treeEntry{kind: entryDir, trusted: true, private: true, perm: 0o700})
	f.add(j(root, "secret", "ledger.key"), treeEntry{kind: entryFile, trusted: true, perm: 0o644})
	f.add(j(root, "events"), treeEntry{kind: entryDir, trusted: true, perm: 0o777})
	f.add(j(root, "events", "seg.jsonl"), treeEntry{kind: entryFile, trusted: true})
	f.add(j(root, "events", "link"), treeEntry{kind: entryLink, trusted: true})
	f.add(j(root, "hardlinked"), treeEntry{kind: entryFile, trusted: true, links: 2})
	f.add(j(root, "fifo"), treeEntry{kind: entryOther, trusted: true})
	f.add(j(root, "run.untrusted-1700000000"), treeEntry{kind: entryDir, trusted: false})
	f.add(j(root, "run.untrusted-1700000000", "planted"), treeEntry{kind: entryFile, trusted: false})

	var rep TakeoverReport
	problem, err := takeOver(f, root, false, &rep)
	if err != nil || problem != "" {
		t.Fatalf("takeOver = %q, %v", problem, err)
	}
	wantSecured := map[string][2]bool{
		root:                            {true, false},
		j(root, "state.json"):           {false, false},
		j(root, "secret"):               {false, true},
		j(root, "secret", "ledger.key"): {false, true},
		j(root, "events"):               {false, false},
		j(root, "events", "seg.jsonl"):  {false, false},
	}
	if len(f.secured) != len(wantSecured) {
		t.Fatalf("secured = %v", f.secured)
	}
	for p, w := range wantSecured {
		if got, ok := f.secured[p]; !ok || got != w {
			t.Errorf("%s secured = %v (%v), want %v", p, got, ok, w)
		}
	}
	slices.Sort(f.removed)
	wantRemoved := []string{j(root, "events", "link"), j(root, "fifo"), j(root, "hardlinked")}
	if !slices.Equal(f.removed, wantRemoved) {
		t.Fatalf("removed = %v, want %v", f.removed, wantRemoved)
	}
	slices.Sort(rep.Removed)
	if !slices.Equal(rep.Removed, wantRemoved) || len(rep.MovedAside) != 0 {
		t.Fatalf("report = %+v", rep)
	}
	for _, d := range f.listed {
		if strings.Contains(d, asideMarker) {
			t.Fatalf("an aside tree was entered: %s", d)
		}
	}
}

func TestTakeOverPrivateRootMakesEverythingPrivate(t *testing.T) {
	root := j(string(filepath.Separator), "sys", "secret")
	f := newFakeTree(root)
	f.add(j(root, "sub"), treeEntry{kind: entryDir, trusted: true, perm: 0o755})
	f.add(j(root, "sub", "k"), treeEntry{kind: entryFile, trusted: true, perm: 0o644})
	if problem, err := takeOver(f, root, true, &TakeoverReport{}); err != nil || problem != "" {
		t.Fatalf("takeOver = %q, %v", problem, err)
	}
	for p, got := range f.secured {
		if !got[1] {
			t.Errorf("%s not private", p)
		}
	}
}

func TestTakeOverUntrustedTrees(t *testing.T) {
	root := j(string(filepath.Separator), "sys", "Centrate")
	cases := map[string]func(f *fakeTree){
		"foreign root": func(f *fakeTree) { f.nodes[root].e.trusted = false },
		"root is a link": func(f *fakeTree) {
			f.nodes[root].e.kind = entryLink
		},
		"root is a file": func(f *fakeTree) { f.nodes[root].e.kind = entryFile },
		"deep foreign file": func(f *fakeTree) {
			f.add(j(root, "a"), treeEntry{kind: entryDir, trusted: true})
			f.add(j(root, "a", "b"), treeEntry{kind: entryDir, trusted: true})
			f.add(j(root, "a", "b", "ledger.key"), treeEntry{kind: entryFile, trusted: false})
		},
		"foreign link": func(f *fakeTree) {
			f.add(j(root, "backups"), treeEntry{kind: entryLink, trusted: false})
		},
		"uninspectable entry": func(f *fakeTree) {
			f.add(j(root, "x"), treeEntry{kind: entryOther, trusted: true, perm: 0o001})
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFakeTree(root)
			f.add(j(root, "state.json"), treeEntry{kind: entryFile, trusted: true})
			setup(f)
			problem, err := takeOver(f, root, false, &TakeoverReport{})
			if err != nil || problem == "" {
				t.Fatalf("takeOver = %q, %v; want a problem", problem, err)
			}
			if len(f.secured) != 0 || len(f.removed) != 0 {
				t.Fatalf("an untrusted tree was changed: secured %v, removed %v", f.secured, f.removed)
			}
		})
	}
}

func TestTakeOverRaces(t *testing.T) {
	root := j(string(filepath.Separator), "sys", "Centrate")
	// A foreign entry appears after the scan: the fix pass condemns the tree.
	f := newFakeTree(root)
	f.add(j(root, "logs"), treeEntry{kind: entryDir, trusted: true})
	lists := 0
	f.onList = func(dir string) {
		if dir == j(root, "logs") {
			lists++
			if lists == 2 {
				f.add(j(root, "logs", "planted"), treeEntry{kind: entryFile, trusted: false})
			}
		}
	}
	if problem, err := takeOver(f, root, false, &TakeoverReport{}); err != nil || !strings.Contains(problem, "planted") {
		t.Fatalf("takeOver = %q, %v", problem, err)
	}

	// Entries vanishing mid-walk (a temporary file renamed by the running
	// guardian) are skipped.
	f = newFakeTree(root)
	f.add(j(root, "gone.tmp"), treeEntry{kind: entryFile, trusted: true})
	f.add(j(root, "gonedir"), treeEntry{kind: entryDir, trusted: true})
	f.add(j(root, "kept"), treeEntry{kind: entryFile, trusted: true})
	f.onList = func(dir string) {
		if dir == root && len(f.listed) == 1 { // second listing of root (fix pass)
			delete(f.nodes, j(root, "gone.tmp"))
		}
	}
	f.secureOK = func(p string) error {
		if p == j(root, "gonedir") {
			delete(f.nodes, p)
			return fs.ErrNotExist
		}
		return nil
	}
	if problem, err := takeOver(f, root, false, &TakeoverReport{}); err != nil || problem != "" {
		t.Fatalf("takeOver = %q, %v", problem, err)
	}
	if _, ok := f.secured[j(root, "kept")]; !ok {
		t.Fatal("kept not secured")
	}

	// A child that cannot be secured condemns the tree; the root failing is
	// an error.
	f = newFakeTree(root)
	f.add(j(root, "stuck"), treeEntry{kind: entryFile, trusted: true})
	f.secureOK = func(p string) error {
		if p == j(root, "stuck") {
			return errors.New("denied")
		}
		return nil
	}
	if problem, err := takeOver(f, root, false, &TakeoverReport{}); err != nil || !strings.Contains(problem, "stuck") {
		t.Fatalf("takeOver = %q, %v", problem, err)
	}
	f = newFakeTree(root)
	f.secureOK = func(string) error { return errors.New("denied") }
	if _, err := takeOver(f, root, false, &TakeoverReport{}); err == nil {
		t.Fatal("a root that cannot be secured is an error")
	}
	if _, err := takeOver(newFakeTree(root), j(root, "missing"), false, &TakeoverReport{}); err == nil {
		t.Fatal("a missing root is an error")
	}
}

// secureLoop moves an untrusted directory aside (renaming only the top
// entry) and tries again; it gives up after secureAttempts.
func TestSecureLoopMovesAside(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Centrate")
	create := func() error { return os.MkdirAll(dir, 0o755) }
	f := newFakeTree(dir)
	untrustedOnce := true
	ops := &loopOps{fakeTree: f, root: dir, before: func() {
		f.nodes[dir].e.trusted = !untrustedOnce
		untrustedOnce = false
	}}
	var rep TakeoverReport
	if err := secureLoop(ops, dir, false, create, &rep); err != nil {
		t.Fatal(err)
	}
	if aside := asideOf(t, dir); len(aside) != 1 || !slices.Equal(rep.MovedAside, aside) {
		t.Fatalf("aside = %v, report %+v", aside, rep)
	}
	ops.before = func() { f.nodes[dir].e.trusted = false }
	if err := secureLoop(ops, dir, false, create, &TakeoverReport{}); err == nil || !strings.Contains(err.Error(), "cannot trust") {
		t.Fatalf("err = %v", err)
	}
	if aside := asideOf(t, dir); len(aside) != 1+secureAttempts-1 {
		t.Fatalf("aside = %v", aside)
	}
	if err := secureLoop(ops, dir, false, func() error { return errors.New("mkdir failed") }, &TakeoverReport{}); err == nil {
		t.Fatal("a failed create is an error")
	}
}

// loopOps runs before() on every inspect of root.
type loopOps struct {
	*fakeTree
	root   string
	before func()
}

func (l *loopOps) inspect(path string) (treeEntry, error) {
	if path == l.root {
		l.before()
	}
	return l.fakeTree.inspect(path)
}

// asideOf lists the "<dir>.untrusted-*" siblings of dir.
func asideOf(t *testing.T, dir string) []string {
	t.Helper()
	ents, err := os.ReadDir(filepath.Dir(dir))
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), filepath.Base(dir)+asideMarker) {
			out = append(out, filepath.Join(filepath.Dir(dir), e.Name()))
		}
	}
	return out
}

func TestEnsureDirReportWithoutElevation(t *testing.T) {
	forceElevated(t, false)
	dir := filepath.Join(t.TempDir(), "Centrate", "secret")
	rep, err := EnsureDirReport(dir, true)
	if err != nil || len(rep.Removed) != 0 || len(rep.MovedAside) != 0 {
		t.Fatalf("EnsureDirReport = %+v, %v", rep, err)
	}
	if _, err := EnsureDirReport("relative", false); err == nil {
		t.Fatal("a relative path must fail")
	}
}
