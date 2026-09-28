package engine

// OWNER: rewards teammate (docs/ARCHITECTURE.md §5.7, §10.7, §8.8 «Rewards»).
//
// The reward shop sells time on one catalog service (REWARD_OFFERS, embedded). An
// allowance opens exactly that service's catalog domains and processes (the core's
// enforcement reads activeAllowanceServiceIDs), totals at most allowanceMaxMinutes per
// service (redeeming the same service again extends it), ends at T ≥ endsAt
// (reward_ended{expired}) and is revoked with a pro-rata refund when a hardcore or exam
// block or a punishment starts (reward_ended{revoked}). While any allowance is active
// the core does not credit the blocks it opens, and the allowances' current worth
// (allowanceValue) counts as balance for the emergency penalty.

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/imdlodoem23/centrate/guardian/internal/catalog"
	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Allowance statuses (ALLOWANCE_STATUSES) and reward_ended reasons.
const (
	allowanceActive  = "active"
	allowanceExpired = "expired"
	allowanceRevoked = "revoked"
)

// Rewards lock reasons (REWARDS_LOCK_REASONS; hardcore and exam are the block modes) and
// offer unavailability reasons (RewardOfferStatus.unavailableReason). Error codes stay
// literal in the apiErr calls, where TestErrorCodesAreEmbedded checks them.
const (
	rewardsLockEmergency  = "emergency"
	rewardsLockPunishment = "punishment"
	rewardsLockStudy      = "study"

	offerNotBlocked     = "not_blocked"
	offerInsufficient   = "insufficient_points"
	offerLocked         = "locked"
	offerAllowanceLimit = "allowance_limit"
)

// rewardsState is the persisted rewards state (state.json "engine.rewards"): the active
// allowances (an allowance leaves the state when it ends; ended ones appear nowhere in
// the API).
type rewardsState struct {
	Allowances []*allowanceRec `json:"allowances"`
}

// allowanceRec is an active RewardAllowance in trusted Unix ms.
type allowanceRec struct {
	ID string `json:"id"`
	// OfferID is the offer of the first redemption.
	OfferID   string `json:"offerId"`
	ServiceID string `json:"serviceId"`
	// Minutes and Cost are the totals of every redemption.
	Minutes   int64 `json:"minutes"`
	Cost      int64 `json:"cost"`
	StartedAt int64 `json:"startedAt"`
	EndsAt    int64 `json:"endsAt"`
}

// RewardOfferStatus mirrors RewardOfferStatus.
type RewardOfferStatus struct {
	OfferID           string  `json:"offerId"`
	ServiceID         string  `json:"serviceId"`
	Minutes           int64   `json:"minutes"`
	Cost              int64   `json:"cost"`
	Affordable        bool    `json:"affordable"`
	ShortBy           int64   `json:"shortBy"`
	Available         bool    `json:"available"`
	UnavailableReason *string `json:"unavailableReason"`
}

// RewardsResponse mirrors RewardsResponse.
type RewardsResponse struct {
	Locked     bool                `json:"locked"`
	LockReason *string             `json:"lockReason"`
	Balance    int64               `json:"balance"`
	Offers     []RewardOfferStatus `json:"offers"`
	Allowances []RewardAllowance   `json:"allowances"`
}

// RedeemRewardRequest mirrors RedeemRewardRequest.
type RedeemRewardRequest struct {
	OfferID string `json:"offerId"`
}

// RedeemRewardResponse mirrors RedeemRewardResponse.
type RedeemRewardResponse struct {
	Allowance    RewardAllowance `json:"allowance"`
	PointsDelta  int64           `json:"pointsDelta"`
	BalanceAfter int64           `json:"balanceAfter"`
}

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

// allowance returns the active allowance with that id, or nil.
func (e *Engine) allowance(id string) *allowanceRec {
	for _, a := range e.state.Rewards.Allowances {
		if a.ID == id {
			return a
		}
	}
	return nil
}

// serviceAllowance returns the active allowance of a service, or nil.
func (e *Engine) serviceAllowance(serviceID string) *allowanceRec {
	for _, a := range e.state.Rewards.Allowances {
		if a.ServiceID == serviceID {
			return a
		}
	}
	return nil
}

