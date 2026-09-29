// Package catalog is the guardian's port of the catalog helpers of packages/shared
// (packages/shared/src/catalog and the semantic checks at the end of
// packages/shared/src/guardian-api.ts), reading its data from the embedded catalog
// snapshot (guardian/internal/embedded, generated from catalogSnapshot()).
//
// # What it provides
//
//   - Block targets: [Catalog.ResolveTargets] expands service, category and app ids plus
//     custom domains and process names into the hosts and process names to block on one
//     platform (categories add their services and category-wide apps; services add their
//     excludedSubdomains; always-allowed hosts are never blocked), as the guardian stores
//     them with each block (docs/ARCHITECTURE.md §5.2).
//   - Lookups: services, categories, apps and browsers by id, [Catalog.FindServiceByDomain],
//     [Catalog.FindAppByProcessName], [Catalog.FindServiceByProcessName],
//     [Catalog.BrowsersForProcess], always-allowed hosts, protected processes and protected
//     domains, the study whitelist (domains, host patterns and apps).
//   - Validation shared with the app: [IsValidDomain], [NormalizeDomain],
//     [Catalog.ExpandDomainVariants], [IsValidProcessName], [ProcessNameKey],
//     [Catalog.IsProtectedProcessName], [Catalog.IsProtectedDomain],
//     [Catalog.FindAllowDistraction], [TextFieldIssue] and [UTF16Len].
//   - Attempt dedupe keys: [Catalog.DomainTargetKey], [ServiceTargetKey] and
//     [Catalog.ProcessTargetKey].
//
// # Parity with TypeScript
//
// Every function mirrors its TypeScript namesake, and catalog_vectors_test.go runs
// packages/shared/test/fixtures/catalog-vectors.json in place, like the vitest suite. The
// rules that matter for parity:
//
//   - Text lengths count UTF-16 code units, as JavaScript's .length does ([UTF16Len]).
//   - Sorting uses UTF-16 code unit order, as Array.prototype.sort does.
//   - Process names are compared with [ProcessNameKey]: Unicode NFC, then lowercase on
//     Windows and macOS, exact on Linux. Lowercasing follows String.prototype.toLowerCase
//     (including İ and the final sigma).
//   - [NormalizeDomain] follows what new URL(…).hostname does for the input TypeScript
//     gives it (WHATWG URL host parsing).
//
// The guardian avoids golang.org/x/text, so the Unicode data this needs is generated into
// normtable.go and idnatable.go (Unicode 14.0): canonical normalization (NFC, NFD) is
// complete. Internationalized domain names are mapped with the part of UTS #46 that needs
// no other tables (lowercase, NFC, full-width ASCII, ideographic full stops, ignored
// characters) and then Punycode. Where UTS #46 would map a character through
// compatibility normalization or case folding, or apply the Bidi Rule (right-to-left
// scripts), [NormalizeDomain] fails instead: it never returns a domain TypeScript would
// not, at worst none. Valid xn-- labels are accepted in every script, and the guardian
// only receives canonical domains (the API requires [IsValidDomain]). Lone UTF-16
// surrogates, which JSON can carry and JavaScript rejects as invalid characters, arrive
// in Go as U+FFFD and are treated as such.
//
// # Concurrency
//
// A [Catalog] is immutable after [New] and safe for concurrent use; every method returns
// fresh slices or read-only views of the embedded data (never modify what they point
// to). [Default] is built once, at package initialization, from embedded.Catalog().
package catalog
