package engine

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/imdlodoem23/centrate/guardian/internal/points"
)

// Reward shop tests (docs/ARCHITECTURE.md §5.7, §10.7, §8.8 «Rewards»). Helpers are
// prefixed rwd so they never collide with the other feature files' tests.

// rwdGrant adds points to the ledger balance directly. Test shortcut: earning hundreds
// of points with real blocks takes a tick per 10 s of credit and a state.json fsync every
// 30 s. The log does not back these points, so tests using it never rebuild the ledger.
func rwdGrant(env *testEnv, pts int64) {
	_ = env.e.exec(bg, func() {
		env.e.state.Ledger.Balance += pts
		env.e.markDirty(true)
	})
}

// rwdRedeem redeems an offer and fails the test on an error.
func rwdRedeem(t *testing.T, env *testEnv, offerID string) RedeemRewardResponse {
	t.Helper()
	res, err := env.e.RedeemReward(bg, Request{Scope: "app"}, RedeemRewardRequest{OfferID: offerID})
	if err != nil {
		t.Fatalf("RedeemReward(%s): %v", offerID, err)
	}
	return res
}

// rwdOffer returns an embedded offer by id.
func rwdOffer(t *testing.T, id string) points.RewardOffer {
	t.Helper()
	o, ok := points.FindRewardOffer(id, points.DefaultRewardOffers())
	if !ok {
		t.Fatalf("offer %s is not embedded", id)
	}
	return o
}

// rwdStatus returns the shop status of an offer.
func rwdStatus(t *testing.T, r RewardsResponse, id string) RewardOfferStatus {
	t.Helper()
	i := slices.IndexFunc(r.Offers, func(o RewardOfferStatus) bool { return o.OfferID == id })
	if i < 0 {
		t.Fatalf("offer %s not listed", id)
	}
	return r.Offers[i]
}

// rwdServiceHosts reports whether any catalog domain of the service is in the hosts
// section.
func rwdServiceHosts(env *testEnv, serviceID string) bool {
	hosts := env.fh.Domains()
	return slices.ContainsFunc(env.e.cat.Service(serviceID).Domains, func(d string) bool { return slices.Contains(hosts, d) })
}

func TestRewardsShopStatus(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	yt15, yt30 := rwdOffer(t, "youtube-15"), rwdOffer(t, "youtube-30")
	r, err := e.ListRewards(bg)
	if err != nil {
		t.Fatal(err)
	}
	if r.Locked || r.LockReason != nil || r.Balance != 0 || len(r.Allowances) != 0 || len(r.Offers) != len(points.DefaultRewardOffers()) {
		t.Fatalf("empty shop %+v", r)
	}
	for _, o := range r.Offers {
		if o.Available || o.UnavailableReason == nil || *o.UnavailableReason != "not_blocked" || o.Affordable || o.ShortBy != o.Cost {
			t.Fatalf("offer without blocks %+v", o)
		}
	}
	if _, err := e.RedeemReward(bg, Request{}, RedeemRewardRequest{OfferID: yt15.ID}); apiCode(err) != "service_not_blocked" {
		t.Fatalf("redeem without a block: %v", err)
	}
	env.create(durationReq(ModeNormal, 120, "youtube"))
	r, _ = e.ListRewards(bg)
	if st := rwdStatus(t, r, yt15.ID); st.Available || *st.UnavailableReason != "insufficient_points" || st.ShortBy != int64(yt15.Cost) {
		t.Fatalf("youtube-15 without points %+v", st)
	}
	if st := rwdStatus(t, r, "tiktok-15"); *st.UnavailableReason != "not_blocked" {
		t.Fatalf("tiktok-15 %+v", st)
	}
	_, err = e.RedeemReward(bg, Request{}, RedeemRewardRequest{OfferID: yt15.ID})
	if d := apiDetails(err); apiCode(err) != "insufficient_points" || d["balance"] != int64(0) || d["cost"] != int64(yt15.Cost) || d["shortBy"] != int64(yt15.Cost) {
		t.Fatalf("insufficient: %v %v", err, d)
	}
	rwdGrant(env, 200)
	r, _ = e.ListRewards(bg)
	if st := rwdStatus(t, r, yt15.ID); !st.Available || st.UnavailableReason != nil || !st.Affordable || st.ShortBy != 0 {
		t.Fatalf("youtube-15 affordable %+v", st)
	}
	if st := rwdStatus(t, r, yt30.ID); st.Available || st.ShortBy != int64(yt30.Cost)-200 {
		t.Fatalf("youtube-30 %+v", st)
	}
	for _, c := range []struct{ offer, code string }{
		{"", "validation_failed"},
		{"YouTube-15", "validation_failed"},
		{"nope-15", "unknown_offer"},
	} {
		if _, err := e.RedeemReward(bg, Request{}, RedeemRewardRequest{OfferID: c.offer}); apiCode(err) != c.code {
			t.Fatalf("offer %q: %v, want %s", c.offer, err, c.code)
		}
	}
	if len(env.eventsOf(EvRewardRedeemed)) != 0 || e.state.Ledger.Balance != 200 {
		t.Fatal("a refused redemption changed something")
	}
}

