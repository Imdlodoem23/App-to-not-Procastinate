package store

import (
	"encoding/json"
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Windows rollback anchor (§11.1): HKLM\SOFTWARE\Centrate\Guardian, value "Anchor"
// (REG_SZ JSON), removed on uninstall. HKLM\SOFTWARE is writable only by
// administrators.
const (
	anchorKeyPath   = `SOFTWARE\Centrate\Guardian`
	anchorParentKey = `SOFTWARE\Centrate`
	anchorValueName = "Anchor"
)

// OSAnchor is the system rollback anchor: on Windows a registry value.
func OSAnchor() AnchorStore {
	return &RegistryAnchor{Root: registry.LOCAL_MACHINE, Path: anchorKeyPath, Value: anchorValueName}
}

// RegistryAnchor keeps the anchor as a REG_SZ JSON value (64-bit view). Tests point it
// at HKEY_CURRENT_USER.
type RegistryAnchor struct {
	Root  registry.Key
	Path  string
	Value string
}

var procRegFlushKey = windows.NewLazySystemDLL("advapi32.dll").NewProc("RegFlushKey")

// Load reads the value.
func (r *RegistryAnchor) Load() (Anchor, bool, error) {
	k, err := registry.OpenKey(r.Root, r.Path, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if errors.Is(err, registry.ErrNotExist) {
		return Anchor{}, false, nil
	}
	if err != nil {
		return Anchor{}, false, err
	}
	defer k.Close()
	s, _, err := k.GetStringValue(r.Value)
	if errors.Is(err, registry.ErrNotExist) {
		return Anchor{}, false, nil
	}
	if err != nil {
		return Anchor{}, false, err
	}
	var a Anchor
	if err := json.Unmarshal([]byte(s), &a); err != nil {
		return Anchor{}, false, fmt.Errorf("%w: %v", ErrAnchorFormat, err)
	}
	return a, true, nil
}

// Save writes the value and flushes the key to disk before returning.
func (r *RegistryAnchor) Save(a Anchor) error {
	data, err := json.Marshal(a)
	if err != nil {
		return err
	}
	k, _, err := registry.CreateKey(r.Root, r.Path, registry.SET_VALUE|registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.SetStringValue(r.Value, string(data)); err != nil {
		return err
	}
	if err := procRegFlushKey.Find(); err == nil {
		if rc, _, _ := procRegFlushKey.Call(uintptr(k)); rc != 0 {
			return fmt.Errorf("RegFlushKey: %w", windows.Errno(rc))
		}
	}
	return nil
}

// Remove deletes the value and the keys it lives in when they are left empty.
func (r *RegistryAnchor) Remove() error {
	k, err := registry.OpenKey(r.Root, r.Path, registry.SET_VALUE|registry.WOW64_64KEY)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	err = k.DeleteValue(r.Value)
	k.Close()
	if err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	_ = registry.DeleteKey(r.Root, r.Path)
	if r.Root == registry.LOCAL_MACHINE && r.Path == anchorKeyPath {
		_ = registry.DeleteKey(r.Root, anchorParentKey)
	}
	return nil
}
