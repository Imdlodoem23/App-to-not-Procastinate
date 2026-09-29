package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// handlerTable maps every endpoint id of api.json to its handler (the testOnly ones
// are added by testOnlyHandlers in testhooks builds). The success statuses are those
// of docs/ARCHITECTURE.md §8.8; idempotent routes store the same status in the engine.
func handlerTable() map[string]handlerSpec {
	m := map[string]handlerSpec{
		"health":   {serve: hHealth},
		"getState": {serve: hState},
		"diagnostics": {serve: readCmd(func(c *call) (engine.DiagnosticsResponse, error) {
			return c.s.eng.Diagnostics(c.ctx)
		})},

		"createBlock": {write: true, serve: bodyCmd(http.StatusCreated, func(c *call, req engine.CreateBlockRequest) (engine.CreateBlockResponse, error) {
			return c.s.eng.CreateBlock(c.ctx, c.request(), req)
		})},
		"listBlocks": {query: []string{"status", "cursor", "limit"}, serve: hListBlocks},
		"getBlock": {serve: readCmd(func(c *call) (engine.GetBlockResponse, error) {
			return c.s.eng.GetBlock(c.ctx, c.id)
		})},
		"extendBlock": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, req engine.ExtendBlockRequest) (engine.ExtendBlockResponse, error) {
			return c.s.eng.ExtendBlock(c.ctx, c.request(), c.id, req)
		})},

		"listSchedules": {serve: readCmd(func(c *call) (engine.ListSchedulesResponse, error) {
			return c.s.eng.ListSchedules(c.ctx)
		})},
		"createSchedule": {write: true, serve: bodyCmd(http.StatusCreated, func(c *call, in engine.ScheduleInput) (engine.ScheduleResponse, error) {
			return c.s.eng.CreateSchedule(c.ctx, c.request(), in)
		})},
		"updateSchedule": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, in engine.ScheduleInput) (engine.ScheduleResponse, error) {
			return c.s.eng.UpdateSchedule(c.ctx, c.request(), c.id, in)
		})},
		"deleteSchedule": {write: true, serve: deleteCmd(func(c *call) error {
			return c.s.eng.DeleteSchedule(c.ctx, c.request(), c.id)
		})},

		// Daily limits (§5.10, §8.8). DELETE never deletes at once: it answers 200 with the
		// limit and its pending deletion.
		"listLimits": {serve: readCmd(func(c *call) (engine.ListLimitsResponse, error) {
			return c.s.eng.ListLimits(c.ctx)
		})},
		"createLimit": {write: true, serve: bodyCmd(http.StatusCreated, func(c *call, in engine.DailyLimitInput) (engine.LimitResponse, error) {
			return c.s.eng.CreateLimit(c.ctx, c.request(), in)
		})},
		"updateLimit": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, in engine.DailyLimitInput) (engine.LimitResponse, error) {
			return c.s.eng.UpdateLimit(c.ctx, c.request(), c.id, in)
		})},
		"deleteLimit": {write: true, serve: readCmd(func(c *call) (engine.LimitResponse, error) {
			return c.s.eng.DeleteLimit(c.ctx, c.request(), c.id)
		})},
		// A usage report is not a user-initiated write: accepted in safe mode (§8.3 step
		// 6), refused by the engine in frozen mode.
		"reportUsage": {serve: bodyCmd(http.StatusOK, func(c *call, req engine.UsageReportRequest) (engine.UsageReportResponse, error) {
			return c.s.eng.ReportUsage(c.ctx, c.request(), req)
		})},

		"startStudy": {write: true, serve: bodyCmd(http.StatusCreated, func(c *call, req engine.StartStudyRequest) (engine.StudySessionResponse, error) {
			return c.s.eng.StartStudy(c.ctx, c.request(), req)
		})},
		"currentStudy": {serve: readCmd(func(c *call) (engine.CurrentStudyResponse, error) {
			return c.s.eng.CurrentStudy(c.ctx)
		})},
		"getStudySession": {serve: readCmd(func(c *call) (engine.StudySessionDetail, error) {
			return c.s.eng.GetStudySession(c.ctx, c.id)
		})},
		"studyHeartbeat": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, req engine.HeartbeatRequest) (engine.HeartbeatResponse, error) {
			return c.s.eng.StudyHeartbeat(c.ctx, c.request(), c.id, req)
		})},
		"studyStrike": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, req engine.StrikeRequest) (engine.StrikeResponse, error) {
			return c.s.eng.StudyStrike(c.ctx, c.request(), c.id, req)
		})},
		"pauseStudy": {write: true, serve: emptyCmd(http.StatusOK, func(c *call) (engine.StudySessionResponse, error) {
			return c.s.eng.PauseStudy(c.ctx, c.request(), c.id)
		})},
		"resumeStudy": {write: true, serve: emptyCmd(http.StatusOK, func(c *call) (engine.StudySessionResponse, error) {
			return c.s.eng.ResumeStudy(c.ctx, c.request(), c.id)
		})},
		"endStudy": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, req engine.EndStudyRequest) (engine.EndStudyResponse, error) {
			return c.s.eng.EndStudy(c.ctx, c.request(), c.id, req)
		})},
		"setStudyOutcome": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, req engine.StudyOutcomeRequest) (engine.StudySessionResponse, error) {
			return c.s.eng.SetStudyOutcome(c.ctx, c.request(), c.id, req)
		})},

		"reportAttempt": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, req engine.AttemptRequest) (engine.AttemptResponse, error) {
			return c.s.eng.ReportAttempt(c.ctx, c.request(), req)
		})},
		"getPoints": {serve: readCmd(func(c *call) (engine.PointsResponse, error) {
			return c.s.eng.Points(c.ctx)
		})},
		"getEvents": {query: []string{"epoch", "after", "limit", "waitMs"}, serve: hEvents},

		"emergencyPreview": {query: []string{"blockIds"}, serve: readCmd(func(c *call) (engine.EmergencyPreviewResponse, error) {
			ids, err := c.query.listParam("blockIds")
			if err != nil {
				return engine.EmergencyPreviewResponse{}, err
			}
			return c.s.eng.EmergencyPreview(c.ctx, ids)
		})},
		"requestEmergency": {write: true, serve: bodyCmd(http.StatusCreated, func(c *call, req engine.EmergencyRequest) (engine.EmergencyResponse, error) {
			return c.s.eng.RequestEmergency(c.ctx, c.request(), req)
		})},
		"cancelEmergency": {write: true, serve: emptyCmd(http.StatusOK, func(c *call) (engine.EmergencyResponse, error) {
			return c.s.eng.CancelEmergency(c.ctx, c.request(), c.id)
		})},
		"confirmEmergency": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, req engine.ConfirmEmergencyRequest) (engine.ConfirmEmergencyResponse, error) {
			return c.s.eng.ConfirmEmergency(c.ctx, c.request(), c.id, req)
		})},

		"listRewards": {serve: readCmd(func(c *call) (engine.RewardsResponse, error) {
			return c.s.eng.ListRewards(c.ctx)
		})},
		"redeemReward": {write: true, serve: bodyCmd(http.StatusCreated, func(c *call, req engine.RedeemRewardRequest) (engine.RedeemRewardResponse, error) {
			return c.s.eng.RedeemReward(c.ctx, c.request(), req)
		})},

		"getSettings": {serve: readCmd(func(c *call) (engine.SettingsResponse, error) {
			return c.s.eng.GetSettings(c.ctx)
		})},
		"updateSettings": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, s engine.GuardianSettings) (engine.SettingsResponse, error) {
			return c.s.eng.UpdateSettings(c.ctx, c.request(), s)
		})},

		"createPairingCode": {write: true, serve: emptyCmd(http.StatusCreated, func(c *call) (engine.PairingCodeResponse, error) {
			return c.s.eng.CreatePairingCode(c.ctx, c.request())
		})},
		"claimPairing": {write: true, peer: peerBrowser, serve: bodyCmd(http.StatusCreated, func(c *call, req engine.PairingClaimRequest) (engine.PairingClaimResponse, error) {
			return c.s.eng.ClaimPairing(c.ctx, c.peer, req)
		})},
		"listExtensions": {serve: readCmd(func(c *call) (engine.PairedExtensionsResponse, error) {
			return c.s.eng.ListExtensions(c.ctx)
		})},
		"revokeExtension": {write: true, serve: deleteCmd(func(c *call) error {
			return c.s.eng.RevokeExtension(c.ctx, c.request(), c.id)
		})},
		"getExtRules": {query: []string{"nonce", "waitVersion", "waitMs"}, serve: hExtRules},
		"extHeartbeat": {peer: peerBrowser, serve: bodyCmd(http.StatusOK, func(c *call, req engine.ExtHeartbeatRequest) (engine.ExtHeartbeatResponse, error) {
			return c.s.eng.ExtHeartbeat(c.ctx, c.request(), c.peer, req)
		})},
		"nuclearHeartbeat": {peer: peerApp, serve: bodyCmd(http.StatusOK, func(c *call, req engine.NuclearHeartbeatRequest) (engine.NuclearHeartbeatResponse, error) {
			return c.s.eng.NuclearHeartbeat(c.ctx, c.request(), req)
		})},

		"deleteData": {write: true, serve: bodyCmd(http.StatusOK, func(c *call, req engine.DeleteDataRequest) (engine.DeleteDataResponse, error) {
			return c.s.eng.DeleteData(c.ctx, c.request(), req)
		})},
	}
	for id, h := range testOnlyHandlers() {
		m[id] = h
	}
	return m
}

