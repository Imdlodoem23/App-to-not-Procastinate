package catalog

import (
	"encoding/json"
	"fmt"
)

// extras are the catalogSnapshot() fields added by docs/ARCHITECTURE.md §17 item 1
// (browsers, protectedDomains, multiLabelSuffixes). They are read by field name through
// the snapshot's JSON form, so this package works both with an embedded.CatalogSnapshot
// that does not declare them yet (they are then empty) and with one that does, whatever
// Go type it gives them.
//
// TODO(embedded owner): once embedded.CatalogSnapshot declares Browsers,
// ProtectedDomains and MultiLabelSuffixes, read them directly here and drop the JSON
// round trip.
type extras struct {
	Browsers           []Browser `json:"browsers"`
	ProtectedDomains   []string  `json:"protectedDomains"`
	MultiLabelSuffixes []string  `json:"multiLabelSuffixes"`
}

// extrasOf reads the §17 fields of snap, an *embedded.CatalogSnapshot (any value whose
// JSON form is the catalogSnapshot() object).
func extrasOf(snap any) (extras, error) {
	var x extras
	raw, err := json.Marshal(snap)
	if err != nil {
		return x, fmt.Errorf("encode the catalog snapshot: %w", err)
	}
	if err := json.Unmarshal(raw, &x); err != nil {
		return x, fmt.Errorf("read browsers, protectedDomains and multiLabelSuffixes: %w", err)
	}
	return x, nil
}

// present reports whether the snapshot carried the §17 fields.
func (x extras) present() bool {
	return len(x.Browsers) > 0 && len(x.ProtectedDomains) > 0 && len(x.MultiLabelSuffixes) > 0
}
