// Package embedded holds the data the guardian shares with the TypeScript packages,
// generated from packages/shared by scripts/gen-guardian-data.mjs (docs/ARCHITECTURE.md
// §12):
//
//	catalog.json  catalogSnapshot()      packages/shared/src/catalog
//	rules.json    rulesSnapshot()        packages/shared/src/points.ts
//	api.json      apiContractSnapshot()  packages/shared/src/guardian-api.ts
//
// Never edit the JSON files by hand: change packages/shared and run
// `npm run gen:guardian`. Every numeric rule of the guardian (points, penalties,
// countdowns, windows, limits, error statuses, default settings) comes from here, never
// from literals.
//
// The files are decoded once, at package initialization, into the typed structs below,
// which mirror the TypeScript snapshot types field by field. Decoding is strict: an
// unknown field, a field the file lacks, a value of another type, a hand edit (the
// envelope's sourceSha256 no longer matches its data) or trailing data makes the package
// panic, so a guardian built from mismatched data refuses to start and `go test` fails.
// When packages/shared changes a snapshot shape, update these structs in the same change.
//
// The values returned by [Catalog], [Rules] and [API] are shared and must be treated as
// read-only (concurrent reads are safe). Copy before modifying, e.g. with
// [GuardianSettings.Clone].
package embedded

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"slices"
	"time"
)

// GeneratedBy is the generator every embedded file must name.
const GeneratedBy = "scripts/gen-guardian-data.mjs"

var (
	//go:embed catalog.json
	catalogJSON []byte
	//go:embed rules.json
	rulesJSON []byte
	//go:embed api.json
	apiJSON []byte
)

// ---------------------------------------------------------------------------------------
// catalog.json: catalogSnapshot() (packages/shared/src/catalog/types.ts CatalogSnapshot)
// ---------------------------------------------------------------------------------------

// Catalog platform keys of [ProcessNames] (TS CatalogPlatform).
const (
	PlatformWin   = "win"
	PlatformMac   = "mac"
	PlatformLinux = "linux"
)

// CatalogSnapshot mirrors CatalogSnapshot. Optional TS fields are always present (empty
// list or false).
type CatalogSnapshot struct {
	Version           int         `json:"version"`
	Categories        []Category  `json:"categories"`
	Services          []Service   `json:"services"`
	Apps              []App       `json:"apps"`
	StudyWhitelist    []StudySite `json:"studyWhitelist"`
	StudyAppWhitelist []App       `json:"studyAppWhitelist"`
	// ProtectedProcesses are never killed (compared case-insensitively).
	ProtectedProcesses []string `json:"protectedProcesses"`
	// AlwaysAllowedHosts are never blocked, in any mode, together with their subdomains.
	AlwaysAllowedHosts []string `json:"alwaysAllowedHosts"`
	// Browsers are the known browsers with their process names (BROWSERS).
	Browsers []Browser `json:"browsers"`
	// ProtectedDomains can never be blocked, nor any of their subdomains (PROTECTED_DOMAINS).
	ProtectedDomains []string `json:"protectedDomains"`
	// MultiLabelSuffixes are multi-label public suffixes such as co.uk (MULTI_LABEL_SUFFIXES).
	MultiLabelSuffixes []string `json:"multiLabelSuffixes"`
}

// Browser is one known browser (TS Browser): Family is the engine, ExtensionFamily the
// BrowserFamily its Céntrate extension reports.
type Browser struct {
	ID              string       `json:"id"`
	Name            string       `json:"name"`
	Family          string       `json:"family"`
	ExtensionFamily string       `json:"extensionFamily"`
	Processes       ProcessNames `json:"processes"`
}

// Category is one distraction category (social, video, games, messaging, shopping, news).
type Category struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Aliases []string `json:"aliases"`
	// AppIDs are apps blocked with the category that belong to no single service.
	AppIDs []string `json:"appIds"`
}

