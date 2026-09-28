package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/imdlodoem23/centrate/guardian/internal/engine"
)

// Strict request decoding (docs/ARCHITECTURE.md §8.1, §8.3 step 7):
//
//  1. Syntax: the body must be one UTF-8 JSON value with no trailing data and no
//     duplicate object key (the strict tokenizer), else 400 invalid_json.
//  2. Shape, in the order of the TypeScript validators (obj() in guardian-api.ts): for
//     each field of the request type in declaration order, a missing field is
//     `required`, a value of another JSON type is `type` (every request field is
//     required; pointer fields are the nullable ones), nested objects are checked in
//     place, and after the known fields the first unknown key is `unknown_field`.
//     Integers accept any JSON number with an integral value (JavaScript's
//     Number.isInteger), so 60 and 60.0 are the same.
//  3. Decoding into the Go type with DisallowUnknownFields.
//
// Value rules (ranges, patterns, enums, lengths in UTF-16 units) and semantics are the
// engine's, which validates every request again after this (defence in depth).

// maxJSONDepth bounds nesting; no request is deeper than 4 levels.
const maxJSONDepth = 32

type jsonKind uint8

const (
	jsonNull jsonKind = iota
	jsonBool
	jsonNumber
	jsonString
	jsonArray
	jsonObject
)

var kindNames = [...]string{"null", "boolean", "number", "string", "array", "object"}

// jsonNode is one value of a strictly parsed document.
type jsonNode struct {
	kind jsonKind
	b    bool
	// text is a string's value or a number's literal.
	text  string
	items []*jsonNode
	// keys are the object's keys in document order; props maps them to their values.
	keys  []string
	props map[string]*jsonNode
}

// errSyntax wraps every syntax problem (400 invalid_json).
var errSyntax = errors.New("invalid JSON")

// parseStrictJSON parses exactly one JSON value.
func parseStrictJSON(data []byte) (*jsonNode, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("%w: not UTF-8", errSyntax)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	n, err := parseValue(dec, 0)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: data after the JSON value", errSyntax)
	}
	return n, nil
}

func parseValue(dec *json.Decoder, depth int) (*jsonNode, error) {
	tok, err := dec.Token()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("%w: unexpected end of input", errSyntax)
		}
		return nil, fmt.Errorf("%w: %s", errSyntax, syntaxMessage(err))
	}
	switch t := tok.(type) {
	case nil:
		return &jsonNode{kind: jsonNull}, nil
	case bool:
		return &jsonNode{kind: jsonBool, b: t}, nil
	case json.Number:
		return &jsonNode{kind: jsonNumber, text: t.String()}, nil
	case string:
		return &jsonNode{kind: jsonString, text: t}, nil
	case json.Delim:
		if depth >= maxJSONDepth {
			return nil, fmt.Errorf("%w: nested too deeply", errSyntax)
		}
		switch t {
		case '{':
			return parseObject(dec, depth)
		case '[':
			return parseArray(dec, depth)
		}
	}
	return nil, fmt.Errorf("%w: unexpected token", errSyntax)
}

func parseObject(dec *json.Decoder, depth int) (*jsonNode, error) {
	n := &jsonNode{kind: jsonObject, props: map[string]*jsonNode{}}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("%w: %s", errSyntax, syntaxMessage(err))
		}
		key, ok := tok.(string)
		if !ok {
			return nil, fmt.Errorf("%w: object key is not a string", errSyntax)
		}
		if _, dup := n.props[key]; dup {
			return nil, fmt.Errorf("%w: duplicate key", errSyntax)
		}
		v, err := parseValue(dec, depth+1)
		if err != nil {
			return nil, err
		}
		n.keys = append(n.keys, key)
		n.props[key] = v
	}
	if err := expectDelim(dec, '}'); err != nil {
		return nil, err
	}
	return n, nil
}

func parseArray(dec *json.Decoder, depth int) (*jsonNode, error) {
	n := &jsonNode{kind: jsonArray, items: []*jsonNode{}}
	for dec.More() {
		v, err := parseValue(dec, depth+1)
		if err != nil {
			return nil, err
		}
		n.items = append(n.items, v)
	}
	if err := expectDelim(dec, ']'); err != nil {
		return nil, err
	}
	return n, nil
}

func expectDelim(dec *json.Decoder, want json.Delim) error {
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("%w: %s", errSyntax, syntaxMessage(err))
	}
	if d, ok := tok.(json.Delim); !ok || d != want {
		return fmt.Errorf("%w: unexpected token", errSyntax)
	}
	return nil
}

// syntaxMessage describes a decoder error without echoing request content.
func syntaxMessage(err error) string {
	var se *json.SyntaxError
	if errors.As(err, &se) {
		return fmt.Sprintf("syntax error at byte %d", se.Offset)
	}
	return "malformed JSON"
}

// shapeIssue is the first shape problem of a request body.
type shapeIssue struct {
	path, issue, message string
}

