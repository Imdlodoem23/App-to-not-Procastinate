package embedded

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// sharedDir is packages/shared, read in place (like the parity vectors, §12).
var sharedDir = filepath.Join("..", "..", "..", "packages", "shared")

var files = []struct {
	name string
	raw  *[]byte
	new  func() any
	got  func() any
	hash func(Hashes) string
}{
	{"catalog.json", &catalogJSON, func() any { return new(CatalogSnapshot) }, func() any { return Catalog() }, func(h Hashes) string { return h.Catalog }},
	{"rules.json", &rulesJSON, func() any { return new(RulesSnapshot) }, func() any { return Rules() }, func(h Hashes) string { return h.Rules }},
	{"api.json", &apiJSON, func() any { return new(APIContractSnapshot) }, func() any { return API() }, func(h Hashes) string { return h.API }},
}

func readShared(t *testing.T, rel string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(sharedDir, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("read packages/shared/%s: %v", rel, err)
	}
	return b
}

func TestEmbeddedFilesDecode(t *testing.T) {
	for _, f := range files {
		t.Run(f.name, func(t *testing.T) {
			v := f.new()
			hash, err := decodeFile(f.name, *f.raw, v)
			if err != nil {
				t.Fatal(err)
			}
			if want := f.hash(SourceHashes()); hash != want || len(hash) != 64 {
				t.Fatalf("hash %q, SourceHashes has %q", hash, want)
			}
			if !reflect.DeepEqual(v, f.got()) {
				t.Fatal("decoding again differs from the value decoded at init")
			}
		})
	}
}

// The files are exactly what the generator writes: an envelope with data, generatedBy and
// sourceSha256; every object's keys sorted; 2-space indent; LF; one trailing newline.
func TestEmbeddedFilesAreCanonical(t *testing.T) {
	for _, f := range files {
		t.Run(f.name, func(t *testing.T) {
			raw := *f.raw
			if bytes.Contains(raw, []byte("\r")) {
				t.Fatal("contains CR: the generator writes LF only")
			}
			if !bytes.HasSuffix(raw, []byte("}\n")) || bytes.HasSuffix(raw, []byte("\n\n")) {
				t.Fatal("must end with exactly one newline")
			}
			var top map[string]json.RawMessage
			if err := json.Unmarshal(raw, &top); err != nil {
				t.Fatal(err)
			}
			keys := make([]string, 0, len(top))
			for k := range top {
				keys = append(keys, k)
			}
			slices.Sort(keys)
			if want := []string{"data", "generatedBy", "sourceSha256"}; !slices.Equal(keys, want) {
				t.Fatalf("envelope keys %v, want %v", keys, want)
			}
			checkSortedKeys(t, raw)

			// Re-encode the generic value with the generator's layout: identical bytes.
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.UseNumber()
			var generic any
			if err := dec.Decode(&generic); err != nil {
				t.Fatal(err)
			}
			var buf bytes.Buffer
			enc := json.NewEncoder(&buf)
			enc.SetEscapeHTML(false)
			enc.SetIndent("", "  ")
			if err := enc.Encode(generic); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(buf.Bytes(), raw) {
				t.Fatal("not in the generator's canonical layout: run `npm run gen:guardian`")
			}
		})
	}
}

// checkSortedKeys walks the token stream and fails on an object whose keys are not in
// UTF-16 code unit order (JavaScript's default sort, used by the generator).
func checkSortedKeys(t *testing.T, raw []byte) {
	t.Helper()
	type frame struct {
		object  bool
		wantKey bool
		last    string
		first   bool
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	var stack []*frame
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			t.Fatal(err)
		}
		var top *frame
		if len(stack) > 0 {
			top = stack[len(stack)-1]
		}
		if top != nil && top.object && top.wantKey {
			if d, ok := tok.(json.Delim); ok && d == '}' {
				stack = stack[:len(stack)-1]
				continue
			}
			key := tok.(string)
			if !top.first && compareUTF16(top.last, key) >= 0 {
				t.Fatalf("keys not sorted: %q after %q", key, top.last)
			}
			top.last, top.first, top.wantKey = key, false, false
			continue
		}
		if top != nil && top.object {
			top.wantKey = true
		}
		if d, ok := tok.(json.Delim); ok {
			switch d {
			case '{':
				stack = append(stack, &frame{object: true, wantKey: true, first: true})
			case '[':
				stack = append(stack, &frame{})
			case ']':
				stack = stack[:len(stack)-1]
			}
		}
	}
}

