package procwatch

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unicode/utf16"
)

// verBlock encodes one VS_VERSIONINFO block.
func verBlock(key string, typ uint16, value []byte, valueLen uint16, children ...[]byte) []byte {
	var b bytes.Buffer
	b.Write([]byte{0, 0})
	_ = binary.Write(&b, binary.LittleEndian, valueLen)
	_ = binary.Write(&b, binary.LittleEndian, typ)
	for _, c := range utf16.Encode([]rune(key + "\x00")) {
		_ = binary.Write(&b, binary.LittleEndian, c)
	}
	pad := func() {
		for b.Len()%4 != 0 {
			b.WriteByte(0)
		}
	}
	pad()
	b.Write(value)
	for _, c := range children {
		pad()
		b.Write(c)
	}
	out := b.Bytes()
	binary.LittleEndian.PutUint16(out, uint16(len(out)))
	return out
}

func verString(key, value string) []byte {
	u := utf16.Encode([]rune(value + "\x00"))
	var v bytes.Buffer
	_ = binary.Write(&v, binary.LittleEndian, u)
	return verBlock(key, 1, v.Bytes(), uint16(len(u)))
}

func versionInfo(strs ...[]byte) []byte {
	table := verBlock("040904b0", 1, nil, 0, strs...)
	sfi := verBlock("StringFileInfo", 1, nil, 0, table)
	return verBlock("VS_VERSION_INFO", 0, make([]byte, 52), 52, sfi)
}

// buildPE returns a minimal PE32+ image whose only section is a resource
// section holding vi as RT_VERSION #1, language 0x409.
func buildPE(t *testing.T, vi []byte) []byte {
	t.Helper()
	const rva, raw = 0x1000, 0x200
	var rs bytes.Buffer
	le := func(v any) { _ = binary.Write(&rs, binary.LittleEndian, v) }
	dir := func(id, off uint32) {
		le([6]uint16{}) // Characteristics, TimeDateStamp, Major, Minor
		le(uint16(0))   // named entries
		le(uint16(1))   // id entries
		le(id)
		le(off)
	}
	dir(16, 0x80000000|0x18)
	dir(1, 0x80000000|0x30)
	dir(0x409, 0x48)
	le(uint32(rva + 0x58))
	le(uint32(len(vi)))
	le([2]uint32{})
	if rs.Len() != 0x58 {
		t.Fatalf("resource layout: %#x", rs.Len())
	}
	rs.Write(vi)
	rsrc := rs.Bytes()

	var b bytes.Buffer
	dos := make([]byte, 64)
	copy(dos, "MZ")
	binary.LittleEndian.PutUint32(dos[0x3c:], 64)
	b.Write(dos)
	b.WriteString("PE\x00\x00")
	oh := pe.OptionalHeader64{Magic: 0x20b, SectionAlignment: 0x1000, FileAlignment: raw,
		SizeOfImage: rva + 0x1000, SizeOfHeaders: raw, NumberOfRvaAndSizes: 16}
	oh.DataDirectory[pe.IMAGE_DIRECTORY_ENTRY_RESOURCE] = pe.DataDirectory{VirtualAddress: rva, Size: uint32(len(rsrc))}
	fh := pe.FileHeader{Machine: pe.IMAGE_FILE_MACHINE_AMD64, NumberOfSections: 1,
		SizeOfOptionalHeader: uint16(binary.Size(oh)), Characteristics: 0x22}
	_ = binary.Write(&b, binary.LittleEndian, fh)
	_ = binary.Write(&b, binary.LittleEndian, oh)
	sh := pe.SectionHeader32{VirtualSize: uint32(len(rsrc)), VirtualAddress: rva,
		SizeOfRawData: uint32(len(rsrc)), PointerToRawData: raw}
	copy(sh.Name[:], ".rsrc")
	_ = binary.Write(&b, binary.LittleEndian, sh)
	for b.Len() < raw {
		b.WriteByte(0)
	}
	b.Write(rsrc)
	return b.Bytes()
}

func TestPEIdentity(t *testing.T) {
	img := buildPE(t, versionInfo(
		verString("CompanyName", "Discord Inc."),
		verString("InternalName", "Discord"),
		verString("OriginalFilename", "Discord.exe"),
	))
	if id, err := PEIdentity(bytes.NewReader(img)); err != nil || id != "Discord.exe" {
		t.Fatalf("PEIdentity = %q, %v", id, err)
	}
	img = buildPE(t, versionInfo(verString("InternalName", "Minecraft")))
	if id, err := PEIdentity(bytes.NewReader(img)); err != nil || id != "Minecraft" {
		t.Fatalf("InternalName fallback = %q, %v", id, err)
	}
	img = buildPE(t, versionInfo(verString("CompanyName", "x")))
	if id, err := PEIdentity(bytes.NewReader(img)); err == nil {
		t.Fatalf("no names: %q", id)
	}
	// Truncated or garbage input fails without panicking.
	for n := 0; n < len(img); n += 7 {
		_, _ = PEIdentity(bytes.NewReader(img[:n]))
	}
	if _, err := PEIdentity(bytes.NewReader([]byte("not a PE file at all"))); err == nil {
		t.Fatal("garbage parsed")
	}
}

