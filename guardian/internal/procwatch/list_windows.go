package procwatch

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// maxProcessInfoSize bounds the buffer List grows for the process table.
const maxProcessInfoSize = 64 << 20

// List returns the running processes from
// NtQuerySystemInformation(SystemProcessInformation): image file name (no
// truncation), PID, parent PID and session of every process, without opening
// any of them (no handles to lsass.exe or csrss.exe every scan). Processes in
// session 0 (services) are System. Path is left empty: resolving it means
// opening each process, and Kill reads it through its own handle anyway.
func List() ([]Process, error) {
	buf, err := querySystemProcesses()
	if err != nil {
		return nil, err
	}
	return parseSystemProcesses(buf)
}

// querySystemProcesses returns the SystemProcessInformation table in an
// 8-byte aligned buffer, growing it while the table does not fit.
func querySystemProcesses() ([]byte, error) {
	size := uint32(512 << 10)
	for {
		words := make([]uint64, (size+7)/8)
		buf := unsafe.Slice((*byte)(unsafe.Pointer(&words[0])), len(words)*8)
		var need uint32
		err := windows.NtQuerySystemInformation(windows.SystemProcessInformation, unsafe.Pointer(&buf[0]), uint32(len(buf)), &need)
		if err == nil {
			return buf, nil
		}
		if !errors.Is(err, windows.STATUS_INFO_LENGTH_MISMATCH) && !errors.Is(err, windows.STATUS_BUFFER_TOO_SMALL) {
			return nil, fmt.Errorf("procwatch: process list: %w", err)
		}
		if size >= maxProcessInfoSize {
			return nil, errors.New("procwatch: process list: table too large")
		}
		// The table can grow between two calls: leave some room.
		size = min(max(need+need/4, size*2), maxProcessInfoSize)
	}
}

// parseSystemProcesses walks the SYSTEM_PROCESS_INFORMATION entries of buf,
// checking every offset and string against its bounds.
func parseSystemProcesses(buf []byte) ([]Process, error) {
	const entrySize = unsafe.Sizeof(windows.SYSTEM_PROCESS_INFORMATION{})
	errMalformed := errors.New("procwatch: process list: malformed table")
	procs := make([]Process, 0, 256)
	for off := uintptr(0); ; {
		if off%8 != 0 || off+entrySize > uintptr(len(buf)) {
			return nil, errMalformed
		}
		e := (*windows.SYSTEM_PROCESS_INFORMATION)(unsafe.Pointer(&buf[off]))
		name, ok := imageName(buf, &e.ImageName)
		if !ok {
			return nil, errMalformed
		}
		p := Process{
			PID:     int(e.UniqueProcessID),
			PPID:    int(e.InheritedFromUniqueProcessID),
			Name:    name,
			System:  e.SessionID == 0,
			created: e.CreateTime,
		}
		switch {
		case p.PID == 0 && p.Name == "":
			p.Name = "[System Process]" // what Toolhelp and Task Manager call it
		case p.PID == 0 || p.PPID == p.PID:
			p.PPID = 0
		}
		procs = append(procs, p)
		if e.NextEntryOffset == 0 {
			return procs, nil
		}
		off += uintptr(e.NextEntryOffset)
	}
}

// imageName reads an entry's ImageName, which points into buf.
func imageName(buf []byte, s *windows.NTUnicodeString) (string, bool) {
	if s.Length == 0 || s.Buffer == nil {
		return "", true
	}
	base := uintptr(unsafe.Pointer(&buf[0]))
	start := uintptr(unsafe.Pointer(s.Buffer))
	n := uintptr(s.Length)
	if start < base || start%2 != 0 || n%2 != 0 || start-base+n > uintptr(len(buf)) {
		return "", false
	}
	u := unsafe.Slice((*uint16)(unsafe.Pointer(&buf[start-base])), n/2)
	return windows.UTF16ToString(u), true
}

// processName returns the image file name of pid from the process table, or
// ErrNotFound.
func processName(pid int) (string, error) {
	procs, err := List()
	if err != nil {
		return "", err
	}
	for _, p := range procs {
		if p.PID == pid && p.Name != "" {
			return p.Name, nil
		}
	}
	return "", ErrNotFound
}

// imagePath calls QueryFullProcessImageName, growing the buffer up to
// MAX_LONG_PATH when needed.
func imagePath(h windows.Handle) (string, error) {
	for size := uint32(windows.MAX_PATH + 1); ; size *= 4 {
		buf := make([]uint16, size)
		n := size
		err := windows.QueryFullProcessImageName(h, 0, &buf[0], &n)
		if err == nil {
			return windows.UTF16ToString(buf[:n]), nil
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) || size >= windows.MAX_LONG_PATH {
			return "", err
		}
	}
}
