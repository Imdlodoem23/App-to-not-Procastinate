package platform

import (
	"bufio"
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// readLogindSessions parses the logind session files in dir (systemd's
// /run/systemd/sessions/<id>, KEY=VALUE lines). It keeps the sessions of
// class user* on a seat that are not closing; remote sessions (SSH) have no
// seat. boot and mono are the current boot-clock and CLOCK_MONOTONIC
// readings (mono < 0: unknown), used to turn MONOTONIC= into a boot-clock
// logon time. A missing dir (no systemd) lists nothing.
func readLogindSessions(dir string, boot, mono time.Duration) ([]LogonSession, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []LogonSession
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || strings.ContainsAny(name, ".") {
			continue // *.ref FIFOs and temporary files
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || len(data) > 64<<10 {
			continue // closed meanwhile
		}
		kv := parseKeyValues(data)
		if !strings.HasPrefix(kv["CLASS"], "user") || kv["SEAT"] == "" || kv["STATE"] == "closing" || kv["REMOTE"] == "1" {
			continue
		}
		s := LogonSession{ID: name + "@" + kv["REALTIME"], Console: kv["ACTIVE"] == "1" && kv["SEAT"] == "seat0"}
		if us, err := strconv.ParseInt(kv["MONOTONIC"], 10, 64); err == nil && us > 0 && mono >= 0 {
			s.LogonBoot, s.HasLogon = logonFromElapsed(boot, mono-time.Duration(us)*time.Microsecond), true
		}
		out = append(out, s)
	}
	return out, nil
}

func parseKeyValues(data []byte) map[string]string {
	kv := make(map[string]string)
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			kv[k] = v
		}
	}
	return kv
}