// Service is one catalog service (YouTube, TikTok…).
type Service struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Categories that include the service; empty for an opt-in service, which is only
	// blocked when named explicitly.
	Categories []string `json:"categories"`
	// Domains are every host to block, already expanded (the hosts file has no wildcards).
	Domains            []string `json:"domains"`
	AppIDs             []string `json:"appIds"`
	Aliases            []string `json:"aliases"`
	Monogram           string   `json:"monogram"`
	EducationalCapable bool     `json:"educationalCapable"`
	TitleHints         []string `json:"titleHints"`
	// ExcludedSubdomains are subdomains of Domains that stay reachable while the service
	// is blocked.
	ExcludedSubdomains []string `json:"excludedSubdomains"`
}

// App is a desktop app with its executable base names per platform.
type App struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Processes ProcessNames `json:"processes"`
}

// ProcessNames are executable base names per platform, exactly as they appear in the
// process list (TS ProcessNames).
type ProcessNames struct {
	Win   []string `json:"win"`
	Mac   []string `json:"mac"`
	Linux []string `json:"linux"`
}

// For returns the names for a catalog platform key (PlatformWin, PlatformMac,
// PlatformLinux), or nil for any other key.
func (p ProcessNames) For(platform string) []string {
	switch platform {
	case PlatformWin:
		return p.Win
	case PlatformMac:
		return p.Mac
	case PlatformLinux:
		return p.Linux
	}
	return nil
}

// PlatformForGOOS maps a runtime.GOOS value to its catalog platform key, or "" when the
// catalog has no process names for that OS.
func PlatformForGOOS(goos string) string {
	switch goos {
	case "windows":
		return PlatformWin
	case "darwin":
		return PlatformMac
	case "linux":
		return PlatformLinux
	}
	return ""
}

// StudySite is a group of study domains in the default whitelist.
type StudySite struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Domains also allow all of their subdomains.
	Domains []string `json:"domains"`
	// HostPatterns are RE2 sources matched against the whole canonical host (^…$).
	HostPatterns []string `json:"hostPatterns"`
}

// ---------------------------------------------------------------------------------------
// rules.json: rulesSnapshot() (packages/shared/src/points.ts)
// ---------------------------------------------------------------------------------------

// RulesSnapshot mirrors the return type of rulesSnapshot().
type RulesSnapshot struct {
	RulesVersion    int              `json:"rulesVersion"`
	Points          PointRules       `json:"points"`
	Emergency       EmergencyRules   `json:"emergency"`
	Study           StudyRules       `json:"study"`
	RewardOffers    []RewardOffer    `json:"rewardOffers"`
	PomodoroPresets []PomodoroPreset `json:"pomodoroPresets"`
}

// PointRules mirrors PointRules (POINT_RULES). See points.ts for the meaning of each value.
type PointRules struct {
	BlockPointsPerMinute int `json:"blockPointsPerMinute"`
	// EarningBlockKinds are the block kinds that earn points (BlockKind values).
	EarningBlockKinds         []string `json:"earningBlockKinds"`
	StudyPointsPerFocusMinute int      `json:"studyPointsPerFocusMinute"`
	CleanSessionBonus         int      `json:"cleanSessionBonus"`
	CleanSessionMinMinutes    int      `json:"cleanSessionMinMinutes"`
	AttemptBasePenalty        int      `json:"attemptBasePenalty"`
	AttemptPenaltyMultiplier  int      `json:"attemptPenaltyMultiplier"`
	AttemptPenaltyCap         int      `json:"attemptPenaltyCap"`
	AttemptEscalationWindowMs int      `json:"attemptEscalationWindowMs"`
	AttemptDedupeWindowMs     int      `json:"attemptDedupeWindowMs"`
	StrikePenalty             int      `json:"strikePenalty"`
	PunishmentPenalty         int      `json:"punishmentPenalty"`
	EmergencyMinPenalty       int      `json:"emergencyMinPenalty"`
	EmergencyBalanceDivisor   int      `json:"emergencyBalanceDivisor"`
	XPPerFocusMinute          int      `json:"xpPerFocusMinute"`
	LevelXPStep               int      `json:"levelXpStep"`
	DailyGoalDefaultMinutes   int      `json:"dailyGoalDefaultMinutes"`
	DailyGoalMinMinutes       int      `json:"dailyGoalMinMinutes"`
	DailyGoalMaxMinutes       int      `json:"dailyGoalMaxMinutes"`
}