// checkShape validates n (nil: the value is missing) against the Go type t, in the
// order of the TypeScript validators. path is the TS path ("" for the root).
func checkShape(n *jsonNode, t reflect.Type, path string) *shapeIssue {
	if t.Kind() == reflect.Pointer {
		if n != nil && n.kind == jsonNull {
			return nil
		}
		return checkShape(n, t.Elem(), path)
	}
	if n == nil {
		return &shapeIssue{path, "required", "required"}
	}
	switch t.Kind() {
	case reflect.Struct:
		if n.kind != jsonObject {
			return typeIssue(path, "object", n)
		}
		fields := jsonFields(t)
		for _, f := range fields {
			if is := checkShape(n.props[f.name], f.typ, childPath(path, f.name)); is != nil {
				return is
			}
		}
		for _, k := range n.keys {
			if !hasField(fields, k) {
				return &shapeIssue{childPath(path, k), "unknown_field", "unknown field"}
			}
		}
	case reflect.Slice:
		if n.kind != jsonArray {
			return typeIssue(path, "array", n)
		}
		base := path
		if base == "" {
			base = "$"
		}
		for i, it := range n.items {
			if is := checkShape(it, t.Elem(), fmt.Sprintf("%s[%d]", base, i)); is != nil {
				return is
			}
		}
	case reflect.String:
		if n.kind != jsonString {
			return typeIssue(path, "string", n)
		}
	case reflect.Bool:
		if n.kind != jsonBool {
			return typeIssue(path, "boolean", n)
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		if n.kind != jsonNumber {
			return typeIssue(path, "integer", n)
		}
		v, ok, inRange := integerValue(n.text)
		if !ok {
			return &shapeIssue{path, "type", "integer"}
		}
		if !inRange || reflect.Zero(t).OverflowInt(v) {
			return &shapeIssue{path, "range", "integer out of range"}
		}
	default:
		// No request type has other kinds; refuse rather than guess.
		return &shapeIssue{path, "type", "unsupported value"}
	}
	return nil
}

func typeIssue(path, want string, n *jsonNode) *shapeIssue {
	return &shapeIssue{path, "type", fmt.Sprintf("%s expected, got %s", want, kindNames[n.kind])}
}

// childPath is child() of guardian-api.ts.
func childPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

type jsonField struct {
	name string
	typ  reflect.Type
}

// jsonFields lists the JSON fields of a struct type in declaration order.
func jsonFields(t reflect.Type) []jsonField {
	out := make([]jsonField, 0, t.NumField())
	for i := range t.NumField() {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		name := f.Name
		if tag, ok := f.Tag.Lookup("json"); ok {
			tn, _, _ := strings.Cut(tag, ",")
			if tn == "-" {
				continue
			}
			if tn != "" {
				name = tn
			}
		}
		out = append(out, jsonField{name: name, typ: f.Type})
	}
	return out
}

func hasField(fields []jsonField, name string) bool {
	for _, f := range fields {
		if f.name == name {
			return true
		}
	}
	return false
}

// integerValue reads a JSON number literal as an integer. ok is false when the value
// is not integral (or not finite); inRange is false when it does not fit an int64.
func integerValue(lit string) (v int64, ok, inRange bool) {
	if !strings.ContainsAny(lit, ".eE") {
		n, err := strconv.ParseInt(lit, 10, 64)
		if err != nil {
			return 0, true, false // integral but beyond int64
		}
		return n, true, true
	}
	f, err := strconv.ParseFloat(lit, 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) || f != math.Trunc(f) {
		return 0, false, false
	}
	if f < -(1<<63) || f >= 1<<63 {
		return 0, true, false
	}
	return int64(f), true, true
}

// appendNormalized writes n as compact JSON, integral numbers as integer literals.
func appendNormalized(dst []byte, n *jsonNode) []byte {
	switch n.kind {
	case jsonNull:
		return append(dst, "null"...)
	case jsonBool:
		return strconv.AppendBool(dst, n.b)
	case jsonNumber:
		if v, ok, inRange := integerValue(n.text); ok && inRange {
			return strconv.AppendInt(dst, v, 10)
		}
		return append(dst, n.text...)
	case jsonString:
		raw, _ := json.Marshal(n.text) // a Go string always encodes
		return append(dst, raw...)
	case jsonArray:
		dst = append(dst, '[')
		for i, it := range n.items {
			if i > 0 {
				dst = append(dst, ',')
			}
			dst = appendNormalized(dst, it)
		}
		return append(dst, ']')
	default:
		dst = append(dst, '{')
		for i, k := range n.keys {
			if i > 0 {
				dst = append(dst, ',')
			}
			raw, _ := json.Marshal(k)
			dst = append(dst, raw...)
			dst = append(dst, ':')
			dst = appendNormalized(dst, n.props[k])
		}
		return append(dst, '}')
	}
}

// decodeBody strictly decodes a request body into T (see the file comment). Errors are
// *engine.APIError: 400 invalid_json, 400 unknown_field or 422 validation_failed.
func decodeBody[T any](body []byte) (T, *engine.APIError) {
	var v T
	n, err := parseStrictJSON(body)
	if err != nil {
		return v, apiError(codeInvalidJSON, err.Error(), nil)
	}
	if is := checkShape(n, reflect.TypeFor[T](), ""); is != nil {
		return v, issueError(is.path, is.issue, is.message)
	}
	dec := json.NewDecoder(bytes.NewReader(appendNormalized(nil, n)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		return v, apiError(codeValidationFailed, "the body does not match the request type", map[string]any{"path": "$", "issue": "type"})
	}
	return v, nil
}
