package engine

import (
	"encoding/json"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Wire types: Go mirrors of packages/shared/src/domain.ts and of the core responses of
// packages/shared/src/guardian-api.ts. Field names and JSON tags follow the TypeScript
// exactly; absent values are null (pointers) and lists are never null (the builders
// below always allocate them). Timestamps are wire strings (YYYY-MM-DDTHH:MM:SS.sssZ):
// display time in API responses, trusted time inside events (§4).

// Enumerations of domain.ts used by the core.
const (
	KindManual     = "manual"
	KindSchedule   = "schedule"
	KindPunishment = "punishment"
	KindRecovered  = "recovered"
	// KindLimit is a block a daily limit materialized (§5.10): guardian-only, never
	// earning. Extension tokens see it as manual with limitId set (§8.4).
	KindLimit = "limit"

	ModeNormal   = "normal"
	ModeStrict   = "strict"
	ModeHardcore = "hardcore"
	ModeExam     = "exam"

	StatusActive             = "active"
	StatusCompleted          = "completed"
	StatusCancelledEmergency = "cancelled_emergency"

	TrustVerified   = "verified"
	TrustUnverified = "unverified"
	TrustDisabled   = "disabled"

	ModeGuardianNormal = "normal"
	ModeGuardianFrozen = "frozen"
	ModeGuardianSafe   = "safe"
)

// blockModes and categoryIDs are the closed sets the validators check.
var blockModes = []string{ModeNormal, ModeStrict, ModeHardcore, ModeExam}

// TargetSpec mirrors TargetSpec.
type TargetSpec struct {
	ServiceIDs      []string `json:"serviceIds"`
	CategoryIDs     []string `json:"categoryIds"`
	AppIDs          []string `json:"appIds"`
	CustomDomains   []string `json:"customDomains"`
	CustomProcesses []string `json:"customProcesses"`
}

// WhitelistAllow mirrors WhitelistAllow.
type WhitelistAllow struct {
	CustomDomains   []string `json:"customDomains"`
	CustomProcesses []string `json:"customProcesses"`
}

// Block mirrors Block.
type Block struct {
	ID                string         `json:"id"`
	Kind              string         `json:"kind"`
	Mode              string         `json:"mode"`
	Status            string         `json:"status"`
	Targets           TargetSpec     `json:"targets"`
	WhitelistOnly     bool           `json:"whitelistOnly"`
	Allow             WhitelistAllow `json:"allow"`
	Reason            string         `json:"reason"`
	CreatedAt         string         `json:"createdAt"`
	StartsAt          string         `json:"startsAt"`
	EndsAt            string         `json:"endsAt"`
	OriginalEndsAt    string         `json:"originalEndsAt"`
	EndedAt           *string        `json:"endedAt"`
	ExtendedMinutes   int64          `json:"extendedMinutes"`
	ScheduleID        *string        `json:"scheduleId"`
	PunishmentID      *string        `json:"punishmentId"`
	LimitID           *string        `json:"limitId"`
	AttemptsCounted   int64          `json:"attemptsCounted"`
	EmergencyEligible bool           `json:"emergencyEligible"`
	PointsDelta       *int64         `json:"pointsDelta"`
}

// NextOccurrence is Schedule.nextOccurrence.
type NextOccurrence struct {
	StartsAt string `json:"startsAt"`
	EndsAt   string `json:"endsAt"`
}

// Schedule mirrors Schedule.
type Schedule struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Enabled        bool            `json:"enabled"`
	Days           []int           `json:"days"`
	Start          string          `json:"start"`
	End            string          `json:"end"`
	Timezone       string          `json:"timezone"`
	Targets        TargetSpec      `json:"targets"`
	WhitelistOnly  bool            `json:"whitelistOnly"`
	Allow          WhitelistAllow  `json:"allow"`
	Mode           string          `json:"mode"`
	Reason         string          `json:"reason"`
	CreatedAt      string          `json:"createdAt"`
	UpdatedAt      string          `json:"updatedAt"`
	NextOccurrence *NextOccurrence `json:"nextOccurrence"`
	ActiveBlockID  *string         `json:"activeBlockId"`
}

