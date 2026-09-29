package api

import (
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// Error codes the API layer produces itself (GuardianErrorCode; statuses come from the
// embedded GUARDIAN_ERROR_STATUS table through engine.APIError.Status).
const (
	codeHostNotAllowed    = "host_not_allowed"
	codeOriginNotAllowed  = "origin_not_allowed"
	codeNotFound          = "not_found"
	codeMethodNotAllowed  = "method_not_allowed"
	codeUnauthorized      = "unauthorized"
	codeInsufficientScope = "insufficient_scope"
	codeRateLimited       = "rate_limited"
	codeReadOnly          = "read_only"
	codeUnsupportedMedia  = "unsupported_media_type"
	codeBodyTooLarge      = "body_too_large"
	codeInvalidJSON       = "invalid_json"
	codeUnknownField      = "unknown_field"
	codeValidationFailed  = "validation_failed"
	codeBadQuery          = "bad_query"
	codeInternal          = "internal"
)

// read_only reasons the API layer adds to the contract's (disk_full, io_error,
// schema_too_new, safe_mode): the engine is still starting, is stopping, or failed to
// start.
const (
	reasonStarting      = "starting"
	reasonStopping      = "stopping"
	reasonStartupFailed = "startup_failed"
)

// apiError builds an error answered as {"error": {code, message, details}}.
func apiError(code, message string, details map[string]any) *engine.APIError {
	return &engine.APIError{Code: code, Message: message, Details: details}
}

func badQuery(message string) *engine.APIError { return apiError(codeBadQuery, message, nil) }

func readOnly(reason string) *engine.APIError {
	return apiError(codeReadOnly, "the guardian cannot serve this request right now", map[string]any{"reason": reason})
}

// issueError maps a ValidationIssue to its error exactly like the engine and
// validationErrorCode in guardian-api.ts (§8.1): unknown_field → 400 unknown_field;
// protected_process → 422 protected_target; range on durationMinutes → 422
// duration_out_of_range with {minMinutes, maxMinutes}; pattern, rule or length on a
// timezone → 422 invalid_timezone; anything else → 422 validation_failed. details
// always carries {path, issue}.
func issueError(path, issue, message string) *engine.APIError {
	if path == "" {
		path = "$"
	}
	details := map[string]any{"path": path, "issue": issue}
	code := codeValidationFailed
	switch {
	case issue == "unknown_field":
		code = codeUnknownField
	case issue == "protected_process":
		code = "protected_target"
	case path == "durationMinutes" && issue == "range":
		code = "duration_out_of_range"
		l := embedded.API().Limits
		details["minMinutes"] = l.BlockMinMinutes
		details["maxMinutes"] = l.BlockMaxMinutes
	case (path == "timezone" || strings.HasSuffix(path, ".timezone")) &&
		(issue == "pattern" || issue == "rule" || issue == "length"):
		code = "invalid_timezone"
	}
	return apiError(code, message, details)
}