// The shop is closed during hardcore, exam, a punishment, Study Mode and a pending
// emergency (§10.7).
func TestRewardsLocks(t *testing.T) {
	cases := []struct {
		reason string
		lock   func(t *testing.T, env *testEnv, youtube Block)
	}{
		{"hardcore", func(t *testing.T, env *testEnv, _ Block) { env.create(durationReq(ModeHardcore, 30, "reddit")) }},
		{"exam", func(t *testing.T, env *testEnv, _ Block) {
			req := durationReq(ModeExam, 30)
			req.WhitelistOnly = true
			env.create(req)
		}},
		{"punishment", func(t *testing.T, env *testEnv, _ Block) { emgPunish(t, env, "distractions", 30) }},
		{"emergency", func(t *testing.T, env *testEnv, youtube Block) { emgRequest(t, env, youtube.ID) }},
		{"study", func(t *testing.T, env *testEnv, _ Block) {
			_, err := env.e.StartStudy(bg, Request{Scope: "app"}, StartStudyRequest{Task: "mates", PlannedMinutes: 30})
			if errors.Is(err, ErrNotImplemented) {
				t.Skip("study.go is still a stub")
			}
			if err != nil {
				t.Fatalf("StartStudy: %v", err)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.reason, func(t *testing.T) {
			env := newTestEnv(t)
			e := env.open()
			rwdGrant(env, 1000)
			yt := env.create(durationReq(ModeNormal, 120, "youtube"))
			c.lock(t, env, yt)
			r, _ := e.ListRewards(bg)
			if !r.Locked || r.LockReason == nil || *r.LockReason != c.reason {
				t.Fatalf("lock %+v", r)
			}
			for _, o := range r.Offers {
				if o.Available || *o.UnavailableReason != "locked" {
					t.Fatalf("offer while locked %+v", o)
				}
			}
			_, err := e.RedeemReward(bg, Request{}, RedeemRewardRequest{OfferID: "youtube-15"})
			if apiCode(err) != "rewards_locked" || apiDetails(err)["reason"] != c.reason {
				t.Fatalf("redeem: %v %v", err, apiDetails(err))
			}
			if s := env.state(); s.RewardsLock == nil || *s.RewardsLock != c.reason {
				t.Fatalf("state lock %v", s.RewardsLock)
			}
		})
	}
}

// An allowance opens exactly its service's catalog domains and processes, earns no block
// credit while it opens the block, and expires at endsAt (§5.7, §10.7, §10.9).
func TestRedeemOpensOnlyThatService(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	proc := discordProcess(t, e)
	rwdGrant(env, 500)
	blk := env.create(durationReq(ModeNormal, 120, "youtube", "instagram", "discord"))
	if !rwdServiceHosts(env, "youtube") || !rwdServiceHosts(env, "discord") || !containsProcess(e.enf.Processes, proc, e.platform) {
		t.Fatal("block not enforced")
	}
	t0 := e.now
	yt15 := rwdOffer(t, "youtube-15")
	span := int64(yt15.Minutes) * msPerMinute
	res := rwdRedeem(t, env, yt15.ID)
	a := res.Allowance
	if a.ServiceID != "youtube" || a.OfferID != yt15.ID || a.Minutes != int64(yt15.Minutes) || a.Cost != int64(yt15.Cost) ||
		a.StartedAt != fmtMs(t0) || a.EndsAt != fmtMs(t0+span) || a.Status != "active" || a.EndedAt != nil || a.Refund != 0 {
		t.Fatalf("allowance %+v", a)
	}
	if res.PointsDelta != -int64(yt15.Cost) || res.BalanceAfter != 500-int64(yt15.Cost) {
		t.Fatalf("redeem %+v", res)
	}
	ev := env.eventsOf(EvRewardRedeemed)
	d := mustDecode[RewardRedeemedData](t, ev[0])
	if len(ev) != 1 || ev[0].Points != -int64(yt15.Cost) || d.AllowanceID != a.ID || d.OfferMinutes != a.Minutes || d.OfferCost != a.Cost ||
		d.AllowanceMinutes != a.Minutes || d.AllowanceCost != a.Cost || d.EndsAt != a.EndsAt || d.ExtendedExisting {
		t.Fatalf("reward_redeemed %+v", d)
	}
	if rwdServiceHosts(env, "youtube") || !rwdServiceHosts(env, "instagram") || !rwdServiceHosts(env, "discord") {
		t.Fatalf("hosts after the redemption: %v", env.fh.Domains())
	}
	if !slices.Equal(e.activeAllowanceServiceIDs(), []string{"youtube"}) {
		t.Fatalf("allowance services %v", e.activeAllowanceServiceIDs())
	}
	if s := env.state(); len(s.Allowances) != 1 || s.Allowances[0].ID != a.ID {
		t.Fatalf("state allowances %+v", s.Allowances)
	}
	// No credit while the allowance opens part of the block.
	credited := e.block(blk.ID).CreditedMs
	env.advance(time.Minute)
	if e.block(blk.ID).CreditedMs != credited {
		t.Fatal("a block an allowance opens was credited")
	}
	// discord-15 exempts Discord's processes too.
	rwdRedeem(t, env, "discord-15")
	if containsProcess(e.enf.Processes, proc, e.platform) || rwdServiceHosts(env, "discord") || !rwdServiceHosts(env, "instagram") {
		t.Fatal("discord allowance not applied")
	}
	// Expiry at endsAt (refund 0); the service is blocked again and credit resumes.
	emgForward(env, time.Duration(span)*time.Millisecond-time.Minute)
	ended := env.eventsOf(EvRewardEnded)
	if len(ended) != 1 {
		t.Fatalf("reward_ended %v", emgTypes(ended))
	}
	x := mustDecode[RewardEndedData](t, ended[0])
	if x.AllowanceID != a.ID || x.Reason != "expired" || x.Refund != 0 || x.RemainingMs != 0 || x.TotalMs != span || x.Cost != a.Cost ||
		x.RevokedByBlockID != nil || ended[0].Points != 0 {
		t.Fatalf("expiry %+v", x)
	}
	if !rwdServiceHosts(env, "youtube") || rwdServiceHosts(env, "discord") {
		t.Fatal("youtube not blocked again after its allowance")
	}
	emgForward(env, time.Minute)
	if !rwdServiceHosts(env, "discord") || !containsProcess(e.enf.Processes, proc, e.platform) || len(env.state().Allowances) != 0 {
		t.Fatal("discord not blocked again after its allowance")
	}
	credited = e.block(blk.ID).CreditedMs
	env.advance(time.Minute)
	if e.block(blk.ID).CreditedMs <= credited {
		t.Fatal("credit did not resume")
	}
}

// Redeeming the same service again extends its allowance, up to allowanceMaxMinutes in
// total (§5.7).
func TestAllowanceExtendsUpToTheMaximum(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	rwdGrant(env, 2000)
	env.create(durationReq(ModeNormal, 240, "discord"))
	o := rwdOffer(t, "discord-15")
	maxMin := int64(limits().AllowanceMaxMinutes)
	t0 := e.now
	first := rwdRedeem(t, env, o.ID).Allowance
	var last RewardAllowance
	n := maxMin / int64(o.Minutes)
	for i := int64(2); i <= n; i++ {
		env.advance(time.Minute)
		last = rwdRedeem(t, env, o.ID).Allowance
		if last.ID != first.ID || last.Minutes != i*int64(o.Minutes) || last.Cost != i*int64(o.Cost) || last.StartedAt != fmtMs(t0) ||
			last.EndsAt != fmtMs(t0+i*int64(o.Minutes)*msPerMinute) || last.OfferID != o.ID {
			t.Fatalf("redemption %d: %+v", i, last)
		}
	}
	evs := env.eventsOf(EvRewardRedeemed)
	d := mustDecode[RewardRedeemedData](t, evs[1])
	if !d.ExtendedExisting || d.OfferMinutes != int64(o.Minutes) || d.OfferCost != int64(o.Cost) || d.AllowanceMinutes != 2*int64(o.Minutes) ||
		d.AllowanceCost != 2*int64(o.Cost) || evs[1].Points != -int64(o.Cost) {
		t.Fatalf("extension event %+v", d)
	}
	r, _ := e.ListRewards(bg)
	if st := rwdStatus(t, r, o.ID); st.Available || *st.UnavailableReason != "allowance_limit" {
		t.Fatalf("status at the maximum %+v", st)
	}
	_, err := e.RedeemReward(bg, Request{}, RedeemRewardRequest{OfferID: o.ID})
	if dd := apiDetails(err); apiCode(err) != "allowance_limit_reached" || dd["maxMinutes"] != maxMin || dd["currentMinutes"] != maxMin {
		t.Fatalf("over the maximum: %v %v", err, dd)
	}
	if len(e.state.Rewards.Allowances) != 1 {
		t.Fatal("one allowance per service")
	}
}

// A hardcore or exam block or a punishment revokes every allowance with a pro-rata
// refund on the allowance's total (two youtube-15 then a revocation refunds on 300,
// §6.4); normal and strict blocks do not (§10.7).
func TestAllowanceRevocation(t *testing.T) {
	yt15 := rwdOffer(t, "youtube-15")
	cost := int64(yt15.Cost)
	span := int64(yt15.Minutes) * msPerMinute
	t.Run("hardcore", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		rwdGrant(env, 2*cost)
		env.create(durationReq(ModeNormal, 120, "youtube"))
		a := rwdRedeem(t, env, yt15.ID).Allowance
		rwdRedeem(t, env, yt15.ID)
		env.advance(10 * time.Minute)
		env.create(durationReq(ModeStrict, 30, "reddit"))
		if len(e.state.Rewards.Allowances) != 1 {
			t.Fatal("a strict block revoked the allowance")
		}
		hc := env.create(durationReq(ModeHardcore, 30, "instagram"))
		batch := emgLastBatch(t, env, EvRewardEnded)
		if !slices.Equal(emgTypes(batch), []string{EvBlockCreated, EvRewardEnded}) {
			t.Fatalf("batch %v", emgTypes(batch))
		}
		d := mustDecode[RewardEndedData](t, batch[1])
		total, remaining := 2*span, 2*span-10*msPerMinute
		want := points.AllowanceRefund(2*cost, total, remaining)
		if d.AllowanceID != a.ID || d.Reason != "revoked" || d.RevokedByBlockID == nil || *d.RevokedByBlockID != hc.ID || d.Cost != 2*cost ||
			d.TotalMs != total || d.RemainingMs != remaining || d.Refund != want || batch[1].Points != want || want != 2*cost*2/3 {
			t.Fatalf("revocation %+v (want refund %d)", d, want)
		}
		if e.state.Ledger.Balance != want || len(env.state().Allowances) != 0 || !rwdServiceHosts(env, "youtube") {
			t.Fatalf("after revocation: balance %d", e.state.Ledger.Balance)
		}
	})
	t.Run("punishment", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		rwdGrant(env, cost)
		env.create(durationReq(ModeNormal, 120, "youtube"))
		rwdRedeem(t, env, yt15.ID)
		env.advance(3 * time.Minute)
		pb, _ := emgPunish(t, env, "distractions", 30)
		batch := emgLastBatch(t, env, EvRewardEnded)
		if !slices.Equal(emgTypes(batch), []string{EvBlockCreated, EvPunishmentStarted, EvRewardEnded}) {
			t.Fatalf("batch %v", emgTypes(batch))
		}
		d := mustDecode[RewardEndedData](t, batch[2])
		if *d.RevokedByBlockID != pb.ID || d.Refund != points.AllowanceRefund(cost, span, span-3*msPerMinute) {
			t.Fatalf("revocation %+v", d)
		}
		if len(e.state.Rewards.Allowances) != 0 {
			t.Fatal("allowance survived the punishment")
		}
	})
	t.Run("once per batch", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		rwdGrant(env, cost)
		env.create(durationReq(ModeNormal, 120, "youtube"))
		rwdRedeem(t, env, yt15.ID)
		var n int
		_ = e.exec(bg, func() {
			e.timeStep()
			b := e.newBatch()
			e.addRevokeAllowances(b, "blk_0123456789abcdefXYZ0")
			e.addRevokeAllowances(b, "blk_0123456789abcdefXYZ1")
			n = len(b.events)
		})
		if n != 1 {
			t.Fatalf("%d reward_ended events for one allowance", n)
		}
	})
}