// liveAllowances are the allowances in force at T. An allowance whose expiry could not
// be logged yet (a full disk) stops opening its service at endsAt anyway.
func (e *Engine) liveAllowances(T int64) []*allowanceRec {
	out := make([]*allowanceRec, 0, len(e.state.Rewards.Allowances))
	for _, a := range e.state.Rewards.Allowances {
		if a.EndsAt > T {
			out = append(out, a)
		}
	}
	return out
}

// allowanceWire converts an allowance (offsetMs as in blockWire).
func allowanceWire(a *allowanceRec, offsetMs int64) RewardAllowance {
	return RewardAllowance{
		ID:        a.ID,
		OfferID:   a.OfferID,
		ServiceID: a.ServiceID,
		Minutes:   a.Minutes,
		Cost:      a.Cost,
		StartedAt: fmtMs(a.StartedAt + offsetMs),
		EndsAt:    fmtMs(a.EndsAt + offsetMs),
		Status:    allowanceActive,
		Refund:    0,
	}
}

// serviceCovered reports whether an active block blocks the service now (§10.7
// service_not_blocked): it lists the service (directly or through a category), one of
// its catalog domains or app processes, or it is a whitelist-only block whose allow set
// leaves one of the service's domains blocked.
func (e *Engine) serviceCovered(serviceID string) bool {
	svc := e.cat.Service(serviceID)
	if svc == nil {
		return false
	}
	var procs []string
	for _, aid := range svc.AppIDs {
		if a := e.cat.App(aid); a != nil {
			procs = append(procs, a.Processes.For(string(e.platform))...)
		}
	}
	for _, b := range e.activeBlocks() {
		if b.WhitelistOnly {
			if b.WL == nil {
				return true
			}
			for _, d := range svc.Domains {
				if !catalog.IsDomainAllowedInWhitelist(d, b.WL.Domains, b.WL.HostPatterns) {
					return true
				}
			}
			continue
		}
		if slices.Contains(b.Resolved.ServiceIDs, serviceID) {
			return true
		}
		if slices.ContainsFunc(svc.Domains, func(d string) bool { return slices.Contains(b.Resolved.Domains, d) }) {
			return true
		}
		if slices.ContainsFunc(procs, func(p string) bool { return containsProcess(b.Resolved.Processes, p, e.platform) }) {
			return true
		}
	}
	return false
}

// endedInBatch reports whether b already ends the allowance (a batch may revoke twice,
// e.g. two hardcore blocks created together; a second refund must never be emitted).
func endedInBatch(b *batch, allowanceID string) bool {
	for i := range b.events {
		if b.events[i].Type != EvRewardEnded {
			continue
		}
		var d RewardEndedData
		if err := json.Unmarshal(b.events[i].Data, &d); err == nil && d.AllowanceID == allowanceID {
			return true
		}
	}
	return false
}

