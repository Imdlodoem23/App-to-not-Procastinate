//go:build windows

package nuclear

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/imdlodoem23/centrate/guardian/internal/procwatch"
)

// noConsoleSession is WTSGetActiveConsoleSessionId's answer while no session is
// attached to the console (a session switch in progress).
const noConsoleSession = 0xFFFFFFFF

// userDesktop is the interactive desktop of the console session.
const userDesktop = `winsta0\default`

// AppRunning implements engine.NuclearRelauncher: a process in the active console
// session whose full image path is appPath (compared case-insensitively). The process
// table gives names only, so only processes named like the app are opened.
func (r *Relauncher) AppRunning() (bool, error) {
	console := windows.WTSGetActiveConsoleSessionId()
	if console == noConsoleSession {
		return false, nil
	}
	procs, err := procwatch.List()
	if err != nil {
		return false, err
	}
	base := filepath.Base(r.appPath)
	for _, p := range procs {
		if p.System || !strings.EqualFold(p.Name, base) {
			continue
		}
		var session uint32
		if windows.ProcessIdToSessionId(uint32(p.PID), &session) != nil || session != console {
			continue
		}
		if path, ok := imagePath(uint32(p.PID)); ok && strings.EqualFold(filepath.Clean(path), r.appPath) {
			return true, nil
		}
	}
	return false, nil
}

// imagePath is a process's full executable path.
func imagePath(pid uint32) (string, bool) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", false
	}
	defer func() { _ = windows.CloseHandle(h) }()
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n); err != nil {
		return "", false
	}
	return windows.UTF16ToString(buf[:n]), true
}

// Relaunch implements engine.NuclearRelauncher: the console user's own token
// (WTSQueryUserToken: the filtered token when UAC is on, never SYSTEM) starts
// appPath --centrate-nuclear on the interactive desktop with the user's environment.
func (r *Relauncher) Relaunch(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	session := windows.WTSGetActiveConsoleSessionId()
	if session == noConsoleSession {
		return ErrNoConsoleUser
	}
	var tok windows.Token
	if err := windows.WTSQueryUserToken(session, &tok); err != nil {
		return fmt.Errorf("%w (%v)", ErrNoConsoleUser, err)
	}
	defer func() { _ = tok.Close() }()
	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, tok, false); err != nil {
		return fmt.Errorf("nuclear: user environment: %w", err)
	}
	defer func() { _ = windows.DestroyEnvironmentBlock(env) }()
	app, err := windows.UTF16PtrFromString(r.appPath)
	if err != nil {
		return err
	}
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine([]string{r.appPath, Arg}))
	if err != nil {
		return err
	}
	dir, err := windows.UTF16PtrFromString(filepath.Dir(r.appPath))
	if err != nil {
		return err
	}
	desktop, err := windows.UTF16PtrFromString(userDesktop)
	if err != nil {
		return err
	}
	si := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{})), Desktop: desktop}
	var pi windows.ProcessInformation
	if err := windows.CreateProcessAsUser(tok, app, cmdLine, nil, nil, false,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NEW_PROCESS_GROUP, env, dir, &si, &pi); err != nil {
		return fmt.Errorf("nuclear: start the app: %w", err)
	}
	_ = windows.CloseHandle(pi.Thread)
	_ = windows.CloseHandle(pi.Process)
	return nil
}
