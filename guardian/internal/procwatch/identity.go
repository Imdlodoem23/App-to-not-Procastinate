package procwatch

import (
	"bytes"
	"debug/macho"
	"debug/pe"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// Executable identity (docs/ARCHITECTURE.md §10.8, §16.2 #30): what an
// executable says it is, independently of its file name, so that a renamed
// copy of a blocked app is still recognised. It is read from the file with
// memory-safe Go parsers (the guardian runs as LocalSystem or root and the
// files are user-writable), never by loading or running it.
//
//   - Windows: the OriginalFilename of the version resource (VS_VERSIONINFO),
//     or its InternalName when OriginalFilename is missing.
//   - macOS: the identifier of the code signature (the CodeDirectory of
//     LC_CODE_SIGNATURE): the bundle id for signed apps, the original output
//     name for linker-signed ones. Changing it takes re-signing the binary.

// Limits that keep a hostile file from making the parsers read much.
const (
	maxVersionResource = 64 << 10
	maxResourceEntries = 64
	maxSignatureSize   = 4 << 20
	maxIdentityLen     = 255
	maxIdentityCache   = 4096
)

var errNoIdentity = errors.New("procwatch: no identity")

// PEIdentity returns the OriginalFilename (or, when missing, the
// InternalName) of the version resource of the PE file in r.
func PEIdentity(r io.ReaderAt) (string, error) {
	f, err := pe.NewFile(r)
	if err != nil {
		return "", err
	}
	var dir pe.DataDirectory
	switch oh := f.OptionalHeader.(type) {
	case *pe.OptionalHeader32:
		if oh.NumberOfRvaAndSizes > pe.IMAGE_DIRECTORY_ENTRY_RESOURCE {
			dir = oh.DataDirectory[pe.IMAGE_DIRECTORY_ENTRY_RESOURCE]
		}
	case *pe.OptionalHeader64:
		if oh.NumberOfRvaAndSizes > pe.IMAGE_DIRECTORY_ENTRY_RESOURCE {
			dir = oh.DataDirectory[pe.IMAGE_DIRECTORY_ENTRY_RESOURCE]
		}
	}
	if dir.VirtualAddress == 0 || dir.Size == 0 {
		return "", errNoIdentity
	}
	rsrc := &peImage{r: r, f: f}
	base := dir.VirtualAddress
	// RT_VERSION (16), then the first name, then the first language.
	off, isDir, err := rsrc.entry(base, base, 16, true)
	if err != nil || !isDir {
		return "", errNoIdentity
	}
	for range 2 {
		if off, isDir, err = rsrc.entry(base, base+off, 0, false); err != nil {
			return "", err
		}
		if !isDir {
			break
		}
	}
	if isDir {
		return "", errNoIdentity
	}
	var data [8]byte // IMAGE_RESOURCE_DATA_ENTRY: OffsetToData (an RVA), Size
	if err := rsrc.readRVA(base+off, data[:]); err != nil {
		return "", err
	}
	rva, size := binary.LittleEndian.Uint32(data[0:]), binary.LittleEndian.Uint32(data[4:])
	if size == 0 || size > maxVersionResource {
		return "", errNoIdentity
	}
	buf := make([]byte, size)
	if err := rsrc.readRVA(rva, buf); err != nil {
		return "", err
	}
	strs := versionStrings(buf)
	for _, k := range [...]string{"OriginalFilename", "InternalName"} {
		if v := cleanIdentity(strs[k]); v != "" {
			return v, nil
		}
	}
	return "", errNoIdentity
}

type peImage struct {
	r io.ReaderAt
	f *pe.File
}

// readRVA reads len(buf) bytes at the relative virtual address rva.
func (p *peImage) readRVA(rva uint32, buf []byte) error {
	for _, s := range p.f.Sections {
		size := max(s.VirtualSize, s.Size)
		if rva < s.VirtualAddress || rva-s.VirtualAddress >= size {
			continue
		}
		rel := rva - s.VirtualAddress
		if uint64(rel)+uint64(len(buf)) > uint64(s.Size) {
			return errNoIdentity
		}
		_, err := p.r.ReadAt(buf, int64(s.Offset)+int64(rel))
		return err
	}
	return errNoIdentity
}

// entry looks in the resource directory at dirRVA for the entry with the
// integer id (or, when !byID, the first entry) and returns its offset from
// the resource base and whether it is a subdirectory.
func (p *peImage) entry(base, dirRVA uint32, id uint32, byID bool) (uint32, bool, error) {
	var hdr [16]byte
	if err := p.readRVA(dirRVA, hdr[:]); err != nil {
		return 0, false, err
	}
	named := uint32(binary.LittleEndian.Uint16(hdr[12:]))
	ids := uint32(binary.LittleEndian.Uint16(hdr[14:]))
	n := min(named+ids, maxResourceEntries)
	for i := range n {
		var e [8]byte
		if err := p.readRVA(dirRVA+16+8*i, e[:]); err != nil {
			return 0, false, err
		}
		name, off := binary.LittleEndian.Uint32(e[0:]), binary.LittleEndian.Uint32(e[4:])
		if byID && (name&0x80000000 != 0 || name != id) {
			continue
		}
		return off &^ 0x80000000, off&0x80000000 != 0, nil
	}
	return 0, false, errNoIdentity
}

// versionStrings returns the strings of every StringTable in a
// VS_VERSIONINFO resource; the first table that has a key wins.
func versionStrings(b []byte) map[string]string {
	out := make(map[string]string)
	root, ok := parseVersionBlock(b, 0)
	if !ok || root.key != "VS_VERSION_INFO" {
		return out
	}
	for _, sfi := range root.children {
		if sfi.key != "StringFileInfo" {
			continue
		}
		for _, table := range sfi.children {
			for _, s := range table.children {
				if _, dup := out[s.key]; !dup && s.text {
					out[s.key] = s.value
				}
			}
		}
	}
	return out
}

type versionBlock struct {
	key      string
	value    string // text values only
	text     bool
	children []versionBlock
}

// parseVersionBlock parses the block at b[off:]: wLength, wValueLength,
// wType, a NUL-terminated UTF-16 key, padding to 32 bits, the value, padding,
// then child blocks up to wLength. depth bounds the recursion.
func parseVersionBlock(b []byte, depth int) (versionBlock, bool) {
	var blk versionBlock
	if depth > 3 || len(b) < 6 {
		return blk, false
	}
	length := int(binary.LittleEndian.Uint16(b[0:]))
	valueLen := int(binary.LittleEndian.Uint16(b[2:]))
	typ := binary.LittleEndian.Uint16(b[4:])
	if length < 6 || length > len(b) {
		return blk, false
	}
	b = b[:length]
	pos := 6
	var key []uint16
	for {
		if pos+2 > len(b) {
			return blk, false
		}
		c := binary.LittleEndian.Uint16(b[pos:])
		pos += 2
		if c == 0 {
			break
		}
		key = append(key, c)
	}
	blk.key = string(utf16.Decode(key))
	pos = align4(pos)
	if valueLen > 0 {
		n := valueLen
		if typ == 1 {
			n *= 2 // text values count WCHARs
			blk.text = true
		}
		if pos+n > len(b) {
			n = max(0, len(b)-pos) // some linkers count bytes for text too
		}
		if blk.text {
			blk.value = utf16String(b[pos : pos+n])
		}
		pos = align4(pos + n)
	} else if typ == 1 {
		blk.text = true
	}
	for pos+6 <= len(b) {
		child, ok := parseVersionBlock(b[pos:], depth+1)
		if !ok {
			break
		}
		blk.children = append(blk.children, child)
		pos = align4(pos + int(binary.LittleEndian.Uint16(b[pos:])))
	}
	return blk, true
}

func align4(n int) int { return (n + 3) &^ 3 }

// utf16String decodes little-endian UTF-16 up to the first NUL.
func utf16String(b []byte) string {
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		c := binary.LittleEndian.Uint16(b[i:])
		if c == 0 {
			break
		}
		u = append(u, c)
	}
	return string(utf16.Decode(u))
}

