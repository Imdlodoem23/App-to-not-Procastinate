package engine

import (
	"github.com/imdlodoem23/centrate/guardian/internal/clock"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// engineState is everything the engine owns, persisted as the "engine" member of
// state.json (§11.1) and rebuildable from the event log (except the few counters noted).
// Trusted times are Unix milliseconds (int64): exact, and what the ledger uses.
//
// Each feature file owns one sub-struct (Study, Emergency, Rewards, Schedules,
// SettingsExt, Attempts, Pairing, ExtRules, Limits) and may add fields to it freely; the core
// never reads their fields directly, only through the hooks the files define.
type engineState struct {
	// LastEventSeq is the last event of the current epoch applied to this state.
	Epoch        string `json:"epoch"`
	LastEventSeq int64  `json:"lastEventSeq"`

	Versions versions           `json:"versions"`
	Ledger   points.LedgerState `json:"ledger"`

	// Blocks are the active blocks and those that ended within endedBlocksHistory.
	Blocks      []*blockRec      `json:"blocks"`
	Punishments []*punishmentRec `json:"punishments"`
	// NextRank orders blocks by creation (crediting ties: earliest created wins).
	NextRank int64 `json:"nextRank"`

	// Settings are the effective settings (settings.go applies settings_changed).
	Settings GuardianSettings `json:"settings"`

	// OpenDay is the local day of the last step: the day day_closed closes next (§6.3).
	OpenDay string `json:"openDay"`

	Clock clockState `json:"clock"`

	// HostsHash is the SHA-256 of the last section written (§10.12 step 9), and
	// HostsPendingHash that of a write still running when the state was saved (it may
	// land after the stop): a section equal to either is ours.
	HostsHash        string `json:"hostsHash"`
	HostsPendingHash string `json:"hostsPendingHash,omitempty"`

	Study       studyState     `json:"study"`
	Emergency   emergencyState `json:"emergency"`
	Rewards     rewardsState   `json:"rewards"`
	Schedules   schedulesState `json:"schedules"`
	SettingsExt settingsState  `json:"settingsExt"`
	Attempts    attemptsState  `json:"attempts"`
	Pairing     pairingState   `json:"pairing"`
	ExtRules    extRulesState  `json:"extRules"`
	Limits      limitsState    `json:"limits"`
}

// versions are the ETag counters (§8.5): persisted and strictly increasing across
// restarts, epochs and state loss.
type versions struct {
	State    int64 `json:"state"`
	ExtRules int64 `json:"extRules"`
}

// blockRec is a block as the engine keeps it: the Block fields in trusted time plus
// what only the guardian needs (resolution, credit, downtime).
type blockRec struct {
	ID              string         `json:"id"`
	Kind            string         `json:"kind"`
	Mode            string         `json:"mode"`
	Status          string         `json:"status"`
	Targets         TargetSpec     `json:"targets"`
	WhitelistOnly   bool           `json:"whitelistOnly"`
	Allow           WhitelistAllow `json:"allow"`
	Reason          string         `json:"reason"`
	CreatedAt       int64          `json:"createdAt"`
	StartsAt        int64          `json:"startsAt"`
	EndsAt          int64          `json:"endsAt"`
	OriginalEndsAt  int64          `json:"originalEndsAt"`
	EndedAt         *int64         `json:"endedAt"`
	ExtendedMinutes int64          `json:"extendedMinutes"`
	ScheduleID      *string        `json:"scheduleId"`
	PunishmentID    *string        `json:"punishmentId"`
	LimitID         *string        `json:"limitId,omitempty"`
	AttemptsCounted int64          `json:"attemptsCounted"`
	PointsDelta     *int64         `json:"pointsDelta"`

	// Rank is the creation order.
	Rank int64 `json:"rank"`
	// Resolved is what the block enforces on this OS, fixed at creation (§5.2).
	Resolved resolvedTargets `json:"resolved"`
	// WL is the whitelist allow set snapshotted at creation (whitelist-only blocks).
	WL *whitelistSet `json:"wl,omitempty"`
	// CreditedMs is the awake time credited to this block only (§10.9).
	CreditedMs int64 `json:"creditedMs"`
	// DowntimeMs is the time the guardian was not running while the block was active.
	DowntimeMs int64 `json:"downtimeMs"`
	// CompletedSeq is the seq of its block_completed (for resurrection).
	CompletedSeq int64 `json:"completedSeq,omitempty"`
}

// resolvedTargets are a block's concrete targets on this OS.
type resolvedTargets struct {
	Domains         []string `json:"domains"`
	ExcludedDomains []string `json:"excludedDomains"`
	Processes       []string `json:"processes"`
	// ServiceIDs are the catalog services it blocks (categories expanded).
	ServiceIDs []string `json:"serviceIds"`
}

// whitelistSet is the allow set of a whitelist-only block: the catalog study whitelist,
// the settings extras and the block's allow, plus always-allowed hosts (§5.2).
type whitelistSet struct {
	Domains      []string `json:"domains"`
	HostPatterns []string `json:"hostPatterns"`
	Processes    []string `json:"processes"`
}

// punishmentRec is a Punishment in trusted time.
type punishmentRec struct {
	ID        string  `json:"id"`
	BlockID   string  `json:"blockId"`
	SessionID *string `json:"sessionId"`
	Task      string  `json:"task"`
	Cause     string  `json:"cause"`
	Level     string  `json:"level"`
	Minutes   int64   `json:"minutes"`
	StartsAt  int64   `json:"startsAt"`
	EndsAt    int64   `json:"endsAt"`
	Status    string  `json:"status"`
	EndedAt   *int64  `json:"endedAt"`
}

// clockState is the persisted part of the time model (§10.2).
type clockState struct {
	// Trust is verified only after a successful calibration in the boot TrustBootID.
	Trust       string `json:"trust"`
	TrustBootID string `json:"trustBootId"`
	// LastJump and LastCalibratedAt feed /v1/state.clock (trusted ms).
	LastJump         *jumpRec `json:"lastJump"`
	LastCalibratedAt *int64   `json:"lastCalibratedAt"`
	// Jumps are the trusted times of recent jumps (diagnostics.jumps24h).
	Jumps []int64 `json:"jumps"`
	// Restore is the restore jump of the last reboot, kept until a calibration
	// resolves it (§4, §10.2).
	Restore *restoreJump `json:"restore"`
	// Unverified are completions a later calibration may resurrect (§10.2).
	Unverified []unverifiedCompletion `json:"unverified"`
	// Snapshot is the Detector snapshot saved with the state (also in run/clock.json).
	Snapshot *clock.Snapshot `json:"snapshot,omitempty"`
}

type jumpRec struct {
	AtMs    int64  `json:"at"`
	DeltaMs int64  `json:"deltaMs"`
	Source  string `json:"source"`
}

// restoreJump: after a reboot the trusted clock restarted at RestoredT from a saved
// SavedT; deadlines created at or after RestoredT move back with a calibration.
type restoreJump struct {
	SavedT    int64 `json:"savedT"`
	RestoredT int64 `json:"restoredT"`
}

// unverifiedCompletion is a completion a restore jump crossed without a time check.
type unverifiedCompletion struct {
	BlockID string `json:"blockId"`
	Seq     int64  `json:"seq"`
	EndsAt  int64  `json:"endsAt"`
	Points  int64  `json:"points"`
	Kind    string `json:"kind"`
	Mode    string `json:"mode"`
}

// newEngineState is the state before the first epoch_started.
func newEngineState() engineState {
	return engineState{
		Ledger:      points.InitialLedgerState(),
		Blocks:      []*blockRec{},
		Punishments: []*punishmentRec{},
		Settings:    embeddedDefaultSettings(),
		Clock:       clockState{Trust: TrustUnverified},
	}
}

// ---------------------------------------------------------------------------------------
// Enforcement core (§11.5): frozen forever at v1 so any guardian version, and the
// has-active command with the service stopped, can enforce and expire blocks from it.
// ---------------------------------------------------------------------------------------

// enforcementCore is state.json's "enforcement" member.
type enforcementCore struct {
	V     int                   `json:"v"`
	Clock *clock.Snapshot       `json:"clock"`
	Items []enforcementCoreItem `json:"items"`
}

// enforcementCoreItem is one active block. Kind and Mode are additive fields (v1
// readers ignore them) that let has-active tell exit code 11 from 10 (§13).
type enforcementCoreItem struct {
	ID              string   `json:"id"`
	EndsAtTrusted   string   `json:"endsAtTrusted"`
	Domains         []string `json:"domains"`
	ExcludedDomains []string `json:"excludedDomains"`
	Processes       []string `json:"processes"`
	Whitelist       bool     `json:"whitelist"`
	AllowDomains    []string `json:"allowDomains"`
	Kind            string   `json:"kind,omitempty"`
	Mode            string   `json:"mode,omitempty"`
}