// PomodoroSpec mirrors PomodoroSpec.
type PomodoroSpec struct {
	WorkMinutes  int64 `json:"workMinutes"`
	BreakMinutes int64 `json:"breakMinutes"`
}

// PunishmentPolicy mirrors PunishmentPolicy (the embedded type, same JSON).
type PunishmentPolicy = embedded.PunishmentPolicy

// StudySession mirrors StudySession.
type StudySession struct {
	ID                   string           `json:"id"`
	Task                 string           `json:"task"`
	PlannedMinutes       int64            `json:"plannedMinutes"`
	Pomodoro             *PomodoroSpec    `json:"pomodoro"`
	Camera               bool             `json:"camera"`
	Status               string           `json:"status"`
	Phase                string           `json:"phase"`
	PhaseEndsAt          *string          `json:"phaseEndsAt"`
	StartedAt            string           `json:"startedAt"`
	PlannedEndsAt        string           `json:"plannedEndsAt"`
	EndedAt              *string          `json:"endedAt"`
	ActiveMinutes        int64            `json:"activeMinutes"`
	FocusedMinutes       int64            `json:"focusedMinutes"`
	Strikes              int64            `json:"strikes"`
	Attempts             int64            `json:"attempts"`
	CooldownUntil        *string          `json:"cooldownUntil"`
	PausesLeft           int64            `json:"pausesLeft"`
	NextPauseAvailableAt *string          `json:"nextPauseAvailableAt"`
	LastHeartbeatAt      *string          `json:"lastHeartbeatAt"`
	LastHeartbeatSeq     int64            `json:"lastHeartbeatSeq"`
	Warnings             int64            `json:"warnings"`
	Policy               PunishmentPolicy `json:"policy"`
	Achieved             *string          `json:"achieved"`
}

// StudySummary mirrors StudySummary («Resumen»).
type StudySummary struct {
	Outcome        string `json:"outcome"`
	ActiveMinutes  int64  `json:"activeMinutes"`
	WorkMinutes    int64  `json:"workMinutes"`
	FocusedMinutes int64  `json:"focusedMinutes"`
	FocusPct       int64  `json:"focusPct"`
	Strikes        int64  `json:"strikes"`
	Warnings       int64  `json:"warnings"`
	Attempts       int64  `json:"attempts"`
	PointsTotal    int64  `json:"pointsTotal"`
	CleanBonus     int64  `json:"cleanBonus"`
}

// StudySessionDetail mirrors StudySessionDetail (summary null while active).
type StudySessionDetail struct {
	Session StudySession  `json:"session"`
	Summary *StudySummary `json:"summary"`
}

// Punishment mirrors Punishment.
type Punishment struct {
	ID        string  `json:"id"`
	BlockID   string  `json:"blockId"`
	SessionID *string `json:"sessionId"`
	Task      string  `json:"task"`
	Cause     string  `json:"cause"`
	Level     string  `json:"level"`
	Minutes   int64   `json:"minutes"`
	StartsAt  string  `json:"startsAt"`
	EndsAt    string  `json:"endsAt"`
	Status    string  `json:"status"`
	EndedAt   *string `json:"endedAt"`
}

// EmergencyUnlock mirrors EmergencyUnlock.
type EmergencyUnlock struct {
	ID               string   `json:"id"`
	BlockIDs         []string `json:"blockIds"`
	Status           string   `json:"status"`
	CountdownMinutes int64    `json:"countdownMinutes"`
	RequestedAt      string   `json:"requestedAt"`
	ReadyAt          string   `json:"readyAt"`
	ConfirmBy        *string  `json:"confirmBy"`
	PenaltyPreview   int64    `json:"penaltyPreview"`
	StreakDaysAtRisk int64    `json:"streakDaysAtRisk"`
	ResolvedAt       *string  `json:"resolvedAt"`
	CancelReason     *string  `json:"cancelReason"`
}