// EmergencyRules mirrors EmergencyRules (EMERGENCY_RULES).
type EmergencyRules struct {
	// CountdownMinutes by strictest targeted mode; hardcore and exam have none.
	CountdownMinutes     EmergencyCountdown `json:"countdownMinutes"`
	ConfirmWindowMinutes int                `json:"confirmWindowMinutes"`
	// Phrases are the commitment phrases per UI language (ASCII only).
	Phrases EmergencyPhrases `json:"phrases"`
}

// EmergencyCountdown is the emergency countdown per block mode, in minutes.
type EmergencyCountdown struct {
	Normal int `json:"normal"`
	Strict int `json:"strict"`
}

// EmergencyPhrases is the commitment phrase per UI language.
type EmergencyPhrases struct {
	ES string `json:"es"`
	EN string `json:"en"`
}

// MinMax is an inclusive range.
type MinMax struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// TunableRange mirrors TunableRange: a user-picked value is clamped to [Min, Max].
type TunableRange struct {
	Min     int `json:"min"`
	Max     int `json:"max"`
	Default int `json:"default"`
}

// StudyRules mirrors StudyRules (STUDY_RULES). See points.ts for the meaning of each value.
type StudyRules struct {
	PlannedMinutes       MinMax `json:"plannedMinutes"`
	PomodoroWorkMinutes  MinMax `json:"pomodoroWorkMinutes"`
	PomodoroBreakMinutes MinMax `json:"pomodoroBreakMinutes"`
	// App-side attention tunables: embedded but not enforced by the guardian.
	DoubtAfterMs        TunableRange `json:"doubtAfterMs"`
	StrikeAfterDoubtMs  TunableRange `json:"strikeAfterDoubtMs"`
	NoFaceStrikeMs      TunableRange `json:"noFaceStrikeMs"`
	FocusScoreThreshold TunableRange `json:"focusScoreThreshold"`
	// Guardian-enforced.
	MaxStrikes             int          `json:"maxStrikes"`
	StrikeCooldownMs       int          `json:"strikeCooldownMs"`
	HeartbeatIntervalMs    int          `json:"heartbeatIntervalMs"`
	HeartbeatTimeoutMs     int          `json:"heartbeatTimeoutMs"`
	FinalHeartbeatGraceMs  int          `json:"finalHeartbeatGraceMs"`
	PauseMs                int          `json:"pauseMs"`
	MaxPausesPerWindow     int          `json:"maxPausesPerWindow"`
	PauseWindowMs          int          `json:"pauseWindowMs"`
	FocusFlushMinutes      int          `json:"focusFlushMinutes"`
	CompletionGraceMs      int          `json:"completionGraceMs"`
	OutcomeWindowMs        int          `json:"outcomeWindowMs"`
	PunishmentMinutes      TunableRange `json:"punishmentMinutes"`
	DefaultPunishmentLevel string       `json:"defaultPunishmentLevel"`
}

// RewardOffer mirrors RewardOffer: Minutes of ServiceID for Cost points.
type RewardOffer struct {
	ID        string `json:"id"`
	ServiceID string `json:"serviceId"`
	Minutes   int    `json:"minutes"`
	Cost      int    `json:"cost"`
}

// PomodoroPreset mirrors PomodoroPreset.
type PomodoroPreset struct {
	ID           string `json:"id"`
	WorkMinutes  int    `json:"workMinutes"`
	BreakMinutes int    `json:"breakMinutes"`
	Cycles       int    `json:"cycles"`
}

// ---------------------------------------------------------------------------------------
// api.json: apiContractSnapshot() (packages/shared/src/guardian-api.ts)
// ---------------------------------------------------------------------------------------

