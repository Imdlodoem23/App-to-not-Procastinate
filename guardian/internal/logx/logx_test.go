package logx

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func TestRotatingFileRotatesBySize(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, FileName)
	rf, err := OpenRotatingFile(p, 100, 3)
	if err != nil {
		t.Fatal(err)
	}
	// 10-byte lines: 10 fit per file. 55 lines -> current + 3 backups full
	// would need 40; the oldest ones are dropped.
	for i := range 55 {
		if _, err := fmt.Fprintf(rf, "line %04d\n", i); err != nil {
			t.Fatal(err)
		}
	}
	if err := rf.Close(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{p, p + ".1", p + ".2", p + ".3"} {
		if !exists(name) {
			t.Fatalf("%s missing", name)
		}
		fi, _ := os.Stat(name)
		if fi.Size() > 100 {
			t.Fatalf("%s is %d bytes, want <= 100", name, fi.Size())
		}
	}
	if exists(p + ".4") {
		t.Fatal("more backups than maxBackups")
	}
	cur := readFile(t, p)
	if !strings.HasPrefix(cur, "line 0050\n") || !strings.HasSuffix(cur, "line 0054\n") {
		t.Fatalf("current file = %q", cur)
	}
	if b1 := readFile(t, p+".1"); !strings.HasPrefix(b1, "line 0040\n") {
		t.Fatalf("backup 1 = %q", b1)
	}
	if b3 := readFile(t, p+".3"); !strings.HasPrefix(b3, "line 0020\n") {
		t.Fatalf("backup 3 = %q", b3)
	}
}