// The emergency penalty counts what the allowances are worth, so buying time cannot
// shelter points from it (§6.1, §10.6).
func TestEmergencyPenaltyIncludesAllowanceValue(t *testing.T) {
	env := newTestEnv(t)
	e := env.open()
	o := rwdOffer(t, "youtube-30")
	cost, span := int64(o.Cost), int64(o.Minutes)*msPerMinute
	rwdGrant(env, 600)
	blk := env.create(durationReq(ModeNormal, 120, "youtube"))
	rwdRedeem(t, env, o.ID)
	balance := 600 - cost
	rules := points.DefaultPointRules()
	p, _ := e.EmergencyPreview(bg, nil)
	if p.Balance != balance || p.AllowanceValue != cost || p.PenaltyPoints != points.EmergencyPenalty(balance+cost, rules) ||
		p.PenaltyPoints == points.EmergencyPenalty(balance, rules) {
		t.Fatalf("preview %+v", p)
	}
	em := emgRequest(t, env, blk.ID)
	if em.PenaltyPreview != p.PenaltyPoints {
		t.Fatalf("penaltyPreview %d", em.PenaltyPreview)
	}
	cd := emgCountdown(ModeNormal)
	emgForward(env, cd)
	value := points.AllowanceRefund(cost, span, span-cd.Milliseconds())
	want := points.EmergencyPenalty(balance+value, rules)
	if s := env.state(); s.Emergency.PenaltyPreview != want || s.Emergency.Status != "ready" {
		t.Fatalf("state emergency %+v, want penalty %d", s.Emergency, want)
	}
	res, err := e.ConfirmEmergency(bg, Request{Scope: "app"}, em.ID, ConfirmEmergencyRequest{Acknowledge: true})
	if err != nil {
		t.Fatal(err)
	}
	d := mustDecode[EmergencyConfirmedData](t, env.eventsOf(EvEmergencyConfirmed)[0])
	if res.PenaltyApplied != want || d.AllowanceValue != value || d.BalanceBefore != balance || d.Penalty != want || res.BalanceAfter != balance-want {
		t.Fatalf("confirm %+v / %+v", res, d)
	}
}