// RewardAllowance mirrors RewardAllowance.
type RewardAllowance struct {
	ID        string  `json:"id"`
	OfferID   string  `json:"offerId"`
	ServiceID string  `json:"serviceId"`
	Minutes   int64   `json:"minutes"`
	Cost      int64   `json:"cost"`
	StartedAt string  `json:"startedAt"`
	EndsAt    string  `json:"endsAt"`
	Status    string  `json:"status"`
	EndedAt   *string `json:"endedAt"`
	Refund    int64   `json:"refund"`
}

// EscalationState mirrors EscalationState.
type EscalationState struct {
	LastCountedAt *string `json:"lastCountedAt"`
	Index         int64   `json:"index"`
}

// GuardianSettings mirrors GuardianSettings (the embedded type, same JSON).
type GuardianSettings = embedded.GuardianSettings

// PendingSettingChange mirrors PendingSettingChange: Value's JSON type depends on Field
// (string|null, number, boolean or string[]).
type PendingSettingChange struct {
	Field       string          `json:"field"`
	Value       json.RawMessage `json:"value"`
	EffectiveAt string          `json:"effectiveAt"`
}

// PointsSummary mirrors PointsSummary (the points package type, same JSON).
type PointsSummary = points.PointsSummary

// EpochKeptState mirrors EpochKeptState (trusted times, inside epoch_started).
type EpochKeptState struct {
	Blocks                  []Block                `json:"blocks"`
	Punishments             []Punishment           `json:"punishments"`
	Allowances              []RewardAllowance      `json:"allowances"`
	Schedules               []Schedule             `json:"schedules"`
	Settings                GuardianSettings       `json:"settings"`
	PendingSettings         []PendingSettingChange `json:"pendingSettings"`
	MaterializedOccurrences []string               `json:"materializedOccurrences"`
	// Limits is every daily limit with its pending change and today's usage (absent in
	// epochs started before daily limits: read it as empty).
	Limits []DailyLimit `json:"limits"`
	// KeepAwake is the keep-awake configuration (absent in epochs started before
	// keep-awake: read it as DEFAULT_KEEP_AWAKE).
	KeepAwake *KeepAwakeConfig `json:"keepAwake,omitempty"`
}

// ---------------------------------------------------------------------------------------
// Core API requests and responses (guardian-api.ts)
// ---------------------------------------------------------------------------------------

// HealthResponse mirrors HealthResponse (GET /v1/health).
type HealthResponse struct {
	OK             bool     `json:"ok"`
	Name           string   `json:"name"`
	Version        string   `json:"version"`
	APIVersion     int      `json:"apiVersion"`
	Capabilities   []string `json:"capabilities"`
	SchemaVersion  int      `json:"schemaVersion"`
	CatalogVersion int      `json:"catalogVersion"`
	RulesVersion   int      `json:"rulesVersion"`
	StartedAt      string   `json:"startedAt"`
	ServerNow      string   `json:"serverNow"`
	Mode           string   `json:"mode"`
	Problems       []string `json:"problems"`
}

// ClockJumpInfo is ClockStatus.lastJump.
type ClockJumpInfo struct {
	At      string `json:"at"`
	DeltaMs int64  `json:"deltaMs"`
	Source  string `json:"source"`
}

// ClockStatus mirrors ClockStatus.
type ClockStatus struct {
	WallOffsetMs     int64          `json:"wallOffsetMs"`
	Trust            string         `json:"trust"`
	LastJump         *ClockJumpInfo `json:"lastJump"`
	LastCalibratedAt *string        `json:"lastCalibratedAt"`
	BootHoldUntil    *string        `json:"bootHoldUntil"`
}

// ExtensionStatus mirrors ExtensionStatus.
type ExtensionStatus struct {
	ID                     string  `json:"id"`
	Browser                string  `json:"browser"`
	ExtVersion             string  `json:"extVersion"`
	Connected              bool    `json:"connected"`
	LastSeenAt             *string `json:"lastSeenAt"`
	IncognitoAllowed       bool    `json:"incognitoAllowed"`
	HostPermission         bool    `json:"hostPermission"`
	AppliedExtRulesVersion int64   `json:"appliedExtRulesVersion"`
	Protecting             bool    `json:"protecting"`
}