// cleanIdentity trims an identity and rejects empty, over-long and
// non-printable ones.
func cleanIdentity(s string) string {
	s = string(bytes.TrimSpace([]byte(s)))
	if s == "" || len(s) > maxIdentityLen || !utf8.ValidString(s) {
		return ""
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	return s
}

// Mach-O code signature constants (big-endian blobs, <Kernel/kern/cs_blobs.h>).
const (
	lcCodeSignature   = 0x1d
	csMagicEmbedded   = 0xfade0cc0
	csMagicCodeDir    = 0xfade0c02
	csSlotCodeDir     = 0
	codeDirIdentField = 20 // offset of identOffset in CS_CodeDirectory
)

// MachOIdentity returns the code-signing identifier of the Mach-O file in r
// (the first architecture of a universal binary that has one).
func MachOIdentity(r io.ReaderAt) (string, error) {
	if fat, err := macho.NewFatFile(r); err == nil {
		for _, a := range fat.Arches {
			if id, err := machoSigningID(r, int64(a.Offset), a.File); err == nil {
				return id, nil
			}
		}
		return "", errNoIdentity
	}
	f, err := macho.NewFile(r)
	if err != nil {
		return "", err
	}
	return machoSigningID(r, 0, f)
}

func machoSigningID(r io.ReaderAt, base int64, f *macho.File) (string, error) {
	for _, l := range f.Loads {
		raw := l.Raw()
		if len(raw) < 16 || f.ByteOrder.Uint32(raw) != lcCodeSignature {
			continue
		}
		off, size := f.ByteOrder.Uint32(raw[8:]), f.ByteOrder.Uint32(raw[12:])
		if size < 12 || size > maxSignatureSize {
			return "", errNoIdentity
		}
		blob := make([]byte, size)
		if _, err := r.ReadAt(blob, base+int64(off)); err != nil {
			return "", err
		}
		return signingID(blob)
	}
	return "", errNoIdentity
}

// signingID reads the identifier of the CodeDirectory in an embedded
// signature SuperBlob.
func signingID(sb []byte) (string, error) {
	be := binary.BigEndian
	if len(sb) < 12 || be.Uint32(sb) != csMagicEmbedded {
		return "", errNoIdentity
	}
	count := be.Uint32(sb[8:])
	for i := uint32(0); i < count && i < 64; i++ {
		at := 12 + 8*int(i)
		if at+8 > len(sb) {
			break
		}
		typ, off := be.Uint32(sb[at:]), int(be.Uint32(sb[at+4:]))
		if typ != csSlotCodeDir || off+codeDirIdentField+4 > len(sb) || be.Uint32(sb[off:]) != csMagicCodeDir {
			continue
		}
		cd := sb[off:]
		if l := int(be.Uint32(cd[4:])); l < codeDirIdentField+4 || l > len(cd) {
			return "", errNoIdentity
		} else {
			cd = cd[:l]
		}
		ident := int(be.Uint32(cd[codeDirIdentField:]))
		if ident >= len(cd) {
			return "", errNoIdentity
		}
		s := cd[ident:]
		if n := bytes.IndexByte(s, 0); n >= 0 {
			s = s[:n]
		} else {
			return "", errNoIdentity
		}
		if id := cleanIdentity(string(s)); id != "" {
			return id, nil
		}
		return "", errNoIdentity
	}
	return "", errNoIdentity
}

// fileIdentities caches the identity of executables by path, size and
// modification time, so each binary is parsed once.
type fileIdentities struct {
	mu    sync.Mutex
	read  func(io.ReaderAt) (string, error)
	cache map[string]fileIdentity
}

type fileIdentity struct {
	size  int64
	mtime time.Time
	id    string
}

func (c *fileIdentities) get(path string) string {
	if path == "" {
		return ""
	}
	fi, err := os.Stat(path)
	if err != nil || !fi.Mode().IsRegular() {
		return ""
	}
	c.mu.Lock()
	if e, ok := c.cache[path]; ok && e.size == fi.Size() && e.mtime.Equal(fi.ModTime()) {
		c.mu.Unlock()
		return e.id
	}
	c.mu.Unlock()
	id := ""
	if f, err := os.Open(path); err == nil {
		id, _ = c.read(f)
		_ = f.Close()
	}
	c.mu.Lock()
	if c.cache == nil || len(c.cache) >= maxIdentityCache {
		c.cache = make(map[string]fileIdentity)
	}
	c.cache[path] = fileIdentity{size: fi.Size(), mtime: fi.ModTime(), id: id}
	c.mu.Unlock()
	return id
}
