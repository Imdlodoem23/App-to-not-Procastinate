package api

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/platform"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// Token prefixes (APP_TOKEN_PREFIX and EXT_TOKEN_PREFIX of guardian-api.ts).
const (
	appTokenPrefix = "cta_"
	extTokenPrefix = "cte_"
	// appTokenBytes is the random part of an app token (§9.2).
	appTokenBytes = 32
	// maxTokenLength bounds an Authorization token before any comparison.
	maxTokenLength = 256
	// clientFileVersion is client.json's "v".
	clientFileVersion = 1
)

// ClientFile is <sysdir>/client.json (§9.2): what the Electron main process reads to
// reach and authenticate to the guardian. Readable by local users, writable only by
// administrators; rewritten atomically with a new token on every start.
type ClientFile struct {
	V               int    `json:"v"`
	Port            int    `json:"port"`
	Token           string `json:"token"`
	GuardianVersion string `json:"guardianVersion"`
	PID             int    `json:"pid"`
	IssuedAt        string `json:"issuedAt"`
}

// newAppToken returns cta_ plus 32 random bytes (base64url, no padding).
func newAppToken() (string, error) {
	var buf [appTokenBytes]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("api: generate app token: %w", err)
	}
	return appTokenPrefix + base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

// tokenDigest is sha256(token): tokens are only kept and compared as digests (§8.2).
func tokenDigest(token string) [sha256.Size]byte { return sha256.Sum256([]byte(token)) }

// digestEqual compares two digests in constant time.
func digestEqual(a, b [sha256.Size]byte) bool { return subtle.ConstantTimeCompare(a[:], b[:]) == 1 }

// writeClientFile writes dataDir/client.json atomically (§11.2) with the ordinary
// guardian file mode: every local account reads it, only administrators write it.
func writeClientFile(dataDir string, f ClientFile) error {
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return store.WriteAtomic(filepath.Join(dataDir, ClientFileName), append(raw, '\n'), platform.FileMode)
}

// newClientFile describes a freshly issued token.
func newClientFile(port int, token, guardianVersion string, now time.Time) ClientFile {
	return ClientFile{
		V: clientFileVersion, Port: port, Token: token, GuardianVersion: guardianVersion,
		PID: os.Getpid(), IssuedAt: store.FormatTime(now),
	}
}
