package catalog

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// Port of the semantic checks at the end of packages/shared/src/guardian-api.ts
// (findAllowDistraction, the attempt target keys and the text rules), which the app and
// the guardian share through test/fixtures/catalog-vectors.json.

// ---------------------------------------------------------------------------------------
// Whitelist entries (422 allow_distraction)
// ---------------------------------------------------------------------------------------

// Reasons of AllowDistraction.
const (
	ReasonServiceDomain         = "service_domain"
	ReasonParentOfServiceDomain = "parent_of_service_domain"
	ReasonPublicSuffix          = "public_suffix"
	ReasonDistractionApp        = "distraction_app"
)

// AllowDistraction says why a whitelist entry was refused: the details of 422
// allow_distraction. It encodes to JSON as {path, reason, serviceId, appId}, with null
// for an empty ServiceID or AppID.
type AllowDistraction struct {
	// Path is the entry's request path, e.g. allow.customDomains[1].
	Path string
	// Reason is one of the Reason* constants.
	Reason string
	// ServiceID is the service the domain belongs to or is a parent of ("" for none).
	ServiceID string
	// AppID is the distraction app of a process name ("" for none).
	AppID string
}

// MarshalJSON encodes the TypeScript AllowDistraction shape.
func (a AllowDistraction) MarshalJSON() ([]byte, error) {
	nullable := func(s string) *string {
		if s == "" {
			return nil
		}
		return &s
	}
	return json.Marshal(struct {
		Path      string  `json:"path"`
		Reason    string  `json:"reason"`
		ServiceID *string `json:"serviceId"`
		AppID     *string `json:"appId"`
	}{a.Path, a.Reason, nullable(a.ServiceID), nullable(a.AppID)})
}

// AllowEntries are the entries of a whitelist to check.
type AllowEntries struct {
	Domains   []string
	Processes []string
}

// AllowPaths are the request paths of the two lists, used to build AllowDistraction.Path
// (e.g. "allow.customDomains" and "allow.customProcesses").
type AllowPaths struct {
	Domains   string
	Processes string
}

// FindAllowDistraction is the single «no distractions in a whitelist» check, used for
// block and schedule allow lists and for settings.studyWhitelist (422
// allow_distraction). It refuses a domain that is a multi-label public suffix, equals or
// is under a domain of a catalog service with at least one category (a service's
// excluded subdomains stay allowed), or is a parent of one (googleapis.com would allow
// youtubei.googleapis.com); and a process name of a catalog app that some category
// blocks. Domains are checked first, in order, then processes. Processes are checked on
// every platform when platform is "", else on that one (the guardian passes its own).
// It returns nil when every entry is fine.
func (c *Catalog) FindAllowDistraction(entries AllowEntries, paths AllowPaths, platform Platform) *AllowDistraction {
	for i, d := range entries.Domains {
		if found := c.domainDistraction(d, indexedPath(paths.Domains, i)); found != nil {
			return found
		}
	}
	platforms := allPlatforms
	if platform != "" {
		platforms = []Platform{platform}
	}
	for i, name := range entries.Processes {
		for _, p := range platforms {
			if appID, ok := c.distractionApps[p][ProcessNameKey(name, p)]; ok {
				return &AllowDistraction{
					Path: indexedPath(paths.Processes, i), Reason: ReasonDistractionApp, AppID: appID,
				}
			}
		}
	}
	return nil
}

func indexedPath(base string, i int) string {
	return base + "[" + strconv.Itoa(i) + "]"
}

