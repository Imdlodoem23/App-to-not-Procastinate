package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/imdlodoem23/centrate/guardian/internal/embedded"
)

// sharedDir is packages/shared, relative to this package.
var sharedDir = filepath.Join("..", "..", "..", "packages", "shared")

func readShared(t testing.TB, rel string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(sharedDir, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("read packages/shared/%s: %v", rel, err)
	}
	return b
}

var (
	commentRE   = regexp.MustCompile(`(?s)/\*.*?\*/|//[^\n]*`)
	tsStringRE  = regexp.MustCompile(`'((?:[^'\\]|\\.)*)'`)
	tsKeyRE     = regexp.MustCompile(`([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:`)
	tsTrailerRE = regexp.MustCompile(`,(\s*[\]}])`)
)

// tsArrayJSON returns the array literal exported by a packages/shared data file
// (`export const X: readonly T[] = [ … ];`) as JSON. It understands the subset those
// files use: comments, single-quoted strings without escapes, bare keys and trailing
// commas.
func tsArrayJSON(t testing.TB, rel string) []byte {
	t.Helper()
	src := commentRE.ReplaceAllString(string(readShared(t, rel)), "")
	start := strings.Index(src, "= [")
	end := strings.LastIndex(src, "];")
	if start < 0 || end < start {
		t.Fatalf("packages/shared/%s: no exported array literal", rel)
	}
	body := src[start+2 : end+1]
	if strings.Contains(body, `\`) || strings.Contains(body, `"`) {
		t.Fatalf("packages/shared/%s: escapes or double quotes are not supported here", rel)
	}
	body = tsStringRE.ReplaceAllString(body, `"$1"`)
	body = tsKeyRE.ReplaceAllString(body, `$1"$2":`)
	body = tsTrailerRE.ReplaceAllString(body, "$1")
	return []byte(body)
}

// sharedExtras reads the §17 catalog lists straight from the TypeScript data files.
func sharedExtras(t testing.TB) extras {
	t.Helper()
	var x extras
	for _, f := range []struct {
		rel string
		v   any
	}{
		{"src/catalog/data/browsers.ts", &x.Browsers},
		{"src/catalog/data/protected-domains.ts", &x.ProtectedDomains},
		{"src/catalog/data/public-suffixes.ts", &x.MultiLabelSuffixes},
	} {
		if err := json.Unmarshal(tsArrayJSON(t, f.rel), f.v); err != nil {
			t.Fatalf("packages/shared/%s: %v", f.rel, err)
		}
	}
	return x
}

var (
	testCatalogOnce sync.Once
	testCatalogVal  *Catalog
)

// testCatalog is Default() when the embedded snapshot carries the §17 fields (browsers,
// protectedDomains, multiLabelSuffixes). Until catalog.json is regenerated with them, it
// is the embedded catalog plus those lists read from the TypeScript sources, so the
// shared vectors run against the same data either way.
func testCatalog(t testing.TB) *Catalog {
	t.Helper()
	if Default().extras.present() {
		return Default()
	}
	testCatalogOnce.Do(func() { testCatalogVal = newCatalog(embedded.Catalog(), sharedExtras(t)) })
	return testCatalogVal
}
