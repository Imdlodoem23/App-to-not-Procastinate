//go:build unix

package svc

import (
	"io/fs"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// fakeInfo is a FileInfo with a chosen mode and owner.
type fakeInfo struct {
	name string
	mode fs.FileMode
	uid  uint32
}

func (f fakeInfo) Name() string       { return f.name }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeInfo) Sys() any           { return &syscall.Stat_t{Uid: f.uid} }

// fakeTree replaces lstat with a lookup in tree; missing paths do not exist.
func fakeTree(t *testing.T, tree map[string]fakeInfo) {
	t.Helper()
	prev := lstat
	lstat = func(p string) (fs.FileInfo, error) {
		if fi, ok := tree[p]; ok {
			fi.name = filepath.Base(p)
			return fi, nil
		}
		return nil, &fs.PathError{Op: "lstat", Path: p, Err: fs.ErrNotExist}
	}
	t.Cleanup(func() { lstat = prev })
}

func rootDir(mode fs.FileMode) fakeInfo  { return fakeInfo{mode: fs.ModeDir | mode} }
func rootFile(mode fs.FileMode) fakeInfo { return fakeInfo{mode: mode} }

// systemTree is a typical Linux layout: an app under /opt (root-only), an
// extracted AppImage in a home folder, and a /usr/local chowned to a user.
func systemTree() map[string]fakeInfo {
	return map[string]fakeInfo{
		"/":                       rootDir(0o755),
		"/opt":                    rootDir(0o755),
		"/opt/Céntrate":           rootDir(0o755),
		"/opt/Céntrate/g":         rootFile(0o755),
		"/opt/100%":               rootDir(0o755),
		"/opt/100%/g":             rootFile(0o755),
		"/home":                   rootDir(0o755),
		"/home/u":                 {mode: fs.ModeDir | 0o750, uid: 1000},
		"/home/u/squashfs-root":   {mode: fs.ModeDir | 0o755, uid: 1000},
		"/home/u/squashfs-root/g": {mode: 0o755, uid: 1000},
		"/home/u/rootfile":        rootFile(0o755),
		"/usr":                    rootDir(0o755),
		"/usr/local":              rootDir(fs.ModeSetgid | 0o775),
		"/usr/local/g":            rootFile(0o755),
		"/opt/link":               {mode: fs.ModeSymlink | 0o777},
		"/opt/writable":           rootFile(0o757),
	}
}

func TestCheckRootOnly(t *testing.T) {
	fakeTree(t, systemTree())
	cases := []struct {
		path, why string
	}{
		{"/opt/Céntrate/g", ""},
		{"/home/u/squashfs-root/g", "not root"},
		{"/home/u/rootfile", "not root"}, // root-owned file in a user folder
		{"/usr/local/g", "writable by group"},
		{"/opt/link", "symbolic link"},
		{"/opt/writable", "writable by group or others"},
		{"/opt/missing", "not exist"},
	}
	for _, tc := range cases {
		err := checkRootOnly(tc.path)
		switch {
		case tc.why == "" && err != nil:
			t.Errorf("checkRootOnly(%q) = %v, want nil", tc.path, err)
		case tc.why != "" && (err == nil || !strings.Contains(err.Error(), tc.why)):
			t.Errorf("checkRootOnly(%q) = %v, want an error about %q", tc.path, err, tc.why)
		}
	}
}
