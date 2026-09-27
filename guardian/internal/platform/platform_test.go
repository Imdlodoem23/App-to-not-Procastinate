package platform

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func forceElevated(t *testing.T, v bool) {
	t.Helper()
	prev := elevated
	elevated = func() bool { return v }
	t.Cleanup(func() { elevated = prev })
}

// forceProduction makes the process behave like a non-test binary for the
// override rules.
func forceProduction(t *testing.T) {
	t.Helper()
	if DevBuild {
		t.Skip("dev builds always honour the overrides")
	}
	prev := inTest
	inTest = func() bool { return false }
	t.Cleanup(func() { inTest = prev })
}

func TestDataDirEnvOverride(t *testing.T) {
	dir := t.TempDir()
	t.Setenv(EnvDataDir, dir)
	if got := DataDir(); got != dir {
		t.Fatalf("DataDir() = %q, want %q", got, dir)
	}
	if got, want := LogDir(), filepath.Join(dir, "logs"); got != want {
		t.Fatalf("LogDir() = %q, want %q", got, want)
	}
	if got, want := BackupDir(), filepath.Join(dir, "backups"); got != want {
		t.Fatalf("BackupDir() = %q, want %q", got, want)
	}
}

func TestRelativeOverrideIsIgnored(t *testing.T) {
	t.Setenv(EnvDataDir, filepath.Join("some", "rel"))
	t.Setenv(EnvHostsPath, ".")
	if got := DataDir(); got != defaultDataDir() {
		t.Fatalf("DataDir() = %q, want the default %q", got, defaultDataDir())
	}
	if got := HostsPath(); got != defaultHostsPath() {
		t.Fatalf("HostsPath() = %q, want the default %q", got, defaultHostsPath())
	}
}

func TestOverridesIgnoredWhenElevated(t *testing.T) {
	forceProduction(t)
	dir := filepath.Join(t.TempDir(), "Centrate")
	hosts := filepath.Join(t.TempDir(), "hosts")
	t.Setenv(EnvDataDir, dir)
	t.Setenv(EnvHostsPath, hosts)

	forceElevated(t, true)
	if got := DataDir(); got != defaultDataDir() {
		t.Fatalf("elevated DataDir() = %q, want the default", got)
	}
	if got := HostsPath(); got != defaultHostsPath() {
		t.Fatalf("elevated HostsPath() = %q, want the default", got)
	}

	forceElevated(t, false)
	if got := DataDir(); got != dir {
		t.Fatalf("non-elevated DataDir() = %q, want %q", got, dir)
	}
	if got := HostsPath(); got != hosts {
		t.Fatalf("non-elevated HostsPath() = %q, want %q", got, hosts)
	}
}

func TestHostsPathEnvOverride(t *testing.T) {
	p := filepath.Join(t.TempDir(), "hosts")
	t.Setenv(EnvHostsPath, "  "+p+"  ")
	if got := HostsPath(); got != p {
		t.Fatalf("HostsPath() = %q, want %q", got, p)
	}
	if got := DefaultHostsPath(); got == p || got != defaultHostsPath() {
		t.Fatalf("DefaultHostsPath() = %q must ignore the override", got)
	}
}

func TestDefaultsWithoutOverride(t *testing.T) {
	t.Setenv(EnvDataDir, "")
	t.Setenv(EnvHostsPath, "")
	data, hosts := DataDir(), HostsPath()
	switch runtime.GOOS {
	case "windows":
		if !strings.EqualFold(filepath.Base(data), "Centrate") || !filepath.IsAbs(data) {
			t.Errorf("DataDir() = %q", data)
		}
		if !strings.HasSuffix(strings.ToLower(hosts), `\system32\drivers\etc\hosts`) {
			t.Errorf("HostsPath() = %q", hosts)
		}
	case "darwin":
		if data != "/Library/Application Support/Centrate" {
			t.Errorf("DataDir() = %q", data)
		}
		if hosts != "/etc/hosts" {
			t.Errorf("HostsPath() = %q", hosts)
		}
	default:
		if data != "/var/lib/centrate" {
			t.Errorf("DataDir() = %q", data)
		}
		if hosts != "/etc/hosts" {
			t.Errorf("HostsPath() = %q", hosts)
		}
	}
	if !safeToRemove(data) {
		t.Errorf("the default data dir %q must be removable", data)
	}
}