// APIContractSnapshot mirrors the return type of apiContractSnapshot().
type APIContractSnapshot struct {
	APIVersion     int            `json:"apiVersion"`
	DefaultPort    int            `json:"defaultPort"`
	Limits         Limits         `json:"limits"`
	ResponseLimits ResponseLimits `json:"responseLimits"`
	// Endpoints is the complete route table (GUARDIAN_ENDPOINTS), in source order.
	Endpoints []EndpointSpec `json:"endpoints"`
	// Errors maps every GuardianErrorCode to its HTTP status (GUARDIAN_ERROR_STATUS).
	Errors                 map[string]int   `json:"errors"`
	Capabilities           []string         `json:"capabilities"`
	Problems               []string         `json:"problems"`
	DataDeleteConfirmWords []string         `json:"dataDeleteConfirmWords"`
	ChromiumExtensionID    string           `json:"chromiumExtensionId"`
	DefaultSettings        GuardianSettings `json:"defaultSettings"`
	// DefaultKeepAwake is DEFAULT_KEEP_AWAKE: keep-awake of a fresh install (§5.11).
	DefaultKeepAwake KeepAwakeConfig `json:"defaultKeepAwake"`
}

// KeepAwakeConfig mirrors KeepAwakeConfig (domain.ts). In api.json only the fresh-install
// default: off, no duration («Hasta que lo desactive»), screen kept on too.
type KeepAwakeConfig struct {
	On              bool    `json:"on"`
	DurationMinutes *int    `json:"durationMinutes"`
	Display         bool    `json:"display"`
	Since           *string `json:"since"`
	Until           *string `json:"until"`
}

// Limits mirrors GUARDIAN_LIMITS. Text lengths count UTF-16 code units; *Ms values are
// milliseconds. See guardian-api.ts for the meaning of each value.
type Limits struct {
	BlockMinMinutes                int `json:"blockMinMinutes"`
	BlockMaxMinutes                int `json:"blockMaxMinutes"`
	LongBlockConfirmMinutes        int `json:"longBlockConfirmMinutes"`
	ExtendMaxAddMinutes            int `json:"extendMaxAddMinutes"`
	ReasonMaxLength                int `json:"reasonMaxLength"`
	TaskMaxLength                  int `json:"taskMaxLength"`
	ScheduleNameMaxLength          int `json:"scheduleNameMaxLength"`
	MaxSchedules                   int `json:"maxSchedules"`
	ScheduleFreezeMinutes          int `json:"scheduleFreezeMinutes"`
	MaxIDsPerList                  int `json:"maxIdsPerList"`
	MaxCustomDomains               int `json:"maxCustomDomains"`
	MaxCustomProcesses             int `json:"maxCustomProcesses"`
	MaxWhitelistExtraDomains       int `json:"maxWhitelistExtraDomains"`
	MaxWhitelistExtraProcesses     int `json:"maxWhitelistExtraProcesses"`
	MaxActiveBlocks                int `json:"maxActiveBlocks"`
	MaxActiveCustomHosts           int `json:"maxActiveCustomHosts"`
	MaxScheduleCustomHosts         int `json:"maxScheduleCustomHosts"`
	HostsMaxDomains                int `json:"hostsMaxDomains"`
	AllowanceMaxMinutes            int `json:"allowanceMaxMinutes"`
	SettingsWeakeningDelayMs       int `json:"settingsWeakeningDelayMs"`
	MaxBodyBytes                   int `json:"maxBodyBytes"`
	StatePollIntervalMs            int `json:"statePollIntervalMs"`
	RequestTimeoutMs               int `json:"requestTimeoutMs"`
	LongPollMaxMs                  int `json:"longPollMaxMs"`
	EventsPageDefault              int `json:"eventsPageDefault"`
	EventsPageMax                  int `json:"eventsPageMax"`
	MaxBatchEvents                 int `json:"maxBatchEvents"`
	BlocksPageMax                  int `json:"blocksPageMax"`
	HeartbeatMaxFocusMs            int `json:"heartbeatMaxFocusMs"`
	HeartbeatMaxWarnings           int `json:"heartbeatMaxWarnings"`
	IdempotencyTTLMs               int `json:"idempotencyTtlMs"`
	IdempotencyKeyMaxLength        int `json:"idempotencyKeyMaxLength"`
	IdempotencyMaxEntries          int `json:"idempotencyMaxEntries"`
	UnverifiedCompletionsMax       int `json:"unverifiedCompletionsMax"`
	PairingCodeTTLMs               int `json:"pairingCodeTtlMs"`
	PairingMaxFailures             int `json:"pairingMaxFailures"`
	PairingClaimsPerWindow         int `json:"pairingClaimsPerWindow"`
	PairingClaimWindowMs           int `json:"pairingClaimWindowMs"`
	ExtRulesAlarmMs                int `json:"extRulesAlarmMs"`
	ExtHeartbeatIntervalMs         int `json:"extHeartbeatIntervalMs"`
	ExtConnectedWindowMs           int `json:"extConnectedWindowMs"`
	ExtRulesCurrentGraceMs         int `json:"extRulesCurrentGraceMs"`
	BrowserWithoutExtensionGraceMs int `json:"browserWithoutExtensionGraceMs"`
	RecentEndedBlocksMs            int `json:"recentEndedBlocksMs"`
	RecentEndedStudyMs             int `json:"recentEndedStudyMs"`
	StudyHistoryMs                 int `json:"studyHistoryMs"`
	EmergencyMaxBlocks             int `json:"emergencyMaxBlocks"`
	PhraseMaxLength                int `json:"phraseMaxLength"`
	NuclearHeartbeatIntervalMs     int `json:"nuclearHeartbeatIntervalMs"`
	NuclearLivenessMs              int `json:"nuclearLivenessMs"`
	// Daily limits (ARCHITECTURE §5.10, §10.13).
	MaxLimits                 int `json:"maxLimits"`
	LimitNameMaxLength        int `json:"limitNameMaxLength"`
	LimitMinMinutes           int `json:"limitMinMinutes"`
	LimitMaxMinutes           int `json:"limitMaxMinutes"`
	MaxLimitCustomHosts       int `json:"maxLimitCustomHosts"`
	LimitWarningSeconds       int `json:"limitWarningSeconds"`
	LimitWeakeningDelayMs     int `json:"limitWeakeningDelayMs"`
	LimitMaxBlocksPerDay      int `json:"limitMaxBlocksPerDay"`
	LimitMinBlockMs           int `json:"limitMinBlockMs"`
	UsageReportIntervalMs     int `json:"usageReportIntervalMs"`
	UsageFastReportIntervalMs int `json:"usageFastReportIntervalMs"`
	UsageMaxIntervalMs        int `json:"usageMaxIntervalMs"`
	UsageMaxItems             int `json:"usageMaxItems"`
	UsageSlackMs              int `json:"usageSlackMs"`
	UsageIdleSeconds          int `json:"usageIdleSeconds"`
	// Keep-awake (ARCHITECTURE §5.11): durationMinutes range.
	KeepAwakeMinMinutes int `json:"keepAwakeMinMinutes"`
	KeepAwakeMaxMinutes int `json:"keepAwakeMaxMinutes"`
}