// HostsProtection is ProtectionStatus.hosts.
type HostsProtection struct {
	OK            bool    `json:"ok"`
	Status        string  `json:"status"`
	Entries       int     `json:"entries"`
	LastAppliedAt *string `json:"lastAppliedAt"`
}

// WatcherProtection is ProtectionStatus.processWatcher.
type WatcherProtection struct {
	OK bool `json:"ok"`
}

// ProtectionStatus mirrors ProtectionStatus.
type ProtectionStatus struct {
	Hosts                    HostsProtection   `json:"hosts"`
	ProcessWatcher           WatcherProtection `json:"processWatcher"`
	Extensions               []ExtensionStatus `json:"extensions"`
	BrowsersWithoutExtension []string          `json:"browsersWithoutExtension"`
}

// EndedBlockNotice mirrors EndedBlockNotice.
type EndedBlockNotice struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Mode        string `json:"mode"`
	Outcome     string `json:"outcome"`
	EndedAt     string `json:"endedAt"`
	PointsDelta int64  `json:"pointsDelta"`
}

// NextScheduleInfo mirrors NextScheduleInfo.
type NextScheduleInfo struct {
	ScheduleID string `json:"scheduleId"`
	Name       string `json:"name"`
	StartsAt   string `json:"startsAt"`
	EndsAt     string `json:"endsAt"`
}

// GuardianInfo is GuardianStateResponse.guardian.
type GuardianInfo struct {
	Version    string   `json:"version"`
	APIVersion int      `json:"apiVersion"`
	Mode       string   `json:"mode"`
	Problems   []string `json:"problems"`
}

// RecentInfo is GuardianStateResponse.recent.
type RecentInfo struct {
	EndedBlocks []EndedBlockNotice  `json:"endedBlocks"`
	EndedStudy  *StudySessionDetail `json:"endedStudy"`
}

// GuardianStateResponse mirrors GuardianStateResponse (GET /v1/state). The API layer
// answers `If-None-Match: "s-<StateVersion>"` with 304.
type GuardianStateResponse struct {
	StateVersion    int64                  `json:"stateVersion"`
	ServerNow       string                 `json:"serverNow"`
	Epoch           string                 `json:"epoch"`
	LastEventSeq    int64                  `json:"lastEventSeq"`
	Guardian        GuardianInfo           `json:"guardian"`
	Clock           ClockStatus            `json:"clock"`
	Protection      ProtectionStatus       `json:"protection"`
	Blocks          []Block                `json:"blocks"`
	Punishments     []Punishment           `json:"punishments"`
	NuclearActive   bool                   `json:"nuclearActive"`
	Study           *StudySession          `json:"study"`
	Emergency       *EmergencyUnlock       `json:"emergency"`
	Allowances      []RewardAllowance      `json:"allowances"`
	RewardsLock     *string                `json:"rewardsLock"`
	NextSchedule    *NextScheduleInfo      `json:"nextSchedule"`
	Limits          []DailyLimit           `json:"limits"`
	KeepAwake       *KeepAwakeState        `json:"keepAwake,omitempty"`
	Points          PointsSummary          `json:"points"`
	PendingSettings []PendingSettingChange `json:"pendingSettings"`
	Recent          RecentInfo             `json:"recent"`
}

// DiagnosticsGuardian is DiagnosticsResponse.guardian.
type DiagnosticsGuardian struct {
	Version        string `json:"version"`
	Commit         string `json:"commit"`
	GoVersion      string `json:"goVersion"`
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	ServiceManager string `json:"serviceManager"`
	PID            int    `json:"pid"`
	Port           int    `json:"port"`
	StartedAt      string `json:"startedAt"`
	UptimeMs       int64  `json:"uptimeMs"`
	Mode           string `json:"mode"`
}