func TestEnsureDataDirCreatesNestedDirAndMarker(t *testing.T) {
	forceElevated(t, false)
	dir := filepath.Join(t.TempDir(), "a", "b", "Centrate")
	t.Setenv(EnvDataDir, dir)
	if err := EnsureDataDir(); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !fi.IsDir() {
		t.Fatal("not a directory")
	}
	if runtime.GOOS != "windows" {
		perm := fi.Mode().Perm()
		if perm&0o700 != 0o700 || perm&0o022 != 0 {
			t.Fatalf("mode = %v, want owner rwx and no group/other write", perm)
		}
	}
	if !hasMarker(dir) {
		t.Fatal("EnsureDataDir must write the marker")
	}
	// Calling twice is fine.
	if err := EnsureDataDir(); err != nil {
		t.Fatal(err)
	}
}

func TestEnsurePrivateDir(t *testing.T) {
	forceElevated(t, false)
	dir := filepath.Join(t.TempDir(), "Centrate", "secret")
	if err := EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		t.Fatalf("stat: %v", err)
	}
	if runtime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0 {
		t.Fatalf("mode = %v, want no group/other access", fi.Mode().Perm())
	}
}

func TestEnsureDirRejectsFile(t *testing.T) {
	forceElevated(t, false)
	p := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDir(p); err == nil {
		t.Fatal("EnsureDir on a regular file must fail")
	}
}

func TestEnsureDirRejectsSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks needs a privilege on Windows")
	}
	forceElevated(t, false)
	base := t.TempDir()
	target := filepath.Join(base, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDir(link); err == nil {
		t.Fatal("EnsureDir on a symlink must fail")
	}
}

func TestEnsureDirRejectsEmptyAndRelativePaths(t *testing.T) {
	if err := EnsureDir(""); err == nil {
		t.Fatal("want error for empty path")
	}
	if err := EnsureDir(filepath.Join("rel", "Centrate")); err == nil {
		t.Fatal("want error for a relative path")
	}
}

