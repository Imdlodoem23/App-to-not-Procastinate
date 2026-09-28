package store

import (
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"golang.org/x/sys/windows/registry"
)

// The registry anchor round-trips under HKEY_CURRENT_USER (no administrator rights
// needed); OSAnchor uses the same code under HKLM.
func TestRegistryAnchorRoundTrip(t *testing.T) {
	path := fmt.Sprintf(`SOFTWARE\CentrateTest\%d-%d`, os.Getpid(), time.Now().UnixNano())
	r := &RegistryAnchor{Root: registry.CURRENT_USER, Path: path, Value: "Anchor"}
	t.Cleanup(func() {
		_ = registry.DeleteKey(registry.CURRENT_USER, path)
		_ = registry.DeleteKey(registry.CURRENT_USER, `SOFTWARE\CentrateTest`)
	})
	if _, ok, err := r.Load(); ok || err != nil {
		t.Fatalf("empty: %v %v", ok, err)
	}
	a := sampleAnchor()
	if err := r.Save(a); err != nil {
		t.Fatal(err)
	}
	got, ok, err := r.Load()
	if !ok || err != nil || !reflect.DeepEqual(got, a) {
		t.Fatalf("%+v %v %v", got, ok, err)
	}
	if err := r.Remove(); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := r.Load(); ok || err != nil {
		t.Fatalf("after Remove: %v %v", ok, err)
	}
	if err := r.Remove(); err != nil {
		t.Fatal("second Remove")
	}
	if a, ok := OSAnchor().(*RegistryAnchor); !ok || a.Root != registry.LOCAL_MACHINE || a.Path != `SOFTWARE\Centrate\Guardian` {
		t.Fatalf("OSAnchor %#v", OSAnchor())
	}
}
