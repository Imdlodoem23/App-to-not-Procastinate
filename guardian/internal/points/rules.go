package points

import "github.com/imdlodoem23/centrate/guardian/internal/embedded"

// The rule types are the embedded ones (rulesSnapshot() in points.ts, decoded from
// guardian/internal/embedded/rules.json). Functions take them by value and never modify
// them (EarningBlockKinds is shared with the embedded snapshot and read-only).
type (
	// PointRules mirrors POINT_RULES.
	PointRules = embedded.PointRules
	// EmergencyRules mirrors EMERGENCY_RULES.
	EmergencyRules = embedded.EmergencyRules
	// TunableRange mirrors TunableRange.
	TunableRange = embedded.TunableRange
	// RewardOffer mirrors RewardOffer.
	RewardOffer = embedded.RewardOffer
)

// DefaultPointRules is the embedded POINT_RULES (the default rules argument of every
// function in points.ts).
func DefaultPointRules() PointRules { return embedded.Rules().Points }

// DefaultEmergencyRules is the embedded EMERGENCY_RULES.
func DefaultEmergencyRules() EmergencyRules { return embedded.Rules().Emergency }

// DefaultRewardOffers is the embedded REWARD_OFFERS (shared: do not modify).
func DefaultRewardOffers() []RewardOffer { return embedded.Rules().RewardOffers }

// RulesVersion is the embedded RULES_VERSION.
func RulesVersion() int { return embedded.Rules().RulesVersion }
