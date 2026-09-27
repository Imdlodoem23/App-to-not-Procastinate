//go:build centrate_dev

package platform

// DevBuild reports whether the binary was built with -tags centrate_dev. Dev
// builds honour the CENTRATE_DATA_DIR and CENTRATE_HOSTS_PATH overrides even
// when elevated and let svc register a binary from an unprotected folder. Never
// ship one.
const DevBuild = true