func TestRotatingFileAppendsToExisting(t *testing.T) {
	p := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(p, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rf, err := OpenRotatingFile(p, 1000, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rf.Write([]byte("new\n")); err != nil {
		t.Fatal(err)
	}
	_ = rf.Close()
	if got := readFile(t, p); got != "old\nnew\n" {
		t.Fatalf("got %q", got)
	}
	if exists(p + ".1") {
		t.Fatal("unexpected rotation")
	}
}

func TestRotatingFileOversizedExistingRotatesOnFirstWrite(t *testing.T) {
	p := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(p, bytes.Repeat([]byte("x"), 50), 0o644); err != nil {
		t.Fatal(err)
	}
	rf, err := OpenRotatingFile(p, 40, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rf.Write([]byte("fresh\n")); err != nil {
		t.Fatal(err)
	}
	_ = rf.Close()
	if got := readFile(t, p); got != "fresh\n" {
		t.Fatalf("current = %q", got)
	}
	if got := readFile(t, p+".1"); len(got) != 50 {
		t.Fatalf("backup has %d bytes", len(got))
	}
}

func TestRotatingFileWriteLargerThanMaxIsKeptWhole(t *testing.T) {
	p := filepath.Join(t.TempDir(), FileName)
	rf, err := OpenRotatingFile(p, 10, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rf.Write([]byte("a\n")); err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("b", 25) + "\n"
	if _, err := rf.Write([]byte(big)); err != nil {
		t.Fatal(err)
	}
	if _, err := rf.Write([]byte("c\n")); err != nil {
		t.Fatal(err)
	}
	_ = rf.Close()
	if got := readFile(t, p+".2"); got != "a\n" {
		t.Fatalf("backup 2 = %q", got)
	}
	if got := readFile(t, p+".1"); got != big {
		t.Fatalf("backup 1 = %q", got)
	}
	if got := readFile(t, p); got != "c\n" {
		t.Fatalf("current = %q", got)
	}
}

func TestRotatingFileZeroBackupsTruncates(t *testing.T) {
	p := filepath.Join(t.TempDir(), FileName)
	rf, err := OpenRotatingFile(p, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range []string{"12345\n", "67890\n", "abc\n"} {
		if _, err := rf.Write([]byte(s)); err != nil {
			t.Fatal(err)
		}
	}
	_ = rf.Close()
	if got := readFile(t, p); got != "67890\nabc\n" {
		t.Fatalf("got %q", got)
	}
	if exists(p + ".1") {
		t.Fatal("no backups expected")
	}
}

func TestRotatingFileWriteAfterClose(t *testing.T) {
	rf, err := OpenRotatingFile(filepath.Join(t.TempDir(), FileName), 10, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := rf.Close(); err != nil {
		t.Fatal(err)
	}
	if err := rf.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
	if _, err := rf.Write([]byte("x")); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("Write after Close = %v, want os.ErrClosed", err)
	}
}

func TestRotatingFileRejectsBadLimits(t *testing.T) {
	p := filepath.Join(t.TempDir(), FileName)
	if _, err := OpenRotatingFile(p, 0, 1); err == nil {
		t.Fatal("want error for maxSize 0")
	}
	if _, err := OpenRotatingFile(p, 10, -1); err == nil {
		t.Fatal("want error for negative backups")
	}
}

func TestRotatingFileConcurrentWrites(t *testing.T) {
	p := filepath.Join(t.TempDir(), FileName)
	rf, err := OpenRotatingFile(p, 2048, 3)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range 200 {
				if _, err := fmt.Fprintf(rf, "g%d-%03d\n", g, i); err != nil {
					t.Error(err)
					return
				}
			}
		}()
	}
	wg.Wait()
	_ = rf.Close()
	for _, name := range []string{p, p + ".1", p + ".2", p + ".3"} {
		fi, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Size() > 2048 {
			t.Fatalf("%s is %d bytes", name, fi.Size())
		}
		for _, line := range strings.Split(strings.TrimSuffix(readFile(t, name), "\n"), "\n") {
			if len(line) != len("g0-000") {
				t.Fatalf("torn line %q in %s", line, name)
			}
		}
	}
}

func TestNewWritesFileAndConsole(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "logs")
	var console bytes.Buffer
	l, err := New(Options{Dir: dir, Console: &console})
	if err != nil {
		t.Fatal(err)
	}
	l.Info("heartbeat", "uptime", "1m0s")
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	if l.Path() != filepath.Join(dir, FileName) {
		t.Fatalf("Path() = %q", l.Path())
	}
	file := readFile(t, l.Path())
	for _, out := range []string{file, console.String()} {
		if !strings.Contains(out, "msg=heartbeat") || !strings.Contains(out, "uptime=1m0s") {
			t.Fatalf("missing record in %q", out)
		}
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(l.Path())
		if perm := fi.Mode().Perm(); perm&0o600 != 0o600 || perm&0o022 != 0 {
			t.Fatalf("log file mode = %v", perm)
		}
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, errors.New("no console") }

func TestConsoleFailureDoesNotLoseFileLogs(t *testing.T) {
	l, err := New(Options{Dir: t.TempDir(), Console: failingWriter{}})
	if err != nil {
		t.Fatal(err)
	}
	l.Info("started")
	_ = l.Close()
	if !strings.Contains(readFile(t, l.Path()), "msg=started") {
		t.Fatal("file log lost when console fails")
	}
}

func TestNewRespectsLimits(t *testing.T) {
	dir := t.TempDir()
	l, err := New(Options{Dir: dir, MaxSize: 200, MaxBackups: 2})
	if err != nil {
		t.Fatal(err)
	}
	for i := range 50 {
		l.Info("tick", "n", i)
	}
	_ = l.Close()
	if !exists(filepath.Join(dir, FileName+".2")) || exists(filepath.Join(dir, FileName+".3")) {
		t.Fatal("rotation limits not applied")
	}
}

func TestRedactsSensitiveKeys(t *testing.T) {
	var buf bytes.Buffer
	l := NewConsole(&buf)
	l.Info("paired", "token", "s3cr3t", "Domain", "example.com", "count", 3)
	out := buf.String()
	if strings.Contains(out, "s3cr3t") || strings.Contains(out, "example.com") {
		t.Fatalf("sensitive data leaked: %q", out)
	}
	if !strings.Contains(out, "token="+redacted) || !strings.Contains(out, "count=3") {
		t.Fatalf("unexpected output %q", out)
	}
}

func TestRotatingFileRefusesPlantedLinks(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(dir, "victim")
	if err := os.WriteFile(victim, []byte("precious\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, FileName)
	if runtime.GOOS == "windows" {
		// Symlinks need a privilege; a hard link does not.
		if err := os.Link(victim, p); err != nil {
			t.Skipf("hard links not supported: %v", err)
		}
	} else if err := os.Symlink(victim, p); err != nil {
		t.Fatal(err)
	}
	if rf, err := OpenRotatingFile(p, 100, 1); err == nil {
		_ = rf.Close()
		t.Fatal("a planted link must be refused")
	}
	if got := readFile(t, victim); got != "precious\n" {
		t.Fatalf("victim changed: %q", got)
	}
}
