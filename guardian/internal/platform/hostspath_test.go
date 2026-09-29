package platform

import (
	"path/filepath"
	"runtime"
	"testing"
)

func TestWindowsLocalDir(t *testing.T) {
	ok := map[string]string{
		`C:\Windows\System32\drivers\etc`:   `C:\Windows\System32\drivers\etc`,
		`c:\windows\system32\drivers\etc\\`: `c:\windows\system32\drivers\etc`,
		`D:/hosts dir/etc/`:                 `D:/hosts dir/etc`,
		`  E:\etc  `:                        `E:\etc`,
		`C:\`:                               `C:\`,
		`C:\my.dir\etc`:                     `C:\my.dir\etc`,
	}
	for in, want := range ok {
		if got, valid := windowsLocalDir(in); !valid || got != want {
			t.Errorf("windowsLocalDir(%q) = %q, %v; want %q", in, got, valid, want)
		}
	}
	bad := []string{
		"", `C:`, `C:etc`, `\Windows\etc`, `\\server\share\etc`, `\\?\C:\etc`, `\\.\C:\etc`,
		`%SystemRoot%\System32\drivers\etc`, `C:\Windows\%X%`, `C:\etc:stream`, `C:\etc\..\x`,
		`C:\.\etc`, `C:\etc\*`, "C:\\etc\x00x", "C:\\etc\nx", `1:\etc`, `CC:\etc`, `/etc`,
		`C:\etc\ ..`,
	}
	for _, in := range bad {
		if got, valid := windowsLocalDir(in); valid {
			t.Errorf("windowsLocalDir(%q) = %q, true; want rejected", in, got)
		}
	}
}

func TestSystemHostsPath(t *testing.T) {
	p, redirected := systemHostsPath()
	if !filepath.IsAbs(p) || filepath.Base(p) != "hosts" {
		t.Fatalf("systemHostsPath() = %q", p)
	}
	if p != DefaultHostsPath() || redirected != HostsPathRedirected() {
		t.Fatal("DefaultHostsPath and HostsPathRedirected disagree with systemHostsPath")
	}
	if runtime.GOOS != "windows" && redirected {
		t.Fatal("redirected outside Windows")
	}
}