// ResponseLimits mirrors RESPONSE_LIMITS: the size caps of the TS response validators,
// far above anything the guardian may emit.
type ResponseLimits struct {
	Domains     int `json:"domains"`
	Processes   int `json:"processes"`
	IDs         int `json:"ids"`
	Blocks      int `json:"blocks"`
	Punishments int `json:"punishments"`
	Allowances  int `json:"allowances"`
	Schedules   int `json:"schedules"`
	Limits      int `json:"limits"`
}

// EndpointSpec mirrors EndpointSpec: one route of the guardian API.
type EndpointSpec struct {
	ID string `json:"id"`
	// Method is GET, POST, PUT or DELETE.
	Method string `json:"method"`
	// Path is the path template; {id} is an id segment.
	Path string `json:"path"`
	// Auth is none, app, ext or app_or_ext.
	Auth string `json:"auth"`
	// IdempotencyKey: the route accepts Idempotency-Key.
	IdempotencyKey bool `json:"idempotencyKey"`
	// LongPoll: the route supports waitMs long polling.
	LongPoll bool `json:"longPoll"`
	// TestOnly: compiled only with the testhooks build tag.
	TestOnly bool `json:"testOnly"`
}

// GuardianSettings mirrors GuardianSettings (the fresh-install defaults in api.json).
type GuardianSettings struct {
	// Timezone is nil in the defaults: the guardian writes the OS zone at first start.
	Timezone                      *string                `json:"timezone"`
	DailyGoalMinutes              int                    `json:"dailyGoalMinutes"`
	AttemptPenalties              bool                   `json:"attemptPenalties"`
	Punishment                    PunishmentPolicy       `json:"punishment"`
	CloseBrowsersWithoutExtension bool                   `json:"closeBrowsersWithoutExtension"`
	ServerTimeCheck               bool                   `json:"serverTimeCheck"`
	StudyWhitelist                StudyWhitelistSettings `json:"studyWhitelist"`
}

