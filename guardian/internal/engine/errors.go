package engine

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
	"github.com/imdlodoem23/centrate/guardian/internal/store"
)

// APIError is an error the API layer turns into a GuardianErrorBody
// ({"error": {"code", "message", "details"}}, docs/ARCHITECTURE.md §8.1). Code is a
// GuardianErrorCode; its HTTP status comes from the embedded GUARDIAN_ERROR_STATUS table
// (Status), never from a literal.
type APIError struct {
	Code string
	// Message is English, for developers and logs. It never contains personal data
	// (domains, reasons, tasks, tokens).
	Message string
	// Details is code-specific (nil encodes as null).
	Details map[string]any
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return "engine: " + e.Code
	}
	return "engine: " + e.Code + ": " + e.Message
}

// Status is the HTTP status of the code (500 for a code the embedded table lacks).
func (e *APIError) Status() int {
	if s, ok := embedded.API().Errors[e.Code]; ok {
		return s
	}
	return http.StatusInternalServerError
}

// ErrNotImplemented is returned by the handlers of the feature files that are still
// stubs (study.go, emergency.go…). The API layer answers it with 500 internal.
var ErrNotImplemented = &APIError{Code: "internal", Message: "not implemented yet"}

// errNotImplemented is what the stub handlers return (the same value).
var errNotImplemented error = ErrNotImplemented

// ErrStopped is returned by commands sent after Stop (or before Open finished).
var ErrStopped = errors.New("engine: stopped")

// ErrNotOpen is returned by commands sent before the startup ladder finished.
var ErrNotOpen = errors.New("engine: not open yet")

// ReplayedResponse is returned (as an error) when an idempotent request repeats a
// stored one with the same key, path and body (§8.6): the API layer writes Status and
// Body exactly as stored and adds `Idempotent-Replayed: true`.
type ReplayedResponse struct {
	Status int
	Body   []byte
}

func (r *ReplayedResponse) Error() string {
	return fmt.Sprintf("engine: idempotent replay (status %d)", r.Status)
}

// apiErr builds an *APIError.
func apiErr(code, message string, details map[string]any) *APIError {
	return &APIError{Code: code, Message: message, Details: details}
}

// notFound is 404 not_found.
func notFound(what string) *APIError {
	return apiErr("not_found", what+" not found", nil)
}

// readOnly is 503 read_only with details.reason.
func readOnly(reason string) *APIError {
	return apiErr("read_only", "the guardian cannot write right now", map[string]any{"reason": reason})
}

// issueErr maps a request-shape ValidationIssue to its error (§8.1, validationErrorCode
// in guardian-api.ts): unknown_field → 400 unknown_field; protected_process → 422
// protected_target; a range issue on durationMinutes → 422 duration_out_of_range; a
// pattern, rule or length issue on a timezone → 422 invalid_timezone; anything else →
// 422 validation_failed. details always carries {path, issue}.
func issueErr(path, issue, message string) *APIError {
	details := map[string]any{"path": path, "issue": issue}
	code := "validation_failed"
	switch {
	case issue == "unknown_field":
		code = "unknown_field"
	case issue == "protected_process":
		code = "protected_target"
	case path == "durationMinutes" && issue == "range":
		code = "duration_out_of_range"
		l := limits()
		details["minMinutes"] = l.BlockMinMinutes
		details["maxMinutes"] = l.BlockMaxMinutes
	case isTimezonePath(path) && (issue == "pattern" || issue == "rule" || issue == "length"):
		code = "invalid_timezone"
	}
	return apiErr(code, message, details)
}

func isTimezonePath(path string) bool {
	const tz = "timezone"
	if path == tz {
		return true
	}
	return len(path) > len(tz) && path[len(path)-len(tz)-1:] == "."+tz
}

// storeWriteErr turns a failed store write into 503 read_only (§8.1: nothing was
// applied). Errors that are not write failures (frozen, no epoch, invalid input) are
// internal errors, except ErrFrozen, which is read_only{schema_too_new}.
func storeWriteErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, store.ErrFrozen) {
		return readOnly("schema_too_new")
	}
	if r := store.ReadOnlyReason(err); r != "" {
		return readOnly(r)
	}
	return apiErr("internal", "the event log refused the batch", nil)
}

// limits is the embedded GUARDIAN_LIMITS.
func limits() *embedded.Limits { return &embedded.API().Limits }
