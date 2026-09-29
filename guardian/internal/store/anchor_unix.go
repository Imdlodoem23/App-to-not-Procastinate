//go:build unix && !darwin

package store

// anchorJSONPath is the Linux rollback anchor (§11.1), removed on uninstall.
const anchorJSONPath = "/etc/centrate/anchor.json"

// OSAnchor is the system rollback anchor: on Linux /etc/centrate/anchor.json (root,
// 0600).
func OSAnchor() AnchorStore {
	return &FileAnchor{Path: anchorJSONPath, CreateDir: true}
}
