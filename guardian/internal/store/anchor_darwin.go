package store

// anchorPlistPath is the macOS rollback anchor (§11.1), removed on uninstall.
const anchorPlistPath = "/Library/Preferences/io.github.imdlodoem23.centrate.guardian.plist"

// OSAnchor is the system rollback anchor: on macOS a property list in
// /Library/Preferences (root, 0600; the directory already exists and is never
// re-owned).
func OSAnchor() AnchorStore {
	return &FileAnchor{Path: anchorPlistPath, Plist: true}
}