// ---------------------------------------------------------------------------------------
// Handler shapes
// ---------------------------------------------------------------------------------------

// bodyCmd serves a command with a JSON body: strict decoding (§8.3 step 7), the
// Idempotency-Key on idempotent routes (step 8), then the engine turn.
func bodyCmd[Req, Res any](status int, fn func(c *call, req Req) (Res, error)) func(*call) {
	return func(c *call) {
		req, aerr := decodeBody[Req](c.body)
		if aerr != nil {
			c.fail(aerr)
			return
		}
		if aerr := c.prepareIdempotency(); aerr != nil {
			c.fail(aerr)
			return
		}
		res, err := fn(c, req)
		c.respond(status, res, err)
	}
}

// emptyCmd serves a command whose body must be {} (EmptyRequest).
func emptyCmd[Res any](status int, fn func(c *call) (Res, error)) func(*call) {
	return bodyCmd(status, func(c *call, _ struct{}) (Res, error) { return fn(c) })
}

// readCmd serves a query (GET, no body) answered with 200.
func readCmd[Res any](fn func(c *call) (Res, error)) func(*call) {
	return func(c *call) {
		res, err := fn(c)
		c.respond(http.StatusOK, res, err)
	}
}

// deleteCmd serves a DELETE answered with 204.
func deleteCmd(fn func(c *call) error) func(*call) {
	return func(c *call) {
		if err := fn(c); err != nil {
			c.fail(err)
			return
		}
		c.noContent()
	}
}