// DiagnosticsState is DiagnosticsResponse.state.
type DiagnosticsState struct {
	SchemaVersion int    `json:"schemaVersion"`
	Epoch         string `json:"epoch"`
	LastEventSeq  int64  `json:"lastEventSeq"`
	Integrity     string `json:"integrity"`
	StateBytes    int64  `json:"stateBytes"`
	EventsBytes   int64  `json:"eventsBytes"`
}

// CalibrationInfo is DiagnosticsResponse.clock.lastCalibration.
type CalibrationInfo struct {
	At      string `json:"at"`
	OK      bool   `json:"ok"`
	DeltaMs int64  `json:"deltaMs"`
	Sources int    `json:"sources"`
}

// DiagnosticsClock is DiagnosticsResponse.clock.
type DiagnosticsClock struct {
	WallOffsetMs    int64            `json:"wallOffsetMs"`
	Trust           string           `json:"trust"`
	BootClock       string           `json:"bootClock"`
	AwakeClock      string           `json:"awakeClock"`
	Jumps24h        int              `json:"jumps24h"`
	LastCalibration *CalibrationInfo `json:"lastCalibration"`
}

// FlushInfo is DiagnosticsResponse.hosts.lastFlush.
type FlushInfo struct {
	At     string `json:"at"`
	OK     bool   `json:"ok"`
	Method string `json:"method"`
}

// DiagnosticsHosts is DiagnosticsResponse.hosts.
type DiagnosticsHosts struct {
	Path           string     `json:"path"`
	PathOverridden bool       `json:"pathOverridden"`
	Status         string     `json:"status"`
	Entries        int        `json:"entries"`
	LastWriteAt    *string    `json:"lastWriteAt"`
	LastVerifyAt   *string    `json:"lastVerifyAt"`
	Tamper24h      int        `json:"tamper24h"`
	LastFlush      *FlushInfo `json:"lastFlush"`
}

// DiagnosticsWatcher is DiagnosticsResponse.processWatcher.
type DiagnosticsWatcher struct {
	IntervalMs int64 `json:"intervalMs"`
	LastScanMs int64 `json:"lastScanMs"`
	Kills24h   int   `json:"kills24h"`
}

// DiagnosticsError is one DiagnosticsResponse.errors entry.
type DiagnosticsError struct {
	Code   string `json:"code"`
	Count  int    `json:"count"`
	LastAt string `json:"lastAt"`
}

// DiagnosticsResponse mirrors DiagnosticsResponse: no domains, reasons, tasks or
// usernames.
type DiagnosticsResponse struct {
	Guardian       DiagnosticsGuardian `json:"guardian"`
	State          DiagnosticsState    `json:"state"`
	Clock          DiagnosticsClock    `json:"clock"`
	Hosts          DiagnosticsHosts    `json:"hosts"`
	ProcessWatcher DiagnosticsWatcher  `json:"processWatcher"`
	Extensions     []ExtensionStatus   `json:"extensions"`
	CatalogVersion int                 `json:"catalogVersion"`
	RulesVersion   int                 `json:"rulesVersion"`
	Errors         []DiagnosticsError  `json:"errors"`
}

// CreateBlockRequest mirrors CreateBlockRequest (POST /v1/blocks).
type CreateBlockRequest struct {
	Targets                TargetSpec     `json:"targets"`
	WhitelistOnly          bool           `json:"whitelistOnly"`
	Allow                  WhitelistAllow `json:"allow"`
	Mode                   string         `json:"mode"`
	DurationMinutes        *int64         `json:"durationMinutes"`
	EndsAt                 *string        `json:"endsAt"`
	Reason                 string         `json:"reason"`
	AcknowledgeLong        bool           `json:"acknowledgeLong"`
	AcknowledgeNoEmergency bool           `json:"acknowledgeNoEmergency"`
}

// CreateBlockResponse mirrors CreateBlockResponse (201).
type CreateBlockResponse struct {
	Block        Block `json:"block"`
	StateVersion int64 `json:"stateVersion"`
}

// ListBlocksQuery mirrors ListBlocksQuery. Status "" means active; Limit 0 means the
// default.
type ListBlocksQuery struct {
	Status string
	Cursor string
	Limit  int
}