func (c *Catalog) domainDistraction(d, path string) *AllowDistraction {
	if c.IsPublicSuffixLike(d) {
		return &AllowDistraction{Path: path, Reason: ReasonPublicSuffix}
	}
	if owner := c.FindServiceByDomain(d); owner != nil && len(owner.Categories) > 0 {
		return &AllowDistraction{Path: path, Reason: ReasonServiceDomain, ServiceID: owner.ID}
	}
	for _, entry := range c.distractionDomains {
		if entry.domain != d && IsSameOrSubdomain(entry.domain, d) {
			return &AllowDistraction{
				Path: path, Reason: ReasonParentOfServiceDomain, ServiceID: entry.serviceID,
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------------------------------
// Attempt dedupe keys (attempt.targetKey)
// ---------------------------------------------------------------------------------------

// DomainTargetKey is the dedupe key of an extension detection: svc:<id> for a catalog
// service's host, else dom:<host> without a leading www.
func (c *Catalog) DomainTargetKey(host string) string {
	if svc := c.FindServiceByDomain(host); svc != nil {
		return "svc:" + svc.ID
	}
	return "dom:" + strings.TrimPrefix(host, "www.")
}

// ServiceTargetKey is the dedupe key of a window-title detection.
func ServiceTargetKey(serviceID string) string { return "svc:" + serviceID }

// ProcessTargetKey is the dedupe key of a process detection on platform: svc:<id> for a
// service's app, app:<id> for another catalog app, else proc:<ProcessNameKey>.
func (c *Catalog) ProcessTargetKey(name string, platform Platform) string {
	if svc := c.FindServiceByProcessName(name, platform); svc != nil {
		return "svc:" + svc.ID
	}
	if app := c.FindAppByProcessName(name, platform); app != nil {
		return "app:" + app.ID
	}
	return "proc:" + ProcessNameKey(name, platform)
}

// ---------------------------------------------------------------------------------------
// User text fields
// ---------------------------------------------------------------------------------------

// TextField names a user text field with a length limit.
type TextField string

// Text fields and their limits (embedded GUARDIAN_LIMITS): reason (block and schedule
// reason), task (Study Mode task), scheduleName, limitName and phrase (emergency phrase).
const (
	FieldReason       TextField = "reason"
	FieldTask         TextField = "task"
	FieldScheduleName TextField = "scheduleName"
	FieldPhrase       TextField = "phrase"
	// FieldLimitName is a daily limit's name (limitNameText: 1–limitNameMaxLength).
	FieldLimitName TextField = "limitName"
)

// Validation issue kinds (TS ValidationIssueKind) reported by TextFieldIssue.
const (
	IssueLength  = "length"
	IssuePattern = "pattern"
	IssueRule    = "rule"
)

// TextFieldIssue returns the issue the request validator reports for value in field
// ("" when valid), like textFieldIssue in TypeScript: IssueLength when its length in
// UTF-16 code units is outside the field's range (scheduleName and phrase need at least
// one), then IssuePattern when a reason, task or schedule name contains a control
// character (U+0000–U+001F, U+007F–U+009F) or a bidi override or isolate (U+202A–U+202E,
// U+2066–U+2069). An unknown field reports IssueRule for every value.
func TextFieldIssue(field TextField, value string) string {
	limits := embedded.API().Limits
	var minLen, maxLen int
	text := true
	switch field {
	case FieldReason:
		maxLen = limits.ReasonMaxLength
	case FieldTask:
		maxLen = limits.TaskMaxLength
	case FieldScheduleName:
		minLen, maxLen = 1, limits.ScheduleNameMaxLength
	case FieldLimitName:
		minLen, maxLen = 1, limits.LimitNameMaxLength
	case FieldPhrase:
		minLen, maxLen, text = 1, limits.PhraseMaxLength, false
	default:
		return IssueRule
	}
	if n := UTF16Len(value); n < minLen || n > maxLen {
		return IssueLength
	}
	if text && strings.ContainsFunc(value, unsafeTextRune) {
		return IssuePattern
	}
	return ""
}

// unsafeTextRune is UNSAFE_TEXT_RE of guardian-api.ts: control characters and bidi
// overrides and isolates are never accepted in user text.
func unsafeTextRune(r rune) bool {
	return r <= 0x1F || (r >= 0x7F && r <= 0x9F) || (r >= 0x202A && r <= 0x202E) ||
		(r >= 0x2066 && r <= 0x2069)
}