// ---------------------------------------------------------------------------------------
// Handlers with headers of their own
// ---------------------------------------------------------------------------------------

// hHealth is GET /v1/health (no token). It also refreshes the cached guardian mode.
func hHealth(c *call) {
	res, err := c.s.eng.Health(c.ctx)
	if err == nil {
		c.s.noteMode(res.Mode)
	}
	c.respond(http.StatusOK, res, err)
}

// hState is GET /v1/state: ETag "s-<stateVersion>"; If-None-Match naming it → 304
// without a body (§8.5).
func hState(c *call) {
	res, err := c.s.eng.State(c.ctx)
	if err != nil {
		c.fail(err)
		return
	}
	c.s.noteMode(res.Guardian.Mode)
	c.conditional(`"s-`+strconv.FormatInt(res.StateVersion, 10)+`"`, func() { c.ok(http.StatusOK, res) })
}

// hListBlocks is GET /v1/blocks?status=&cursor=&limit=.
func hListBlocks(c *call) {
	q := engine.ListBlocksQuery{Status: c.query["status"], Cursor: c.query["cursor"]}
	if _, ok := c.query["status"]; ok && q.Status == "" {
		c.fail(badQuery("status must be active or ended"))
		return
	}
	if _, ok := c.query["cursor"]; ok && q.Cursor == "" {
		c.fail(badQuery("cursor must not be empty"))
		return
	}
	limit, aerr := c.query.intParam("limit")
	if aerr != nil {
		c.fail(aerr)
		return
	}
	if limit != nil {
		// Zero means «default» to the engine, so an explicit limit must be positive.
		if *limit < 1 || *limit > embedded.API().Limits.BlocksPageMax {
			c.fail(badQuery("limit out of range"))
			return
		}
		q.Limit = *limit
	}
	res, err := c.s.eng.ListBlocks(c.ctx, q)
	c.respond(http.StatusOK, res, err)
}