// Allowances survive a restart and are rebuilt from the log; a calibration shifts one
// redeemed while the trusted clock ran ahead, so it lasts what it promised (§4, §10.2).
func TestAllowancePersistenceAndCalibration(t *testing.T) {
	t.Run("restart and rebuild", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		o := rwdOffer(t, "discord-15")
		earn := int64(o.Cost) - int64(points.DefaultPointRules().CleanSessionBonus)
		env.create(durationReq(ModeNormal, earn, "reddit"))
		emgForward(env, time.Duration(earn)*time.Minute+10*time.Second)
		if e.state.Ledger.Balance != int64(o.Cost) {
			t.Fatalf("earned %d", e.state.Ledger.Balance)
		}
		env.create(durationReq(ModeNormal, 120, "discord"))
		a := rwdRedeem(t, env, o.ID).Allowance
		env.advance(time.Minute)
		e = env.restart()
		if got := e.allowancesWire(0); len(got) != 1 || got[0] != a {
			t.Fatalf("after restart %+v", got)
		}
		if err := e.Stop(); err != nil {
			t.Fatal(err)
		}
		for _, n := range []string{"state.json", "state.prev.json"} {
			if err := os.Remove(filepath.Join(env.dir, n)); err != nil && !errors.Is(err, os.ErrNotExist) {
				t.Fatal(err)
			}
		}
		env.clk.ServiceRestart(time.Second)
		e = env.open()
		if got := e.allowancesWire(0); len(got) != 1 || got[0] != a || e.state.Ledger.Balance != 0 {
			t.Fatalf("rebuilt %+v, balance %d", got, e.state.Ledger.Balance)
		}
		if rwdServiceHosts(env, "discord") {
			t.Fatal("rebuilt allowance not enforced")
		}
	})
	t.Run("calibration shift", func(t *testing.T) {
		env := newTestEnv(t)
		env.open()
		env.create(durationReq(ModeNormal, 600, "youtube"))
		if err := env.e.Stop(); err != nil {
			t.Fatal(err)
		}
		env.net.SetOffline(true)
		env.clk.RebootAfter(time.Minute)
		env.clk.JumpWall(3 * time.Hour) // the BIOS clock is 3 h ahead
		e := env.open()
		rwdGrant(env, 200)
		o := rwdOffer(t, "youtube-15")
		a := rwdRedeem(t, env, o.ID).Allowance
		env.advance(time.Minute)
		env.net.SetOffline(false)
		env.clk.Advance(5 * time.Minute) // the backoff retry comes within 5 min
		e.Step()
		cal := env.eventsOf(EvClockJump)
		last := mustDecode[ClockJumpData](t, cal[len(cal)-1])
		if last.Source != "calibrate" || !slices.Equal(last.ShiftedAllowanceIDs, []string{a.ID}) {
			t.Fatalf("calibration %+v", last)
		}
		rec := e.allowance(a.ID)
		if rec == nil || rec.EndsAt-rec.StartedAt != int64(o.Minutes)*msPerMinute {
			t.Fatalf("allowance %+v", rec)
		}
		// About 6 of its 15 minutes have passed in real time.
		if rem := rec.EndsAt - e.now; rem > 9*msPerMinute+2000 || rem < 9*msPerMinute-2000 {
			t.Fatalf("remaining %d ms after the shift", rem)
		}
		emgForward(env, 10*time.Minute)
		if len(e.state.Rewards.Allowances) != 0 || !rwdServiceHosts(env, "youtube") {
			t.Fatal("the shifted allowance did not expire on time")
		}
	})
	t.Run("epoch kept", func(t *testing.T) {
		env := newTestEnv(t)
		e := env.open()
		rwdGrant(env, 200)
		env.create(durationReq(ModeNormal, 120, "youtube"))
		rwdRedeem(t, env, "youtube-15")
		var before, after []RewardAllowance
		_ = e.exec(bg, func() {
			before = e.keptAllowances()
			e.restoreKeptAllowances(append(slices.Clone(before), RewardAllowance{ID: "alw_x", Status: "expired"}))
			after = e.keptAllowances()
		})
		if len(before) != 1 || !slices.Equal(before, after) || before[0].StartedAt != fmtMs(e.allowance(before[0].ID).StartedAt) {
			t.Fatalf("kept %+v → %+v", before, after)
		}
	})
}