// ListBlocksResponse mirrors ListBlocksResponse.
type ListBlocksResponse struct {
	Blocks     []Block `json:"blocks"`
	NextCursor *string `json:"nextCursor"`
}

// BlockProgress mirrors BlockProgress.
type BlockProgress struct {
	CreditedMinutes int64 `json:"creditedMinutes"`
	DowntimeMs      int64 `json:"downtimeMs"`
}

// GetBlockResponse mirrors GetBlockResponse.
type GetBlockResponse struct {
	Block    Block         `json:"block"`
	Progress BlockProgress `json:"progress"`
}

// ExtendBlockRequest mirrors ExtendBlockRequest.
type ExtendBlockRequest struct {
	AddMinutes int64 `json:"addMinutes"`
}

// ExtendBlockResponse mirrors ExtendBlockResponse.
type ExtendBlockResponse struct {
	Block        Block `json:"block"`
	StateVersion int64 `json:"stateVersion"`
}

// PointsResponse mirrors PointsResponse.
type PointsResponse struct {
	Points PointsSummary `json:"points"`
}

// EventsQuery mirrors EventsQuery. Nil After, Limit and WaitMs select the defaults.
type EventsQuery struct {
	Epoch  string
	After  *int64
	Limit  *int
	WaitMs *int
}

// EventsResponse mirrors EventsResponse. Events are the wire lines (envelope, type and
// data in disk order, without prevMac and mac; trusted timestamps).
type EventsResponse struct {
	Epoch   string            `json:"epoch"`
	Reset   bool              `json:"reset"`
	Events  []json.RawMessage `json:"events"`
	LastSeq int64             `json:"lastSeq"`
	HasMore bool              `json:"hasMore"`
}

// TestClockRequest mirrors TestClockRequest (testhooks builds only).
type TestClockRequest struct {
	AdvanceMs *int64 `json:"advanceMs"`
	SuspendMs *int64 `json:"suspendMs"`
	JumpMs    *int64 `json:"jumpMs"`
	Reboot    bool   `json:"reboot"`
}

// TestClockResponse mirrors TestClockResponse.
type TestClockResponse struct {
	ServerNow  string `json:"serverNow"`
	TrustedNow string `json:"trustedNow"`
}

// EncodeResponse is the JSON encoding of every response body. The API layer must use
// it so that idempotent replays (§8.6), whose bodies the engine stores, are byte for
// byte what was first sent.
func EncodeResponse(v any) ([]byte, error) {
	return json.Marshal(v)
}

// emptyTargets and emptyAllow are the all-empty lists (never null).
func emptyTargets() TargetSpec {
	return TargetSpec{ServiceIDs: []string{}, CategoryIDs: []string{}, AppIDs: []string{}, CustomDomains: []string{}, CustomProcesses: []string{}}
}

func emptyAllow() WhitelistAllow {
	return WhitelistAllow{CustomDomains: []string{}, CustomProcesses: []string{}}
}

// normalized returns t with every nil list replaced by an empty one (and copies).
func (t TargetSpec) normalized() TargetSpec {
	return TargetSpec{
		ServiceIDs:      cloneList(t.ServiceIDs),
		CategoryIDs:     cloneList(t.CategoryIDs),
		AppIDs:          cloneList(t.AppIDs),
		CustomDomains:   cloneList(t.CustomDomains),
		CustomProcesses: cloneList(t.CustomProcesses),
	}
}

func (a WhitelistAllow) normalized() WhitelistAllow {
	return WhitelistAllow{CustomDomains: cloneList(a.CustomDomains), CustomProcesses: cloneList(a.CustomProcesses)}
}

func (t TargetSpec) count() int {
	return len(t.ServiceIDs) + len(t.CategoryIDs) + len(t.AppIDs) + len(t.CustomDomains) + len(t.CustomProcesses)
}

func (a WhitelistAllow) count() int { return len(a.CustomDomains) + len(a.CustomProcesses) }

// cloneList copies s, never returning nil.
func cloneList[T any](s []T) []T {
	out := make([]T, len(s))
	copy(out, s)
	return out
}
