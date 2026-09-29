package engine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The shared daily-limit vectors, run in place: the same file the vitest suite runs
// (packages/shared/test/limits.test.ts). Both implementations must pass it unchanged;
// never regenerate its expectations from either one.

type limitVector struct {
	Name   string            `json:"name"`
	Fn     string            `json:"fn"`
	Args   []json.RawMessage `json:"args"`
	Expect json.RawMessage   `json:"expect"`
}

func limitArg[T any](t *testing.T, v limitVector, i int) T {
	t.Helper()
	var out T
	if i >= len(v.Args) {
		t.Fatalf("%s: missing argument %d", v.Name, i)
	}
	if err := json.Unmarshal(v.Args[i], &out); err != nil {
		t.Fatalf("%s: argument %d: %v", v.Name, i, err)
	}
	return out
}

func TestLimitVectors(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "shared", "test", "fixtures", "limits-vectors.json"))
	if err != nil {
		t.Fatalf("read the vectors: %v", err)
	}
	var file struct {
		FormatVersion int           `json:"formatVersion"`
		Vectors       []limitVector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if file.FormatVersion != 1 {
		t.Fatalf("formatVersion %d", file.FormatVersion)
	}
	defaultSlack := int64(limits().UsageSlackMs)
	runners := map[string]func(t *testing.T, v limitVector) any{
		"splitLimitChange": func(t *testing.T, v limitVector) any {
			applied, pending := splitLimitChange(limitArg[DailyLimitDefinition](t, v, 0), limitArg[DailyLimitDefinition](t, v, 1))
			return map[string]any{"applied": applied, "pending": pending}
		},
		"limitDefinitionWeakens": func(t *testing.T, v limitVector) any {
			return limitDefinitionWeakens(limitArg[DailyLimitDefinition](t, v, 0), limitArg[DailyLimitDefinition](t, v, 1))
		},
		"pendingLimitDelayKept": func(t *testing.T, v limitVector) any {
			return pendingLimitDelayKept(limitArg[*DailyLimitDefinition](t, v, 0), limitArg[*DailyLimitDefinition](t, v, 1))
		},
		"clampUsageInterval": func(t *testing.T, v limitVector) any {
			slack := defaultSlack
			if len(v.Args) > 2 {
				slack = limitArg[int64](t, v, 2)
			}
			return clampUsageInterval(limitArg[int64](t, v, 0), limitArg[*int64](t, v, 1), slack)
		},
		"limitUsageCredit": func(t *testing.T, v limitVector) any {
			in := limitArg[struct {
				NowMs           int64  `json:"nowMs"`
				DayStartMs      int64  `json:"dayStartMs"`
				IntervalMs      int64  `json:"intervalMs"`
				ReportedMs      int64  `json:"reportedMs"`
				CreditedUntilMs int64  `json:"creditedUntilMs"`
				SlackMs         *int64 `json:"slackMs"`
			}](t, v, 0)
			slack := defaultSlack
			if in.SlackMs != nil {
				slack = *in.SlackMs
			}
			c, until := limitUsageCredit(in.NowMs, in.DayStartMs, in.IntervalMs, in.ReportedMs, in.CreditedUntilMs, slack)
			return map[string]int64{"creditMs": c, "creditedUntilMs": until}
		},
	}
	seen := map[string]int{}
	for _, v := range file.Vectors {
		run, ok := runners[v.Fn]
		if !ok {
			t.Errorf("%s: no Go port of %s", v.Name, v.Fn)
			continue
		}
		seen[v.Fn]++
		got, err := json.Marshal(run(t, v))
		if err != nil {
			t.Fatal(err)
		}
		var g, w any
		if err := json.Unmarshal(got, &g); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(v.Expect, &w); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(g, w) {
			t.Errorf("%s (%s):\n got %s\nwant %s", v.Name, v.Fn, got, v.Expect)
		}
	}
	for fn := range runners {
		if seen[fn] == 0 {
			t.Errorf("no vector exercises %s", fn)
		}
	}
}