// addRewardEnded adds reward_ended for an allowance at the batch time: the refund
// inputs are the allowance totals, its span and what is left of it (§6.1).
func addRewardEnded(b *batch, a *allowanceRec, reason string, byBlockID *string) {
	total := max(0, a.EndsAt-a.StartedAt)
	remaining := min(max(0, a.EndsAt-b.at), total)
	refund := int64(0)
	if reason == allowanceRevoked {
		refund = points.AllowanceRefund(a.Cost, total, remaining)
	} else {
		remaining = 0
	}
	b.add(EvRewardEnded, RewardEndedData{
		AllowanceID:      a.ID,
		ServiceID:        a.ServiceID,
		Reason:           reason,
		RevokedByBlockID: byBlockID,
		Cost:             a.Cost,
		TotalMs:          total,
		RemainingMs:      remaining,
		Refund:           refund,
	})
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

// ListRewards is GET /v1/rewards.
func (e *Engine) ListRewards(ctx context.Context) (RewardsResponse, error) {
	return run(e, ctx, cmdOpts{}, func() (RewardsResponse, error) { return e.listRewards() })
}

// listRewards is the shop: every embedded offer with what redeeming it now would answer.
func (e *Engine) listRewards() (RewardsResponse, error) {
	lock := e.rewardsLock()
	balance := e.state.Ledger.Balance
	maxMin := int64(limits().AllowanceMaxMinutes)
	res := RewardsResponse{
		Locked:     lock != "",
		LockReason: strPtrOrNil(lock),
		Balance:    balance,
		Offers:     []RewardOfferStatus{},
		Allowances: nonNil(e.allowancesWire(e.wallOffsetMs())),
	}
	for _, o := range points.DefaultRewardOffers() {
		cost, minutes := int64(o.Cost), int64(o.Minutes)
		st := RewardOfferStatus{
			OfferID:    o.ID,
			ServiceID:  o.ServiceID,
			Minutes:    minutes,
			Cost:       cost,
			Affordable: balance >= cost,
			ShortBy:    max(0, cost-balance),
		}
		var current int64
		if a := e.serviceAllowance(o.ServiceID); a != nil {
			current = a.Minutes
		}
		switch {
		case lock != "":
			st.UnavailableReason = ptr(offerLocked)
		case !e.serviceCovered(o.ServiceID):
			st.UnavailableReason = ptr(offerNotBlocked)
		case !st.Affordable:
			st.UnavailableReason = ptr(offerInsufficient)
		case current+minutes > maxMin:
			st.UnavailableReason = ptr(offerAllowanceLimit)
		default:
			st.Available = true
		}
		res.Offers = append(res.Offers, st)
	}
	return res, nil
}

// RedeemReward is POST /v1/rewards/redeem (idempotent, 201).
func (e *Engine) RedeemReward(ctx context.Context, r Request, req RedeemRewardRequest) (RedeemRewardResponse, error) {
	return run(e, ctx, cmdOpts{write: true, idem: r.Idem, status: 201}, func() (RedeemRewardResponse, error) {
		return e.redeemReward(req)
	})
}

// redeemReward buys an offer (§10.7): a known offer, the shop open, the service blocked
// right now, enough balance and the service's allowance within allowanceMaxMinutes. It
// opens a new allowance or extends the service's active one; the charge is this offer's
// cost (the allowance totals go into the event too).
func (e *Engine) redeemReward(req RedeemRewardRequest) (RedeemRewardResponse, error) {
	if n := catalog.UTF16Len(req.OfferID); n < 1 || n > 64 {
		return RedeemRewardResponse{}, issueErr("offerId", "length", "length in [1, 64]")
	}
	if !catalogIDRE.MatchString(req.OfferID) {
		return RedeemRewardResponse{}, issueErr("offerId", "pattern", "invalid format")
	}
	o, ok := points.FindRewardOffer(req.OfferID, points.DefaultRewardOffers())
	if !ok {
		return RedeemRewardResponse{}, apiErr("unknown_offer", "no reward offer with that id", map[string]any{"offerId": req.OfferID})
	}
	if lock := e.rewardsLock(); lock != "" {
		return RedeemRewardResponse{}, apiErr("rewards_locked", "the reward shop is locked right now", map[string]any{"reason": lock})
	}
	if !e.serviceCovered(o.ServiceID) {
		return RedeemRewardResponse{}, apiErr("service_not_blocked", "no active block blocks this service", map[string]any{"serviceId": o.ServiceID})
	}
	cost, minutes := int64(o.Cost), int64(o.Minutes)
	if balance := e.state.Ledger.Balance; balance < cost {
		return RedeemRewardResponse{}, apiErr("insufficient_points", "not enough points",
			map[string]any{"balance": balance, "cost": cost, "shortBy": cost - balance})
	}
	maxMin := int64(limits().AllowanceMaxMinutes)
	a := e.serviceAllowance(o.ServiceID)
	var current int64
	if a != nil {
		current = a.Minutes
	}
	if current+minutes > maxMin {
		return RedeemRewardResponse{}, apiErr("allowance_limit_reached", "the service's allowance would exceed its maximum",
			map[string]any{"maxMinutes": maxMin, "currentMinutes": current})
	}
	b := e.newBatch()
	d := RewardRedeemedData{
		OfferID:      o.ID,
		ServiceID:    o.ServiceID,
		OfferMinutes: minutes,
		OfferCost:    cost,
	}
	if a == nil {
		d.AllowanceID = newID("alw")
		d.AllowanceMinutes, d.AllowanceCost = minutes, cost
		d.EndsAt = fmtMs(b.at + minutes*msPerMinute)
	} else {
		d.AllowanceID = a.ID
		d.AllowanceMinutes, d.AllowanceCost = a.Minutes+minutes, a.Cost+cost
		d.EndsAt = fmtMs(a.EndsAt + minutes*msPerMinute)
		d.ExtendedExisting = true
	}
	pts := b.add(EvRewardRedeemed, d)
	if err := e.commit(b); err != nil {
		return RedeemRewardResponse{}, err
	}
	rec := e.allowance(d.AllowanceID)
	if rec == nil {
		return RedeemRewardResponse{}, apiErr("internal", "the allowance was not recorded", nil)
	}
	return RedeemRewardResponse{
		Allowance:    allowanceWire(rec, e.wallOffsetMs()),
		PointsDelta:  pts,
		BalanceAfter: e.state.Ledger.Balance,
	}, nil
}

// ---------------------------------------------------------------------------------------
// Hooks the core calls
// ---------------------------------------------------------------------------------------

// expireAllowances ends allowances whose endsAt passed (reward_ended{expired}, refund 0)
// in one batch; never held by the boot hold.
func (e *Engine) expireAllowances(T int64) {
	var due []*allowanceRec
	for _, a := range e.state.Rewards.Allowances {
		if T >= a.EndsAt {
			due = append(due, a)
		}
	}
	if len(due) == 0 {
		return
	}
	b := e.newBatch()
	for _, a := range due {
		addRewardEnded(b, a, allowanceExpired, nil)
	}
	e.commitNow(b, "reward_ended{expired}")
}

// activeAllowanceServiceIDs are the services an active allowance opens right now.
func (e *Engine) activeAllowanceServiceIDs() []string {
	var out []string
	for _, a := range e.liveAllowances(e.now) {
		if !slices.Contains(out, a.ServiceID) {
			out = append(out, a.ServiceID)
		}
	}
	slices.Sort(out)
	return out
}

// allowancesWire is /v1/state.allowances (active ones, display time with offsetMs = W;
// 0 gives trusted time).
func (e *Engine) allowancesWire(offsetMs int64) []RewardAllowance {
	out := []RewardAllowance{}
	for _, a := range e.liveAllowances(e.now) {
		out = append(out, allowanceWire(a, offsetMs))
	}
	return out
}

// allowanceValue is Σ allowanceRefund of the active allowances at T (§6.1): it counts
// as balance for the emergency penalty and the service_stopped correction.
func (e *Engine) allowanceValue(T int64) int64 {
	worth := make([]points.AllowanceWorth, 0, len(e.state.Rewards.Allowances))
	for _, a := range e.state.Rewards.Allowances {
		worth = append(worth, points.AllowanceWorth{Cost: a.Cost, TotalMs: a.EndsAt - a.StartedAt, RemainingMs: a.EndsAt - T})
	}
	return points.AllowanceValue(worth)
}

// rewardsLock is the shop lock reason or "": an emergency counting or ready, an active
// punishment, an active exam or hardcore block, or an active study session.
func (e *Engine) rewardsLock() string {
	if e.emergencyPending() {
		return rewardsLockEmergency
	}
	active := e.activeBlocks()
	if len(e.activePunishments()) > 0 || slices.ContainsFunc(active, func(b *blockRec) bool { return b.Kind == KindPunishment }) {
		return rewardsLockPunishment
	}
	if slices.ContainsFunc(active, func(b *blockRec) bool { return b.Mode == ModeExam }) {
		return ModeExam
	}
	if slices.ContainsFunc(active, func(b *blockRec) bool { return b.Mode == ModeHardcore }) {
		return ModeHardcore
	}
	if e.studyActive() {
		return rewardsLockStudy
	}
	return ""
}

// addRevokeAllowances adds reward_ended{revoked, revokedByBlockId} with the pro-rata
// refund for every active allowance (a hardcore or exam block or a punishment starts).
// An allowance the batch already ended is skipped.
func (e *Engine) addRevokeAllowances(b *batch, byBlockID string) {
	for _, a := range e.state.Rewards.Allowances {
		if endedInBatch(b, a.ID) {
			continue
		}
		addRewardEnded(b, a, allowanceRevoked, ptr(byBlockID))
	}
}

// allowancesToShift are the active allowances created at or after fromMs (§4
// calibration correction); their ids go into clock_jump{calibrate}.
func (e *Engine) allowancesToShift(fromMs int64) []string {
	var out []string
	for _, a := range e.state.Rewards.Allowances {
		if a.StartedAt >= fromMs {
			out = append(out, a.ID)
		}
	}
	return out
}

// shiftAllowances moves startedAt and endsAt of those allowances by deltaMs (reducer of
// clock_jump{calibrate}).
func (e *Engine) shiftAllowances(ids []string, deltaMs int64) {
	for _, id := range ids {
		if a := e.allowance(id); a != nil {
			a.StartedAt += deltaMs
			a.EndsAt += deltaMs
		}
	}
}

// keptAllowances are the active allowances for epoch_started.kept (trusted time).
func (e *Engine) keptAllowances() []RewardAllowance {
	out := []RewardAllowance{}
	for _, a := range e.state.Rewards.Allowances {
		out = append(out, allowanceWire(a, 0))
	}
	return out
}

// restoreKeptAllowances replaces the allowances with epoch_started.kept.allowances
// (entries that are not active or carry invalid timestamps are dropped).
func (e *Engine) restoreKeptAllowances(list []RewardAllowance) {
	out := []*allowanceRec{}
	for _, w := range list {
		start, ok1 := parseMs(w.StartedAt)
		end, ok2 := parseMs(w.EndsAt)
		if !ok1 || !ok2 || w.Status != allowanceActive || end < start {
			continue
		}
		out = append(out, &allowanceRec{
			ID: w.ID, OfferID: w.OfferID, ServiceID: w.ServiceID, Minutes: w.Minutes, Cost: w.Cost, StartedAt: start, EndsAt: end,
		})
	}
	e.state.Rewards.Allowances = out
}

// ---------------------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------------------

// applyRewardRedeemed opens an allowance (startedAt = the event's time) or extends the
// service's active one to the totals of the event.
func (e *Engine) applyRewardRedeemed(ev *storeEvent) error {
	d, err := decode[RewardRedeemedData](ev)
	if err != nil {
		return err
	}
	end, ok := parseMs(d.EndsAt)
	if !ok {
		return fmt.Errorf("seq %d: reward_redeemed: invalid endsAt", ev.Seq)
	}
	if a := e.allowance(d.AllowanceID); a != nil {
		if !d.ExtendedExisting {
			return fmt.Errorf("seq %d: allowance %s exists", ev.Seq, d.AllowanceID)
		}
		a.Minutes, a.Cost, a.EndsAt = d.AllowanceMinutes, d.AllowanceCost, end
		return nil
	}
	if d.ExtendedExisting {
		return fmt.Errorf("seq %d: extended allowance %s unknown", ev.Seq, d.AllowanceID)
	}
	e.state.Rewards.Allowances = append(e.state.Rewards.Allowances, &allowanceRec{
		ID:        d.AllowanceID,
		OfferID:   d.OfferID,
		ServiceID: d.ServiceID,
		Minutes:   d.AllowanceMinutes,
		Cost:      d.AllowanceCost,
		StartedAt: atMs(ev),
		EndsAt:    end,
	})
	return nil
}

// applyRewardEnded removes an ended allowance (its refund is the event's recorded delta).
func (e *Engine) applyRewardEnded(ev *storeEvent) error {
	d, err := decode[RewardEndedData](ev)
	if err != nil {
		return err
	}
	n := len(e.state.Rewards.Allowances)
	e.state.Rewards.Allowances = slices.DeleteFunc(e.state.Rewards.Allowances, func(a *allowanceRec) bool { return a.ID == d.AllowanceID })
	if len(e.state.Rewards.Allowances) == n {
		return fmt.Errorf("seq %d: reward_ended: allowance %s is not active", ev.Seq, d.AllowanceID)
	}
	return nil
}