func makeDataDir(t *testing.T) string {
	t.Helper()
	forceElevated(t, false)
	dir := filepath.Join(t.TempDir(), "Centrate")
	t.Setenv(EnvDataDir, dir)
	if err := EnsureDataDir(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "logs", "guardian.log"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRemoveDataDirIsIdempotent(t *testing.T) {
	dir := makeDataDir(t)
	if err := RemoveDataDir(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("data dir still exists: %v", err)
	}
	if err := RemoveDataDir(); err != nil {
		t.Fatalf("second RemoveDataDir: %v", err)
	}
}

func TestRemoveDataDirNeedsMarkerOutsideDefault(t *testing.T) {
	dir := makeDataDir(t)
	if err := os.Remove(filepath.Join(dir, DataDirMarker)); err != nil {
		t.Fatal(err)
	}
	if err := RemoveDataDir(); err == nil {
		t.Fatal("RemoveDataDir must refuse a directory without the marker")
	}
	if _, err := os.Stat(filepath.Join(dir, "logs", "guardian.log")); err != nil {
		t.Fatalf("contents touched: %v", err)
	}
}

func TestRemoveDataDirRefusesOtherNames(t *testing.T) {
	forceElevated(t, false)
	dir := t.TempDir() // not named Centrate
	if err := os.WriteFile(filepath.Join(dir, DataDirMarker), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvDataDir, dir)
	if err := RemoveDataDir(); err == nil {
		t.Fatal("RemoveDataDir must refuse a directory not named Centrate")
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatal(err)
	}
}

func TestRemoveDataDirRefusesAFile(t *testing.T) {
	forceElevated(t, false)
	p := filepath.Join(t.TempDir(), "centrate")
	if err := os.WriteFile(p, []byte("notes"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvDataDir, p)
	if err := RemoveDataDir(); err == nil {
		t.Fatal("RemoveDataDir must refuse a regular file")
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("file removed: %v", err)
	}
}

func TestRemoveDataDirOnlyRemovesALink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("creating symlinks needs a privilege on Windows")
	}
	forceElevated(t, false)
	base := t.TempDir()
	target := filepath.Join(base, "precious")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	keep := filepath.Join(target, "keep")
	if err := os.WriteFile(keep, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "Centrate")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvDataDir, link)
	if err := RemoveDataDir(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatalf("link still there: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("link target touched: %v", err)
	}
}

func TestRemoveDataDirStopsOnPermanentError(t *testing.T) {
	makeDataDir(t)
	boom := errors.New("boom")
	calls := 0
	prevRemove, prevSleep := removeAll, sleep
	t.Cleanup(func() { removeAll, sleep = prevRemove, prevSleep })
	removeAll = func(string) error { calls++; return boom }
	sleep = func(time.Duration) { t.Error("a permanent error must not be retried") }
	if err := RemoveDataDir(); !errors.Is(err, boom) {
		t.Fatalf("RemoveDataDir = %v, want boom", err)
	}
	if calls != 1 {
		t.Fatalf("removeAll called %d times", calls)
	}
}

func TestSafeToRemove(t *testing.T) {
	root := string(filepath.Separator)
	if runtime.GOOS == "windows" {
		root = `C:\`
	}
	cases := map[string]bool{
		"":                  false,
		"relative/centrate": false,
		root:                false,
		filepath.Join(root, "var", "lib", "centrate"):                     true,
		filepath.Join(root, "Library", "Application Support", "Centrate"): true,
		filepath.Join(root, "home", "me"):                                 false,
		filepath.Join(root, "etc"):                                        false,
		filepath.Join(root, "Users", "me", "repo"):                        false,
	}
	for in, want := range cases {
		if got := safeToRemove(in); got != want {
			t.Errorf("safeToRemove(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestIsElevatedDoesNotPanic(t *testing.T) {
	_ = IsElevated()
}

func TestOpenRegularFileAppends(t *testing.T) {
	p := filepath.Join(t.TempDir(), "guardian.log")
	if err := os.WriteFile(p, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := OpenRegularFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, FileMode)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write([]byte("new\n")); err != nil {
		t.Fatal(err)
	}
	fi, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if fi.Size() != 8 {
		t.Fatalf("size = %d", fi.Size())
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p); string(got) != "old\nnew\n" {
		t.Fatalf("content = %q", got)
	}
}

func TestOpenRegularFileCreatesAndTruncates(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state")
	f, err := OpenRegularFile(p, os.O_CREATE|os.O_WRONLY|os.O_EXCL, FileMode)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write([]byte("first"))
	_ = f.Close()
	if _, err := OpenRegularFile(p, os.O_CREATE|os.O_WRONLY|os.O_EXCL, FileMode); err == nil {
		t.Fatal("O_EXCL on an existing file must fail")
	}
	f, err = OpenRegularFile(p, os.O_WRONLY|os.O_TRUNC, FileMode)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write([]byte("2"))
	_ = f.Close()
	if got, _ := os.ReadFile(p); string(got) != "2" {
		t.Fatalf("content = %q", got)
	}
}

func TestOpenRegularFileRefusesHardLinks(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "someone-elses-file")
	if err := os.WriteFile(target, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "guardian.log")
	if err := os.Link(target, link); err != nil {
		t.Skipf("hard links not supported here: %v", err)
	}
	if f, err := OpenRegularFile(link, os.O_WRONLY|os.O_TRUNC, FileMode); err == nil {
		_ = f.Close()
		t.Fatal("a file with two hard links must be refused")
	}
	if got, _ := os.ReadFile(target); string(got) != "precious" {
		t.Fatalf("target changed: %q", got)
	}
}

func TestOpenRegularFileRefusesSymlinksAndDirs(t *testing.T) {
	dir := t.TempDir()
	if f, err := OpenRegularFile(dir, os.O_RDONLY, 0); err == nil {
		_ = f.Close()
		t.Fatal("a directory must be refused")
	}
	if runtime.GOOS == "windows" {
		return // symlinks need a privilege
	}
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "guardian.log")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if f, err := OpenRegularFile(link, os.O_CREATE|os.O_WRONLY|os.O_APPEND, FileMode); err == nil {
		_ = f.Close()
		t.Fatal("a symlink must be refused")
	}
	if got, _ := os.ReadFile(target); string(got) != "precious" {
		t.Fatalf("target changed: %q", got)
	}
}

func TestWriteSecretFile(t *testing.T) {
	forceElevated(t, false)
	dir := t.TempDir()
	p := filepath.Join(dir, "extensions.json")
	if err := WriteSecretFile(p, []byte("one")); err != nil {
		t.Fatal(err)
	}
	if err := WriteSecretFile(p, []byte("two")); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, []byte("two")) {
		t.Fatalf("content = %q", got)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(p)
		if fi.Mode().Perm() != SecretFileMode {
			t.Fatalf("mode = %v, want %v", fi.Mode().Perm(), SecretFileMode)
		}
	}
	if err := WriteSecretFile(filepath.Join(dir, "missing", "x"), nil); err == nil {
		t.Fatal("want an error when the directory does not exist")
	}
}