// hEvents is GET /v1/events?epoch=&after=&limit=&waitMs= (long poll, §8.5).
func hEvents(c *call) {
	q := engine.EventsQuery{Epoch: c.query["epoch"]}
	var aerr error
	if q.After, aerr = nilErr(c.query.int64Param("after")); aerr != nil {
		c.fail(aerr)
		return
	}
	if q.Limit, aerr = nilErr(c.query.intParam("limit")); aerr != nil {
		c.fail(aerr)
		return
	}
	if q.WaitMs, aerr = nilErr(c.query.intParam("waitMs")); aerr != nil {
		c.fail(aerr)
		return
	}
	if q.WaitMs != nil && *q.WaitMs > 0 {
		release, aerr := c.longPoll(*q.WaitMs)
		if aerr != nil {
			c.fail(aerr)
			return
		}
		defer release()
	}
	res, err := c.s.eng.Events(c.ctx, q)
	c.respond(http.StatusOK, res, err)
}

// hExtRules is GET /v1/ext/rules?nonce=&waitVersion=&waitMs= (ext token): the signed
// body written verbatim with X-Centrate-Signature, ETag "r-<extRulesVersion>" and 304
// when If-None-Match names it (§8.5, §8.8).
func hExtRules(c *call) {
	q := engine.ExtRulesQuery{Nonce: c.query["nonce"]}
	var aerr error
	if q.WaitVersion, aerr = nilErr(c.query.int64Param("waitVersion")); aerr != nil {
		c.fail(aerr)
		return
	}
	wait, aerr := nilErr(c.query.intParam("waitMs"))
	if aerr != nil {
		c.fail(aerr)
		return
	}
	if wait != nil {
		q.WaitMs = *wait
	}
	if q.WaitVersion != nil && q.WaitMs > 0 {
		release, aerr := c.longPoll(q.WaitMs)
		if aerr != nil {
			c.fail(aerr)
			return
		}
		defer release()
	}
	res, err := c.s.eng.GetExtRules(c.ctx, c.request(), q)
	if err != nil {
		c.fail(err)
		return
	}
	c.conditional(`"r-`+strconv.FormatInt(res.Version, 10)+`"`, func() {
		c.w.Header().Set(headerSignature, res.Signature)
		c.writeJSON(http.StatusOK, res.Body)
	})
}

// nilErr turns a typed nil *engine.APIError into a nil error.
func nilErr[T any](v T, err *engine.APIError) (T, error) {
	if err != nil {
		return v, err
	}
	return v, nil
}

// longPollGrace is added to a long poll's wait for its write deadline.
const longPollGrace = writeTimeout

// longPoll reserves one of the token's concurrent long polls (§8.5: 429 beyond) and
// extends the connection's write deadline past the wait (§9.1).
func (c *call) longPoll(waitMs int) (func(), *engine.APIError) {
	key := c.auth.key
	if !c.s.polls.acquire(key) {
		return nil, c.rateLimited(time.Second, "too many concurrent long polls for this token")
	}
	// The engine refuses a wait above longPollMaxMs; the deadline never exceeds it.
	wait := min(waitMs, embedded.API().Limits.LongPollMaxMs)
	rc := http.NewResponseController(c.w)
	_ = rc.SetWriteDeadline(time.Now().Add(time.Duration(wait)*time.Millisecond + longPollGrace))
	return func() { c.s.polls.release(key) }, nil
}