// PunishmentPolicy mirrors PunishmentPolicy.
type PunishmentPolicy struct {
	// Level is distractions, whitelist or nuclear.
	Level   string `json:"level"`
	Minutes int    `json:"minutes"`
}

// StudyWhitelistSettings are the user's additions to the catalog study whitelist.
type StudyWhitelistSettings struct {
	ExtraDomains   []string `json:"extraDomains"`
	ExtraProcesses []string `json:"extraProcesses"`
}

// Clone returns a deep copy that shares no memory with s.
func (s GuardianSettings) Clone() GuardianSettings {
	out := s
	if s.Timezone != nil {
		tz := *s.Timezone
		out.Timezone = &tz
	}
	out.StudyWhitelist.ExtraDomains = cloneStrings(s.StudyWhitelist.ExtraDomains)
	out.StudyWhitelist.ExtraProcesses = cloneStrings(s.StudyWhitelist.ExtraProcesses)
	return out
}

// cloneStrings copies a list, keeping an empty list non-nil (it encodes as [], not null).
func cloneStrings(s []string) []string {
	if s == nil {
		return nil
	}
	return append(make([]string, 0, len(s)), s...)
}

// ---------------------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------------------

// Hashes are the sourceSha256 values of the embedded files, for diagnostics.
type Hashes struct {
	Catalog string
	Rules   string
	API     string
}

var (
	catalog CatalogSnapshot
	rules   RulesSnapshot
	api     APIContractSnapshot
	hashes  Hashes
)

func init() {
	var err error
	if hashes.Catalog, err = decodeFile("catalog.json", catalogJSON, &catalog); err != nil {
		panic(mismatch(err))
	}
	if hashes.Rules, err = decodeFile("rules.json", rulesJSON, &rules); err != nil {
		panic(mismatch(err))
	}
	if hashes.API, err = decodeFile("api.json", apiJSON, &api); err != nil {
		panic(mismatch(err))
	}
}

func mismatch(err error) string {
	return "embedded: generated data does not match the Go types in guardian/internal/embedded: " +
		err.Error() + " (never edit the JSON by hand: run `npm run gen:guardian`, then update " +
		"embedded.go so it mirrors packages/shared field by field)"
}

// Catalog returns the embedded catalog (read-only).
func Catalog() *CatalogSnapshot { return &catalog }

// Rules returns the embedded points, emergency and study rules (read-only).
func Rules() *RulesSnapshot { return &rules }

// API returns the embedded API contract: limits, routes, error statuses, capabilities,
// problems and default settings (read-only).
func API() *APIContractSnapshot { return &api }

// SourceHashes returns the sourceSha256 of each embedded file.
func SourceHashes() Hashes { return hashes }

// Millis converts an embedded millisecond value (the *Ms fields) to a time.Duration.
func Millis(ms int) time.Duration { return time.Duration(ms) * time.Millisecond }

// Minutes converts an embedded minute value (the *Minutes fields) to a time.Duration.
func Minutes(m int) time.Duration { return time.Duration(m) * time.Minute }

// ---------------------------------------------------------------------------------------
// Strict decoding
// ---------------------------------------------------------------------------------------

// envelope is the generated file format (see scripts/gen-guardian-data.mjs).
type envelope struct {
	Data         json.RawMessage `json:"data"`
	GeneratedBy  string          `json:"generatedBy"`
	SourceSha256 string          `json:"sourceSha256"`
}

