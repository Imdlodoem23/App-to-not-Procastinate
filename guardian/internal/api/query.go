package api

import (
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// intParamRE is a plain decimal integer (no sign other than '-', no spaces, no
// exponent); longer values are refused before parsing.
var intParamRE = regexp.MustCompile(`^-?[0-9]{1,18}$`)

// query is the parsed query string of a request: each accepted parameter at most once.
type query map[string]string

// parseQuery parses raw, refusing unknown parameters, repeated ones and malformed
// encodings with 400 bad_query (the guardian rejects unknown request fields, §8.4).
func parseQuery(raw string, allowed []string) (query, *engine.APIError) {
	q := query{}
	if raw == "" {
		return q, nil
	}
	vals, err := url.ParseQuery(raw)
	if err != nil {
		return nil, badQuery("malformed query string")
	}
	for k, vs := range vals {
		if !slices.Contains(allowed, k) {
			return nil, badQuery("unknown query parameter")
		}
		if len(vs) != 1 {
			return nil, badQuery("repeated query parameter")
		}
		q[k] = vs[0]
	}
	return q, nil
}

// int64Param returns the parameter as an integer, nil when absent.
func (q query) int64Param(name string) (*int64, *engine.APIError) {
	s, ok := q[name]
	if !ok {
		return nil, nil
	}
	if !intParamRE.MatchString(s) {
		return nil, badQuery(name + " must be an integer")
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return nil, badQuery(name + " must be an integer")
	}
	return &v, nil
}

// intParam is int64Param for int-sized parameters (limits, waits).
func (q query) intParam(name string) (*int, *engine.APIError) {
	v, err := q.int64Param(name)
	if err != nil || v == nil {
		return nil, err
	}
	if int64(int(*v)) != *v {
		return nil, badQuery(name + " out of range")
	}
	n := int(*v)
	return &n, nil
}

// listParam splits a comma-separated parameter (nil when absent); empty items are
// refused.
func (q query) listParam(name string) ([]string, *engine.APIError) {
	s, ok := q[name]
	if !ok {
		return nil, nil
	}
	parts := strings.Split(s, ",")
	for _, p := range parts {
		if p == "" {
			return nil, badQuery(name + " has an empty item")
		}
	}
	return parts, nil
}