func TestVersionStringsSurvivesMalformedBlocks(t *testing.T) {
	vi := versionInfo(verString("OriginalFilename", "a.exe"))
	for i := range vi {
		c := bytes.Clone(vi)
		c[i] ^= 0xff
		_ = versionStrings(c) // must not panic
	}
}

// buildMachO returns a thin arm64 Mach-O with an embedded signature whose
// CodeDirectory has identifier ident.
func buildMachO(ident string) []byte {
	be := binary.BigEndian
	cd := make([]byte, 48)
	be.PutUint32(cd[0:], csMagicCodeDir)
	be.PutUint32(cd[8:], 0x20400)
	be.PutUint32(cd[codeDirIdentField:], 48)
	cd = append(cd, ident+"\x00"...)
	be.PutUint32(cd[4:], uint32(len(cd)))
	sb := make([]byte, 20)
	be.PutUint32(sb[0:], csMagicEmbedded)
	be.PutUint32(sb[8:], 1)
	be.PutUint32(sb[12:], csSlotCodeDir)
	be.PutUint32(sb[16:], 20)
	sb = append(sb, cd...)
	be.PutUint32(sb[4:], uint32(len(sb)))

	le := binary.LittleEndian
	h := make([]byte, 64)
	le.PutUint32(h[0:], 0xfeedfacf)
	le.PutUint32(h[4:], 0x0100000c) // arm64
	le.PutUint32(h[12:], 2)         // MH_EXECUTE
	le.PutUint32(h[16:], 1)         // ncmds
	le.PutUint32(h[20:], 16)        // sizeofcmds
	le.PutUint32(h[32:], lcCodeSignature)
	le.PutUint32(h[36:], 16)
	le.PutUint32(h[40:], 64)
	le.PutUint32(h[44:], uint32(len(sb)))
	return append(h, sb...)
}

func TestMachOIdentity(t *testing.T) {
	img := buildMachO("com.hnc.Discord")
	if id, err := MachOIdentity(bytes.NewReader(img)); err != nil || id != "com.hnc.Discord" {
		t.Fatalf("MachOIdentity = %q, %v", id, err)
	}
	// A universal binary with the same slice at offset 4096.
	fat := make([]byte, 4096)
	be := binary.BigEndian
	be.PutUint32(fat[0:], 0xcafebabe)
	be.PutUint32(fat[4:], 1)
	be.PutUint32(fat[8:], 0x0100000c)
	be.PutUint32(fat[16:], 4096)
	be.PutUint32(fat[20:], uint32(len(img)))
	be.PutUint32(fat[24:], 12)
	fat = append(fat, img...)
	if id, err := MachOIdentity(bytes.NewReader(fat)); err != nil || id != "com.hnc.Discord" {
		t.Fatalf("universal MachOIdentity = %q, %v", id, err)
	}
	for n := 0; n < len(img); n += 5 {
		_, _ = MachOIdentity(bytes.NewReader(img[:n]))
	}
	for i := 64; i < len(img); i++ {
		c := bytes.Clone(img)
		c[i] ^= 0xff
		_, _ = MachOIdentity(bytes.NewReader(c))
	}
}

func TestFileIdentitiesCache(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.exe")
	img := buildPE(t, versionInfo(verString("OriginalFilename", "Discord.exe")))
	if err := os.WriteFile(path, img, 0o644); err != nil {
		t.Fatal(err)
	}
	reads := 0
	c := fileIdentities{read: func(r io.ReaderAt) (string, error) { reads++; return PEIdentity(r) }}
	for range 3 {
		if id := c.get(path); id != "Discord.exe" {
			t.Fatalf("get = %q", id)
		}
	}
	if reads != 1 {
		t.Fatalf("parsed %d times, want 1", reads)
	}
	img2 := buildPE(t, versionInfo(verString("OriginalFilename", "Steam.exe")))
	if err := os.WriteFile(path, img2, 0o644); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, later, later); err != nil {
		t.Fatal(err)
	}
	if id := c.get(path); id != "Steam.exe" {
		t.Fatalf("after change: %q", id)
	}
	if c.get(filepath.Join(t.TempDir(), "missing")) != "" || c.get("") != "" {
		t.Fatal("missing file has an identity")
	}
}
