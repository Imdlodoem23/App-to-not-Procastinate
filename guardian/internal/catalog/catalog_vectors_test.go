package catalog

import (
	"encoding/json"
	"reflect"
	"slices"
	"testing"
)

// The shared catalog and validation vectors, run in place: the same file the vitest
// suite runs (packages/shared/test/catalog-vectors.test.ts). Both implementations must
// pass it unchanged; never regenerate its expectations from either one.

type vector struct {
	Name   string            `json:"name"`
	Fn     string            `json:"fn"`
	Args   []json.RawMessage `json:"args"`
	Expect json.RawMessage   `json:"expect"`
}

type vectorFile struct {
	FormatVersion int      `json:"formatVersion"`
	Vectors       []vector `json:"vectors"`
}

func arg[T any](t *testing.T, v vector, i int) T {
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

// vectorRunners returns one runner per TypeScript function name. Each returns a value
// that encodes to the JSON the vector expects.
func vectorRunners(c *Catalog) map[string]func(t *testing.T, v vector) any {
	return map[string]func(t *testing.T, v vector) any{
		"isValidDomain": func(t *testing.T, v vector) any {
			return IsValidDomain(arg[string](t, v, 0))
		},
		"expandDomainVariants": func(t *testing.T, v vector) any {
			return c.ExpandDomainVariants(arg[string](t, v, 0))
		},
		"isValidProcessName": func(t *testing.T, v vector) any {
			return IsValidProcessName(arg[string](t, v, 0))
		},
		"isProtectedProcessName": func(t *testing.T, v vector) any {
			return c.IsProtectedProcessName(arg[string](t, v, 0))
		},
		"processNameKey": func(t *testing.T, v vector) any {
			return ProcessNameKey(arg[string](t, v, 0), arg[Platform](t, v, 1))
		},
		"findServiceByDomain": func(t *testing.T, v vector) any {
			if svc := c.FindServiceByDomain(arg[string](t, v, 0)); svc != nil {
				return svc.ID
			}
			return nil
		},
		"matchesHostPattern": func(t *testing.T, v vector) any {
			return MatchesHostPattern(arg[string](t, v, 0), arg[string](t, v, 1))
		},
		"domainTargetKey": func(t *testing.T, v vector) any {
			return c.DomainTargetKey(arg[string](t, v, 0))
		},
		"processTargetKey": func(t *testing.T, v vector) any {
			return c.ProcessTargetKey(arg[string](t, v, 0), arg[Platform](t, v, 1))
		},
		"textFieldIssue": func(t *testing.T, v vector) any {
			if issue := TextFieldIssue(arg[TextField](t, v, 0), arg[string](t, v, 1)); issue != "" {
				return issue
			}
			return nil
		},
		"findAllowDistraction": func(t *testing.T, v vector) any {
			entries := arg[struct {
				Domains   []string `json:"domains"`
				Processes []string `json:"processes"`
			}](t, v, 0)
			paths := arg[struct {
				Domains   string `json:"domains"`
				Processes string `json:"processes"`
			}](t, v, 1)
			var platform Platform
			if len(v.Args) > 2 {
				platform = arg[Platform](t, v, 2)
			}
			found := c.FindAllowDistraction(
				AllowEntries{Domains: entries.Domains, Processes: entries.Processes},
				AllowPaths{Domains: paths.Domains, Processes: paths.Processes},
				platform,
			)
			if found == nil {
				return nil
			}
			return found
		},
	}
}

func TestCatalogVectors(t *testing.T) {
	var file vectorFile
	if err := json.Unmarshal(readShared(t, "test/fixtures/catalog-vectors.json"), &file); err != nil {
		t.Fatal(err)
	}
	if file.FormatVersion != 1 {
		t.Fatalf("formatVersion %d, want 1", file.FormatVersion)
	}
	runners := vectorRunners(testCatalog(t))

	// A runner for every function, every runner used, unique names (like vitest).
	used := map[string]bool{}
	names := map[string]bool{}
	for _, v := range file.Vectors {
		used[v.Fn] = true
		if names[v.Name] {
			t.Errorf("duplicate vector name %q", v.Name)
		}
		names[v.Name] = true
	}
	var missing, unused []string
	for fn := range used {
		if runners[fn] == nil {
			missing = append(missing, fn)
		}
	}
	for fn := range runners {
		if !used[fn] {
			unused = append(unused, fn)
		}
	}
	slices.Sort(missing)
	slices.Sort(unused)
	if len(missing) > 0 || len(unused) > 0 {
		t.Fatalf("functions without a runner: %v; runners without vectors: %v", missing, unused)
	}

	for _, v := range file.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			got := runners[v.Fn](t, v)
			gotJSON, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var want, have any
			if err := json.Unmarshal(v.Expect, &want); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(gotJSON, &have); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(want, have) {
				t.Errorf("%s(%s) = %s, want %s", v.Fn, joinArgs(v.Args), gotJSON, v.Expect)
			}
		})
	}
}

func joinArgs(args []json.RawMessage) string {
	out := ""
	for i, a := range args {
		if i > 0 {
			out += ", "
		}
		if len(a) > 80 {
			out += string(a[:77]) + "…"
		} else {
			out += string(a)
		}
	}
	return out
}