// decodeFile decodes one generated file into v, a pointer to its snapshot struct, and
// returns the file's sourceSha256. It checks the envelope, that sourceSha256 is the
// SHA-256 of the compact data (what the generator hashes), that data has no field v
// lacks, and that re-encoding v yields exactly the same data (no field missing from
// the file, no lossy conversion).
func decodeFile(name string, raw []byte, v any) (string, error) {
	var env envelope
	if err := strictUnmarshal(raw, &env); err != nil {
		return "", fmt.Errorf("%s: envelope: %w", name, err)
	}
	if env.GeneratedBy != GeneratedBy {
		return "", fmt.Errorf("%s: generatedBy is %q, want %q", name, env.GeneratedBy, GeneratedBy)
	}
	trimmed := bytes.TrimSpace(env.Data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return "", fmt.Errorf("%s: data is missing or not an object", name)
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, env.Data); err != nil {
		return "", fmt.Errorf("%s: data: %w", name, err)
	}
	sum := sha256.Sum256(compact.Bytes())
	if got := hex.EncodeToString(sum[:]); got != env.SourceSha256 {
		return "", fmt.Errorf("%s: sourceSha256 is %q but the data hashes to %q (edited by hand?)",
			name, env.SourceSha256, got)
	}
	if err := strictUnmarshal(env.Data, v); err != nil {
		return "", fmt.Errorf("%s: data: %w", name, err)
	}
	if err := checkRoundTrip(env.Data, v); err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	return env.SourceSha256, nil
}

// strictUnmarshal decodes exactly one JSON value, rejecting unknown fields and any
// trailing data.
func strictUnmarshal(data []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after the JSON value")
	}
	return nil
}

// checkRoundTrip compares the generic decoding of data with the generic decoding of v
// re-encoded. It catches what DisallowUnknownFields cannot: a struct field the data
// lacks (TS removed or renamed it), keys that only matched case-insensitively and
// values that do not survive the trip.
func checkRoundTrip(data []byte, v any) error {
	var want any
	if err := json.Unmarshal(data, &want); err != nil {
		return fmt.Errorf("data: %w", err)
	}
	encoded, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("re-encode: %w", err)
	}
	var got any
	if err := json.Unmarshal(encoded, &got); err != nil {
		return fmt.Errorf("re-encode: %w", err)
	}
	if diff := firstDiff("data", want, got); diff != "" {
		return errors.New(diff)
	}
	return nil
}

// firstDiff describes the first difference between the generated data (want) and the
// re-encoded struct (got), or returns "" when they are equal.
func firstDiff(path string, want, got any) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return fmt.Sprintf("%s: the Go struct has %s where the data has an object", path, kind(got))
		}
		keys := make([]string, 0, len(w)+len(g))
		for k := range w {
			keys = append(keys, k)
		}
		for k := range g {
			if _, dup := w[k]; !dup {
				keys = append(keys, k)
			}
		}
		slices.Sort(keys)
		for _, k := range keys {
			wv, inWant := w[k]
			gv, inGot := g[k]
			switch {
			case !inGot:
				return fmt.Sprintf("%s.%s: in the data but not in the Go struct", path, k)
			case !inWant:
				return fmt.Sprintf("%s.%s: in the Go struct but not in the data", path, k)
			}
			if d := firstDiff(path+"."+k, wv, gv); d != "" {
				return d
			}
		}
		return ""
	case []any:
		g, ok := got.([]any)
		if !ok {
			return fmt.Sprintf("%s: the Go struct has %s where the data has an array", path, kind(got))
		}
		if len(w) != len(g) {
			return fmt.Sprintf("%s: %d items in the data, %d after decoding", path, len(w), len(g))
		}
		for i := range w {
			if d := firstDiff(fmt.Sprintf("%s[%d]", path, i), w[i], g[i]); d != "" {
				return d
			}
		}
		return ""
	default:
		if !reflect.DeepEqual(want, got) {
			return fmt.Sprintf("%s: the data has %s %v, the Go struct %s %v",
				path, kind(want), want, kind(got), got)
		}
		return ""
	}
}

func kind(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case map[string]any:
		return "an object"
	case []any:
		return "an array"
	case string:
		return "a string"
	case float64:
		return "a number"
	case bool:
		return "a boolean"
	}
	return fmt.Sprintf("%T", v)
}
