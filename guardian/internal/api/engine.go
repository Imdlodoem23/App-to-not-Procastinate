package api

import (
	"context"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// Engine is what the API layer needs from the guardian engine: one typed method per
// command (docs/ARCHITECTURE.md §8.7), each running in one engine turn, plus the
// lifecycle signals. *engine.Engine implements it; tests may pass a fake.
type Engine interface {
	// Ready is closed once the startup ladder finished (OpenErr tells how).
	Ready() <-chan struct{}
	OpenErr() error

	Health(ctx context.Context) (engine.HealthResponse, error)
	State(ctx context.Context) (engine.GuardianStateResponse, error)
	Diagnostics(ctx context.Context) (engine.DiagnosticsResponse, error)
	Points(ctx context.Context) (engine.PointsResponse, error)
	Events(ctx context.Context, q engine.EventsQuery) (engine.EventsResponse, error)

	CreateBlock(ctx context.Context, r engine.Request, req engine.CreateBlockRequest) (engine.CreateBlockResponse, error)
	ListBlocks(ctx context.Context, q engine.ListBlocksQuery) (engine.ListBlocksResponse, error)
	GetBlock(ctx context.Context, id string) (engine.GetBlockResponse, error)
	ExtendBlock(ctx context.Context, r engine.Request, id string, req engine.ExtendBlockRequest) (engine.ExtendBlockResponse, error)

	ListSchedules(ctx context.Context) (engine.ListSchedulesResponse, error)
	CreateSchedule(ctx context.Context, r engine.Request, in engine.ScheduleInput) (engine.ScheduleResponse, error)
	UpdateSchedule(ctx context.Context, r engine.Request, id string, in engine.ScheduleInput) (engine.ScheduleResponse, error)
	DeleteSchedule(ctx context.Context, r engine.Request, id string) error

	StartStudy(ctx context.Context, r engine.Request, req engine.StartStudyRequest) (engine.StudySessionResponse, error)
	CurrentStudy(ctx context.Context) (engine.CurrentStudyResponse, error)
	GetStudySession(ctx context.Context, id string) (engine.StudySessionDetail, error)
	StudyHeartbeat(ctx context.Context, r engine.Request, id string, req engine.HeartbeatRequest) (engine.HeartbeatResponse, error)
	StudyStrike(ctx context.Context, r engine.Request, id string, req engine.StrikeRequest) (engine.StrikeResponse, error)
	PauseStudy(ctx context.Context, r engine.Request, id string) (engine.StudySessionResponse, error)
	ResumeStudy(ctx context.Context, r engine.Request, id string) (engine.StudySessionResponse, error)
	EndStudy(ctx context.Context, r engine.Request, id string, req engine.EndStudyRequest) (engine.EndStudyResponse, error)
	SetStudyOutcome(ctx context.Context, r engine.Request, id string, req engine.StudyOutcomeRequest) (engine.StudySessionResponse, error)
	NuclearHeartbeat(ctx context.Context, r engine.Request, req engine.NuclearHeartbeatRequest) (engine.NuclearHeartbeatResponse, error)

	ReportAttempt(ctx context.Context, r engine.Request, req engine.AttemptRequest) (engine.AttemptResponse, error)

	EmergencyPreview(ctx context.Context, blockIDs []string) (engine.EmergencyPreviewResponse, error)
	RequestEmergency(ctx context.Context, r engine.Request, req engine.EmergencyRequest) (engine.EmergencyResponse, error)
	CancelEmergency(ctx context.Context, r engine.Request, id string) (engine.EmergencyResponse, error)
	ConfirmEmergency(ctx context.Context, r engine.Request, id string, req engine.ConfirmEmergencyRequest) (engine.ConfirmEmergencyResponse, error)

	ListRewards(ctx context.Context) (engine.RewardsResponse, error)
	RedeemReward(ctx context.Context, r engine.Request, req engine.RedeemRewardRequest) (engine.RedeemRewardResponse, error)

	GetSettings(ctx context.Context) (engine.SettingsResponse, error)
	UpdateSettings(ctx context.Context, r engine.Request, s engine.GuardianSettings) (engine.SettingsResponse, error)

	CreatePairingCode(ctx context.Context, r engine.Request) (engine.PairingCodeResponse, error)
	ClaimPairing(ctx context.Context, peer engine.PairingPeer, req engine.PairingClaimRequest) (engine.PairingClaimResponse, error)
	ListExtensions(ctx context.Context) (engine.PairedExtensionsResponse, error)
	RevokeExtension(ctx context.Context, r engine.Request, id string) error
	AuthenticateExtension(ctx context.Context, token string) (engine.ExtensionAuth, bool)
	ExtHeartbeat(ctx context.Context, r engine.Request, peer engine.PairingPeer, req engine.ExtHeartbeatRequest) (engine.ExtHeartbeatResponse, error)
	GetExtRules(ctx context.Context, r engine.Request, q engine.ExtRulesQuery) (engine.SignedExtRules, error)

	DeleteData(ctx context.Context, r engine.Request, req engine.DeleteDataRequest) (engine.DeleteDataResponse, error)
}

// TestClocker is the fake-clock command of testhooks builds (POST /v1/_test/clock).
// *engine.Engine implements it; the route exists only with the testhooks build tag.
type TestClocker interface {
	TestClock(ctx context.Context, req engine.TestClockRequest) (engine.TestClockResponse, error)
}

var (
	_ Engine      = (*engine.Engine)(nil)
	_ TestClocker = (*engine.Engine)(nil)
)
