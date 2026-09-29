package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/platform"
)

// File names inside the system data directory (docs/ARCHITECTURE.md §11.1).
const (
	// ConfigFileName is the installer-written, admin-only configuration.
	ConfigFileName = "config.json"
	// ClientFileName is the app token file rewritten on every start (§9.2).
	ClientFileName = "client.json"
)

// maxConfigBytes bounds what LoadConfig reads.
const maxConfigBytes = 64 << 10

// chromiumIDRE is the shape of a Chromium extension id: 32 characters a–p.
var chromiumIDRE = regexp.MustCompile(`^[a-p]{32}$`)

// Config is <sysdir>/config.json, written by the installer and writable only by
// administrators (§11.1): {schemaVersion, port, appPath, extraExtensionIds[], logLevel}.
type Config struct {
	SchemaVersion int `json:"schemaVersion"`
	// Port is the API port (default: the embedded default port). There is no fallback
	// port: the extension trusts a fixed port after pairing (§2).
	Port int `json:"port"`
	// AppPath is the absolute path of the desktop app's executable: the only process
	// whose Nuclear heartbeats are accepted (§8.8, §10.5). Empty: none is.
	AppPath string `json:"appPath"`
	// ExtraExtensionIDs are admin-configured Chromium store ids allowed as
	// chrome-extension:// origins besides the pinned one (§9.4).
	ExtraExtensionIDs []string `json:"extraExtensionIds"`
	// LogLevel is the guardian's log level (read by the service wiring, not here).
	LogLevel string `json:"logLevel"`
}

// DefaultConfig is the configuration without a config.json.
func DefaultConfig() Config {
	return Config{SchemaVersion: 1, Port: embedded.API().DefaultPort, ExtraExtensionIDs: []string{}}
}

// LoadConfig reads dataDir/config.json. A missing file gives DefaultConfig and no
// error. Invalid values are replaced by their defaults (a bad port by the default
// port, bad extension ids and a relative appPath are dropped) and reported in the
// error, which the caller logs; the returned Config is always usable. Unknown fields
// are ignored (a newer installer may add some).
func LoadConfig(dataDir string) (Config, error) {
	cfg := DefaultConfig()
	f, err := platform.OpenRegularFile(filepath.Join(dataDir, ConfigFileName), os.O_RDONLY, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, fmt.Errorf("api: open %s: %w", ConfigFileName, err)
	}
	defer func() { _ = f.Close() }()
	raw, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	if err != nil {
		return cfg, fmt.Errorf("api: read %s: %w", ConfigFileName, err)
	}
	if len(raw) > maxConfigBytes {
		return cfg, fmt.Errorf("api: %s is larger than %d bytes", ConfigFileName, maxConfigBytes)
	}
	var file Config
	if err := json.Unmarshal(raw, &file); err != nil {
		return cfg, fmt.Errorf("api: parse %s: %w", ConfigFileName, err)
	}
	return normalizeConfig(file)
}

// normalizeConfig applies the defaults and drops invalid values (see LoadConfig).
func normalizeConfig(in Config) (Config, error) {
	cfg := DefaultConfig()
	var problems []error
	if in.SchemaVersion > 0 {
		cfg.SchemaVersion = in.SchemaVersion
	}
	switch {
	case in.Port == 0:
	case in.Port < 1 || in.Port > 65535:
		problems = append(problems, fmt.Errorf("port %d out of range; using %d", in.Port, cfg.Port))
	default:
		cfg.Port = in.Port
	}
	if in.AppPath != "" {
		if filepath.IsAbs(in.AppPath) {
			cfg.AppPath = filepath.Clean(in.AppPath)
		} else {
			problems = append(problems, errors.New("appPath is not absolute; ignored"))
		}
	}
	for _, id := range in.ExtraExtensionIDs {
		if !chromiumIDRE.MatchString(id) {
			problems = append(problems, errors.New("an extraExtensionIds entry is not a Chromium extension id; ignored"))
			continue
		}
		cfg.ExtraExtensionIDs = append(cfg.ExtraExtensionIDs, id)
	}
	cfg.LogLevel = in.LogLevel
	if len(problems) > 0 {
		return cfg, fmt.Errorf("api: %s: %w", ConfigFileName, errors.Join(problems...))
	}
	return cfg, nil
}