func compareUTF16(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

// ---------------------------------------------------------------------------------------
// Strict decoding rejects every kind of mismatch
// ---------------------------------------------------------------------------------------

// genericRules returns rules.json's data as a generic, mutable value.
func genericRules(t *testing.T) map[string]any {
	t.Helper()
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(rulesJSON, &env); err != nil {
		t.Fatal(err)
	}
	return env.Data
}

// wrap builds a generated file around data, with a correct sourceSha256.
func wrap(t *testing.T, data any) []byte {
	t.Helper()
	var compact bytes.Buffer
	enc := json.NewEncoder(&compact)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(data); err != nil {
		t.Fatal(err)
	}
	body := bytes.TrimSuffix(compact.Bytes(), []byte("\n"))
	sum := sha256.Sum256(body)
	out, err := json.Marshal(map[string]any{
		"data":         json.RawMessage(body),
		"generatedBy":  GeneratedBy,
		"sourceSha256": hex.EncodeToString(sum[:]),
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestDecodeFileRejectsMismatches(t *testing.T) {
	points := func(d map[string]any) map[string]any { return d["points"].(map[string]any) }
	cases := []struct {
		name string
		file func(t *testing.T) []byte
		want string
	}{
		{"unchanged", func(t *testing.T) []byte { return wrap(t, genericRules(t)) }, ""},
		{"unknown field", func(t *testing.T) []byte {
			d := genericRules(t)
			points(d)["newRule"] = 5
			return wrap(t, d)
		}, `unknown field "newRule"`},
		{"missing field", func(t *testing.T) []byte {
			d := genericRules(t)
			delete(points(d), "strikePenalty")
			return wrap(t, d)
		}, "data.points.strikePenalty: in the Go struct but not in the data"},
		{"key matching only case-insensitively", func(t *testing.T) []byte {
			d := genericRules(t)
			p := points(d)
			p["StrikePenalty"] = p["strikePenalty"]
			delete(p, "strikePenalty")
			return wrap(t, d)
		}, "data.points.StrikePenalty: in the data but not in the Go struct"},
		{"wrong type", func(t *testing.T) []byte {
			d := genericRules(t)
			points(d)["strikePenalty"] = "15"
			return wrap(t, d)
		}, "cannot unmarshal string"},
		{"fractional number", func(t *testing.T) []byte {
			d := genericRules(t)
			points(d)["attemptPenaltyMultiplier"] = 1.5
			return wrap(t, d)
		}, "cannot unmarshal number 1.5"},
		{"hand edit", func(t *testing.T) []byte {
			v := Rules().Points.StrikePenalty
			from := fmt.Sprintf(`"strikePenalty": %d,`, v)
			if !bytes.Contains(rulesJSON, []byte(from)) {
				t.Fatalf("%s not in rules.json", from)
			}
			return bytes.Replace(rulesJSON, []byte(from), []byte(fmt.Sprintf(`"strikePenalty": %d,`, v+1)), 1)
		}, "edited by hand"},
		{"wrong generator", func(t *testing.T) []byte {
			return bytes.Replace(rulesJSON, []byte(GeneratedBy), []byte("scripts/other.mjs"), 1)
		}, "generatedBy"},
		{"unknown envelope field", func(t *testing.T) []byte {
			return bytes.Replace(rulesJSON, []byte(`"generatedBy"`), []byte(`"extra": 1, "generatedBy"`), 1)
		}, `unknown field "extra"`},
		{"trailing data", func(t *testing.T) []byte {
			return append(append([]byte(nil), rulesJSON...), []byte("{}")...)
		}, "trailing data"},
		{"null data", func(t *testing.T) []byte { return wrap(t, nil) }, "not an object"},
		{"array item missing a field", func(t *testing.T) []byte {
			d := genericRules(t)
			delete(d["rewardOffers"].([]any)[0].(map[string]any), "cost")
			return wrap(t, d)
		}, "data.rewardOffers[0].cost: in the Go struct but not in the data"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var v RulesSnapshot
			_, err := decodeFile("rules.json", c.file(t), &v)
			switch {
			case c.want == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case c.want == "" && !reflect.DeepEqual(&v, Rules()):
				t.Fatal("decoded value differs")
			case c.want != "" && err == nil:
				t.Fatalf("accepted; want an error containing %q", c.want)
			case c.want != "" && !strings.Contains(err.Error(), c.want):
				t.Fatalf("error %q does not contain %q", err, c.want)
			}
		})
	}
}

func TestMismatchMessage(t *testing.T) {
	msg := mismatch(errors.New("rules.json: boom"))
	for _, want := range []string{"rules.json: boom", "npm run gen:guardian", "embedded.go"} {
		if !strings.Contains(msg, want) {
			t.Errorf("panic message %q lacks %q", msg, want)
		}
	}
}

// ---------------------------------------------------------------------------------------
// catalog.json
// ---------------------------------------------------------------------------------------

func ids[T any](items []T, id func(T) string) map[string]T {
	m := make(map[string]T, len(items))
	for _, it := range items {
		m[id(it)] = it
	}
	return m
}

func TestCatalogSanity(t *testing.T) {
	c := Catalog()
	if c.Version < 1 {
		t.Fatalf("version %d", c.Version)
	}
	categories := ids(c.Categories, func(x Category) string { return x.ID })
	services := ids(c.Services, func(x Service) string { return x.ID })
	apps := ids(c.Apps, func(x App) string { return x.ID })
	if len(categories) != len(c.Categories) || len(services) != len(c.Services) || len(apps) != len(c.Apps) {
		t.Fatal("duplicate ids")
	}
	var catIDs []string
	for id := range categories {
		catIDs = append(catIDs, id)
	}
	slices.Sort(catIDs)
	if want := []string{"games", "messaging", "news", "shopping", "social", "video"}; !slices.Equal(catIDs, want) {
		t.Fatalf("categories %v, want %v", catIDs, want)
	}

	known := map[string]string{ // service id -> one domain it must block
		"youtube":   "youtube.com",
		"tiktok":    "tiktok.com",
		"instagram": "instagram.com",
		"x-twitter": "x.com",
		"twitch":    "twitch.tv",
		"netflix":   "netflix.com",
		"discord":   "discord.com",
		"roblox":    "roblox.com",
		"whatsapp":  "web.whatsapp.com",
	}
	for id, domain := range known {
		s, ok := services[id]
		if !ok {
			t.Errorf("service %q missing", id)
			continue
		}
		if !slices.Contains(s.Domains, domain) {
			t.Errorf("service %q does not block %q", id, domain)
		}
	}
	if yt := services["youtube"]; !slices.Contains(yt.Categories, "video") || yt.Name != "YouTube" {
		t.Errorf("youtube: %+v", yt)
	}

	for _, s := range c.Services {
		if s.Name == "" || s.Monogram == "" || len(s.Domains) == 0 || len(s.Aliases) == 0 {
			t.Errorf("service %q incomplete", s.ID)
		}
		for _, cat := range s.Categories {
			if _, ok := categories[cat]; !ok {
				t.Errorf("service %q: unknown category %q", s.ID, cat)
			}
		}
		for _, a := range s.AppIDs {
			if _, ok := apps[a]; !ok {
				t.Errorf("service %q: unknown app %q", s.ID, a)
			}
		}
		for _, sub := range s.ExcludedSubdomains {
			if !underAny(sub, s.Domains) {
				t.Errorf("service %q: excluded subdomain %q is under none of its domains", s.ID, sub)
			}
		}
	}
	for _, cat := range c.Categories {
		for _, a := range cat.AppIDs {
			if _, ok := apps[a]; !ok {
				t.Errorf("category %q: unknown app %q", cat.ID, a)
			}
		}
	}
	for _, a := range append(slices.Clone(c.Apps), c.StudyAppWhitelist...) {
		p := a.Processes
		if len(p.Win)+len(p.Mac)+len(p.Linux) == 0 {
			t.Errorf("app %q has no process names", a.ID)
		}
	}
	if len(c.StudyWhitelist) == 0 || len(c.ProtectedProcesses) == 0 || len(c.AlwaysAllowedHosts) == 0 {
		t.Error("empty study whitelist, protected processes or always-allowed hosts")
	}
	if !slices.Contains(c.ProtectedProcesses, "explorer.exe") {
		t.Error("explorer.exe is not protected")
	}
	// Every reward offer names a catalog service (cross-file consistency).
	for _, o := range Rules().RewardOffers {
		if _, ok := services[o.ServiceID]; !ok {
			t.Errorf("reward offer %q: unknown service %q", o.ID, o.ServiceID)
		}
	}
}

func underAny(host string, parents []string) bool {
	for _, p := range parents {
		if strings.HasSuffix(host, "."+p) {
			return true
		}
	}
	return false
}

// Every service and app id the shared catalog vectors expect exists in the embedded
// catalog: a stale catalog.json fails here even without running the generator.
func TestCatalogMatchesSharedVectors(t *testing.T) {
	var fixture struct {
		Vectors []struct {
			Fn     string          `json:"fn"`
			Expect json.RawMessage `json:"expect"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(readShared(t, "test/fixtures/catalog-vectors.json"), &fixture); err != nil {
		t.Fatal(err)
	}
	services := ids(Catalog().Services, func(x Service) string { return x.ID })
	apps := ids(Catalog().Apps, func(x App) string { return x.ID })
	checked := 0
	check := func(kind, id string) {
		t.Helper()
		checked++
		var ok bool
		if kind == "svc" {
			_, ok = services[id]
		} else {
			_, ok = apps[id]
		}
		if !ok {
			t.Errorf("vectors expect %s %q, missing from catalog.json", kind, id)
		}
	}
	for _, v := range fixture.Vectors {
		switch v.Fn {
		case "findServiceByDomain":
			var id *string
			if err := json.Unmarshal(v.Expect, &id); err != nil {
				t.Fatal(err)
			}
			if id != nil {
				check("svc", *id)
			}
		case "domainTargetKey", "processTargetKey":
			var key string
			if err := json.Unmarshal(v.Expect, &key); err != nil {
				t.Fatal(err)
			}
			if kind, id, ok := strings.Cut(key, ":"); ok && (kind == "svc" || kind == "app") {
				check(kind, id)
			}
		case "findAllowDistraction":
			var found *struct {
				ServiceID *string `json:"serviceId"`
				AppID     *string `json:"appId"`
			}
			if err := json.Unmarshal(v.Expect, &found); err != nil {
				t.Fatal(err)
			}
			if found != nil && found.ServiceID != nil {
				check("svc", *found.ServiceID)
			}
			if found != nil && found.AppID != nil {
				check("app", *found.AppID)
			}
		}
	}
	if checked < 5 {
		t.Fatalf("only %d ids checked: did catalog-vectors.json change shape?", checked)
	}
}

func TestProcessNamesFor(t *testing.T) {
	p := ProcessNames{Win: []string{"a.exe"}, Mac: []string{"A"}, Linux: []string{"a"}}
	for goos, want := range map[string]string{"windows": "a.exe", "darwin": "A", "linux": "a"} {
		got := p.For(PlatformForGOOS(goos))
		if len(got) != 1 || got[0] != want {
			t.Errorf("%s: %v", goos, got)
		}
	}
	if PlatformForGOOS("plan9") != "" || p.For("") != nil {
		t.Error("unknown OS must have no names")
	}
}

// ---------------------------------------------------------------------------------------
// rules.json
// ---------------------------------------------------------------------------------------

// tsBlock returns the source of `marker` up to the next line that starts with }, ] or ).
func tsBlock(t *testing.T, src []byte, marker string) string {
	t.Helper()
	s := string(src)
	i := strings.Index(s, marker)
	if i < 0 {
		t.Fatalf("%q not found", marker)
	}
	s = s[i:]
	end := regexp.MustCompile(`(?m)^[\]})]`).FindStringIndex(s)
	if end == nil {
		t.Fatalf("end of %q not found", marker)
	}
	return s[:end[0]]
}

// plainInts returns the `key: 123_456,` lines of a TS object literal (expressions such
// as `5 * 60_000` are skipped; the generator evaluates those).
func plainInts(block string) map[string]int {
	re := regexp.MustCompile(`(?m)^\s+(\w+): ([0-9][0-9_]*),\s*$`)
	out := map[string]int{}
	for _, m := range re.FindAllStringSubmatch(block, -1) {
		n, err := strconv.Atoi(strings.ReplaceAll(m[2], "_", ""))
		if err == nil {
			out[m[1]] = n
		}
	}
	return out
}

// asMap re-encodes a struct as a generic map keyed by its JSON names.
func asMap(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func compareInts(t *testing.T, what string, source map[string]int, embedded map[string]any, required []string) {
	t.Helper()
	for _, k := range required {
		if _, ok := source[k]; !ok {
			t.Errorf("%s: %s is no longer a plain literal in the TS source; update this test", what, k)
		}
	}
	for k, want := range source {
		got, ok := embedded[k].(float64)
		if !ok || got != float64(want) {
			t.Errorf("%s.%s: source %d, embedded %v (stale: run `npm run gen:guardian`)", what, k, want, embedded[k])
		}
	}
}

// Spot checks against points.ts itself, so a stale rules.json fails without Node.
func TestRulesMatchPointsSource(t *testing.T) {
	src := readShared(t, "src/points.ts")
	r := Rules()

	m := regexp.MustCompile(`export const RULES_VERSION = (\d+);`).FindSubmatch(src)
	if m == nil {
		t.Fatal("RULES_VERSION not found")
	}
	if v, _ := strconv.Atoi(string(m[1])); v != r.RulesVersion {
		t.Errorf("rulesVersion: source %d, embedded %d", v, r.RulesVersion)
	}

	compareInts(t, "points", plainInts(tsBlock(t, src, "export const POINT_RULES")), asMap(t, r.Points), []string{
		"blockPointsPerMinute", "studyPointsPerFocusMinute", "cleanSessionBonus", "attemptBasePenalty",
		"attemptPenaltyMultiplier", "attemptPenaltyCap", "strikePenalty", "punishmentPenalty",
		"emergencyMinPenalty",
	})
	compareInts(t, "study", plainInts(tsBlock(t, src, "export const STUDY_RULES")), asMap(t, r.Study), []string{
		"maxStrikes", "heartbeatIntervalMs",
	})

	emergency := tsBlock(t, src, "export const EMERGENCY_RULES")
	cd := regexp.MustCompile(`countdownMinutes: Object\.freeze\(\{ normal: (\d+), strict: (\d+) \}\)`).FindStringSubmatch(emergency)
	if cd == nil {
		t.Fatal("countdownMinutes not found in EMERGENCY_RULES")
	}
	if cd[1] != strconv.Itoa(r.Emergency.CountdownMinutes.Normal) || cd[2] != strconv.Itoa(r.Emergency.CountdownMinutes.Strict) {
		t.Errorf("countdown: source %s/%s, embedded %+v", cd[1], cd[2], r.Emergency.CountdownMinutes)
	}
	if !strings.Contains(emergency, "'"+r.Emergency.Phrases.ES+"'") || !strings.Contains(emergency, "'"+r.Emergency.Phrases.EN+"'") {
		t.Error("emergency phrases differ from points.ts")
	}

	offerRe := regexp.MustCompile(`\{ id: '([^']+)', serviceId: '([^']+)', minutes: (\d+), cost: (\d+) \}`)
	var offers []RewardOffer
	for _, m := range offerRe.FindAllStringSubmatch(tsBlock(t, src, "export const REWARD_OFFERS"), -1) {
		minutes, _ := strconv.Atoi(m[3])
		cost, _ := strconv.Atoi(m[4])
		offers = append(offers, RewardOffer{ID: m[1], ServiceID: m[2], Minutes: minutes, Cost: cost})
	}
	if len(offers) == 0 || !reflect.DeepEqual(offers, r.RewardOffers) {
		t.Errorf("reward offers: source %+v, embedded %+v", offers, r.RewardOffers)
	}
}

// The shared parity vectors agree with the embedded values.
func TestRulesMatchPointsVectors(t *testing.T) {
	var fixture struct {
		RulesVersion int `json:"rulesVersion"`
		Functions    []struct {
			Fn     string            `json:"fn"`
			Args   []json.RawMessage `json:"args"`
			Expect json.RawMessage   `json:"expect"`
		} `json:"functions"`
	}
	if err := json.Unmarshal(readShared(t, "test/fixtures/points-vectors.json"), &fixture); err != nil {
		t.Fatal(err)
	}
	r := Rules()
	if fixture.RulesVersion != r.RulesVersion {
		t.Errorf("points-vectors rulesVersion %d, embedded %d", fixture.RulesVersion, r.RulesVersion)
	}
	want := map[string]int{
		"attemptPenalty [0]":                     r.Points.AttemptBasePenalty,
		`emergencyCountdownMinutes [["normal"]]`: r.Emergency.CountdownMinutes.Normal,
		`emergencyCountdownMinutes [["strict"]]`: r.Emergency.CountdownMinutes.Strict,
		"xpForLevel [2]":                         r.Points.LevelXPStep * 2,
	}
	found := 0
	for _, f := range fixture.Functions {
		args, err := json.Marshal(f.Args)
		if err != nil {
			t.Fatal(err)
		}
		w, ok := want[f.Fn+" "+string(args)]
		if !ok {
			continue
		}
		found++
		var got int
		if err := json.Unmarshal(f.Expect, &got); err != nil || got != w {
			t.Errorf("%s %s: vectors expect %s, embedded rules give %d", f.Fn, args, f.Expect, w)
		}
	}
	if found != len(want) {
		t.Errorf("found %d of %d spot-check vectors", found, len(want))
	}
	// A few invariants the ledger relies on.
	p := r.Points
	if p.AttemptBasePenalty <= 0 || p.AttemptPenaltyCap < p.AttemptBasePenalty || p.AttemptPenaltyMultiplier < 1 {
		t.Errorf("attempt penalties: %+v", p)
	}
	if p.DailyGoalMinMinutes > p.DailyGoalDefaultMinutes || p.DailyGoalDefaultMinutes > p.DailyGoalMaxMinutes {
		t.Errorf("daily goal range: %+v", p)
	}
	if !slices.Equal(p.EarningBlockKinds, []string{"manual", "schedule"}) {
		t.Errorf("earningBlockKinds %v", p.EarningBlockKinds)
	}
	for _, rng := range []TunableRange{r.Study.DoubtAfterMs, r.Study.StrikeAfterDoubtMs, r.Study.NoFaceStrikeMs, r.Study.FocusScoreThreshold, r.Study.PunishmentMinutes} {
		if rng.Min > rng.Default || rng.Default > rng.Max {
			t.Errorf("tunable range %+v", rng)
		}
	}
}

// ---------------------------------------------------------------------------------------
// api.json
// ---------------------------------------------------------------------------------------

func TestAPIMatchesSource(t *testing.T) {
	src := readShared(t, "src/guardian-api.ts")
	a := API()

	// Route table: same count, order, methods, paths, auth and flags as GUARDIAN_ENDPOINTS.
	epRe := regexp.MustCompile(`(?m)^\s+ep\('([^']+)', '([A-Z]+)', '([^']+)', '([a-z_]+)'(?:, \{([^}]*)\})?\),\s*$`)
	block := tsBlock(t, src, "export const GUARDIAN_ENDPOINTS")
	if n := strings.Count(block, "ep('"); n != len(a.Endpoints) {
		t.Fatalf("GUARDIAN_ENDPOINTS has %d routes, api.json %d", n, len(a.Endpoints))
	}
	matches := epRe.FindAllStringSubmatch(block, -1)
	if len(matches) != len(a.Endpoints) {
		t.Fatalf("parsed %d routes, api.json has %d", len(matches), len(a.Endpoints))
	}
	for i, m := range matches {
		want := EndpointSpec{
			ID: m[1], Method: m[2], Path: m[3], Auth: m[4],
			IdempotencyKey: strings.Contains(m[5], "idem: true"),
			LongPoll:       strings.Contains(m[5], "longPoll: true"),
			TestOnly:       strings.Contains(m[5], "testOnly: true"),
		}
		if a.Endpoints[i] != want {
			t.Errorf("route %d: source %+v, embedded %+v", i, want, a.Endpoints[i])
		}
	}

	// Error table.
	errRe := regexp.MustCompile(`(?m)^\s+([a-z_]+): (\d{3}),\s*$`)
	errs := map[string]int{}
	for _, m := range errRe.FindAllStringSubmatch(tsBlock(t, src, "export const GUARDIAN_ERROR_STATUS"), -1) {
		errs[m[1]], _ = strconv.Atoi(m[2])
	}
	if len(errs) == 0 || !reflect.DeepEqual(errs, a.Errors) {
		t.Errorf("errors: source %v, embedded %v", errs, a.Errors)
	}

	compareInts(t, "limits", plainInts(tsBlock(t, src, "export const GUARDIAN_LIMITS")), asMap(t, a.Limits), []string{
		"blockMinMinutes", "blockMaxMinutes", "maxBodyBytes", "longPollMaxMs",
	})
	if m := regexp.MustCompile(`export const DEFAULT_GUARDIAN_PORT = (\d+);`).FindSubmatch(src); m == nil || string(m[1]) != strconv.Itoa(a.DefaultPort) {
		t.Errorf("defaultPort %d differs from the source", a.DefaultPort)
	}
	if m := regexp.MustCompile(`export const GUARDIAN_API_VERSION = (\d+);`).FindSubmatch(src); m == nil || string(m[1]) != strconv.Itoa(a.APIVersion) {
		t.Errorf("apiVersion %d differs from the source", a.APIVersion)
	}
}

func TestAPISanity(t *testing.T) {
	a := API()
	seenID := map[string]bool{}
	seenRoute := map[string]bool{}
	for _, e := range a.Endpoints {
		route := e.Method + " " + e.Path
		if seenID[e.ID] || seenRoute[route] {
			t.Errorf("duplicate route %q (%s)", e.ID, route)
		}
		seenID[e.ID], seenRoute[route] = true, true
		if !strings.HasPrefix(e.Path, "/v1/") {
			t.Errorf("%s: path %q", e.ID, e.Path)
		}
		if e.TestOnly != strings.HasPrefix(e.Path, "/v1/_test/") {
			t.Errorf("%s: testOnly %v for %q", e.ID, e.TestOnly, e.Path)
		}
		// No operation ends, shortens, edits or deletes a block (§8.7).
		if strings.HasPrefix(e.Path, "/v1/blocks") {
			ok := e.Method == "GET" || (e.Method == "POST" && (e.Path == "/v1/blocks" || e.Path == "/v1/blocks/{id}/extend"))
			if !ok {
				t.Errorf("%s: forbidden block route %s", e.ID, route)
			}
		}
	}
	for _, id := range []string{"health", "getState", "createBlock", "extendBlock", "reportAttempt", "getExtRules"} {
		if !seenID[id] {
			t.Errorf("endpoint %q missing", id)
		}
	}
	for code, status := range a.Errors {
		if status < 400 || status > 599 {
			t.Errorf("error %q: status %d", code, status)
		}
	}
	if a.Errors["internal"] != 500 || a.Errors["validation_failed"] != 422 || a.Errors["not_found"] != 404 {
		t.Errorf("error spot checks: %v", a.Errors)
	}
	if a.Limits.BlockMinMinutes <= 0 || a.Limits.BlockMaxMinutes < a.Limits.BlockMinMinutes || a.Limits.MaxBodyBytes <= 0 {
		t.Errorf("limits: %+v", a.Limits)
	}
	if a.DefaultPort <= 1024 || a.DefaultPort > 65535 || a.APIVersion < 1 {
		t.Errorf("port %d, api version %d", a.DefaultPort, a.APIVersion)
	}
	if len(a.ChromiumExtensionID) != 32 || !slices.Contains(a.DataDeleteConfirmWords, "BORRAR") {
		t.Errorf("extension id %q, confirm words %v", a.ChromiumExtensionID, a.DataDeleteConfirmWords)
	}
	if len(a.Capabilities) == 0 || slices.Contains(a.Capabilities, "testhooks") || len(a.Problems) == 0 {
		t.Errorf("capabilities %v, problems %v", a.Capabilities, a.Problems)
	}
}

func TestDefaultSettings(t *testing.T) {
	s := API().DefaultSettings
	r := Rules()
	if s.Timezone != nil {
		t.Errorf("default timezone %q, want null", *s.Timezone)
	}
	if s.DailyGoalMinutes != r.Points.DailyGoalDefaultMinutes {
		t.Errorf("dailyGoalMinutes %d, rules default %d", s.DailyGoalMinutes, r.Points.DailyGoalDefaultMinutes)
	}
	if s.Punishment.Level != r.Study.DefaultPunishmentLevel || s.Punishment.Minutes != r.Study.PunishmentMinutes.Default {
		t.Errorf("punishment %+v, rules %q/%d", s.Punishment, r.Study.DefaultPunishmentLevel, r.Study.PunishmentMinutes.Default)
	}
	if !s.AttemptPenalties || !s.ServerTimeCheck || s.CloseBrowsersWithoutExtension {
		t.Errorf("default toggles %+v", s)
	}
	if s.StudyWhitelist.ExtraDomains == nil || len(s.StudyWhitelist.ExtraDomains) != 0 {
		t.Errorf("extraDomains %#v", s.StudyWhitelist.ExtraDomains)
	}
}

func TestGuardianSettingsClone(t *testing.T) {
	c := API().DefaultSettings.Clone()
	if !reflect.DeepEqual(c, API().DefaultSettings) {
		t.Fatal("clone differs")
	}
	tz := "Europe/Madrid"
	c.Timezone = &tz
	c.StudyWhitelist.ExtraDomains = append(c.StudyWhitelist.ExtraDomains, "example.org")
	d := c.Clone()
	*d.Timezone = "UTC"
	d.StudyWhitelist.ExtraDomains[0] = "changed.org"
	if *c.Timezone != "Europe/Madrid" || c.StudyWhitelist.ExtraDomains[0] != "example.org" {
		t.Fatal("clone shares memory with the original")
	}
	if API().DefaultSettings.Timezone != nil || len(API().DefaultSettings.StudyWhitelist.ExtraDomains) != 0 {
		t.Fatal("embedded defaults were modified")
	}
	if b, _ := json.Marshal(API().DefaultSettings.Clone()); !bytes.Contains(b, []byte(`"extraDomains":[]`)) {
		t.Fatalf("empty list must stay [] after Clone: %s", b)
	}
}

func TestDurations(t *testing.T) {
	if Millis(1500) != 1500*time.Millisecond || Minutes(2) != 2*time.Minute {
		t.Fatal("conversions")
	}
	if Millis(Rules().Points.AttemptDedupeWindowMs) <= 0 {
		t.Fatal("dedupe window")
	}
}
