package platform

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Whole-tree takeover (docs/ARCHITECTURE.md §11.1). When the process is
// elevated, EnsureDir takes over the directory and everything inside it:
//
//   - A directory that is not a plain directory (a link or junction planted
//     where it should be) or is not owned by SYSTEM/Administrators (root), or
//     that holds anything owned by another account, is untrusted: it is
//     renamed to "<dir>.untrusted-<unix time>", without opening, changing or
//     deleting anything inside, and created again. Any standard user can
//     pre-create folders in C:\ProgramData and plant files there (a known
//     ledger.key, say); nothing inside such a tree is ever adopted.
//     Re-owning a planted file would adopt it, so a foreign owner anywhere
//     condemns the whole tree.
//   - In a trusted tree, links (symlinks, junctions, any reparse point),
//     files with more than one hard link and special files (FIFOs, sockets,
//     devices) are deleted (the entry itself, never what it points to), and
//     every remaining entry is re-owned (Administrators; root:root or
//     root:wheel) and given the protected DACL (mode) explicitly: the owner
//     of a file keeps an implicit WRITE_DAC, so ownership matters, not only
//     the ACL. Entries that are private (a protected DACL granting only
//     SYSTEM, Administrators and OWNER RIGHTS; a mode without group or other
//     bits), and everything inside a private directory, get the private
//     descriptor (mode): the walk never widens access to secret/.
//   - Directories are secured before they are listed, so no other account
//     can add an entry behind the walk; an entry that appears owned by
//     another account during the fix pass condemns the tree too.
//   - Entries whose name contains ".untrusted-" (trees moved aside earlier)
//     are never entered: the guardian never reads them.
//   - An entry that disappears during the walk (a temporary file the running
//     guardian renamed) is skipped.

// entryKind classifies a directory entry, read without following links.
type entryKind int

const (
	entryDir entryKind = iota
	entryFile
	// entryLink is a symbolic link, a junction or any other reparse point.
	entryLink
	// entryOther is a FIFO, socket or device.
	entryOther
)

// treeEntry is what the takeover needs to know about one entry.
type treeEntry struct {
	kind entryKind
	// trusted: owned by SYSTEM or Administrators (Windows), root (POSIX).
	trusted bool
	// links is the hard-link count.
	links uint64
	// private: only the administrators may access it (see above).
	private bool
	// perm is the POSIX permission bits (zero on Windows).
	perm fs.FileMode
}

// treeOps are the OS operations of a takeover. The real ones never follow
// links; tests fake them.
type treeOps interface {
	inspect(path string) (treeEntry, error)
	list(dir string) ([]string, error)
	// remove deletes the entry itself, never a link's target.
	remove(path string) error
	// secure re-owns the entry and sets its protected DACL (mode), checking
	// that it is still the kind inspect saw. root marks the directory passed
	// to EnsureDir (exact DirMode/PrivateDirMode); private selects the
	// private descriptor.
	secure(path string, e treeEntry, root, private bool) error
}

// TakeoverReport says what a takeover changed besides owners, DACLs and
// modes, so a caller can tell a planted link from a missing file (the store
// treats a secret/ledger.key removed as a link like a planted key).
type TakeoverReport struct {
	// MovedAside are the new names of the untrusted trees moved aside
	// ("<dir>.untrusted-<unix time>"), one per attempt.
	MovedAside []string
	// Removed are the links, multi-linked files and special files deleted
	// from the trusted tree.
	Removed []string
}

// asideMarker is in the name of every tree moved aside.
const asideMarker = ".untrusted-"

// secureAttempts bounds how often secureDir moves an untrusted directory
// aside and recreates it before giving up.
const secureAttempts = 3

// takeOver runs the takeover on dir, which must exist. It returns a
// non-empty problem when the tree cannot be trusted (the caller moves it
// aside and creates it again), and an error only when dir itself cannot be
// inspected or secured.
func takeOver(ops treeOps, dir string, private bool, rep *TakeoverReport) (problem string, err error) {
	root, err := ops.inspect(dir)
	if err != nil {
		return "", err
	}
	switch {
	case root.kind != entryDir:
		return dir + " is not a plain directory", nil
	case !root.trusted:
		return dir + " is owned by another account", nil
	}
	if problem := scanTree(ops, dir); problem != "" {
		return problem, nil
	}
	if err := ops.secure(dir, root, true, private); err != nil {
		return "", err
	}
	return fixTree(ops, dir, private, rep), nil
}

// scanTree walks dir (links are never followed) and reports the first entry
// owned by another account or that cannot be inspected or listed.
func scanTree(ops treeOps, dir string) string {
	stack := []string{dir}
	for len(stack) > 0 {
		d := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		names, err := ops.list(d)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) && d != dir {
				continue
			}
			return fmt.Sprintf("%s cannot be listed (%v)", d, err)
		}
		for _, name := range names {
			if strings.Contains(name, asideMarker) {
				continue
			}
			p := filepath.Join(d, name)
			e, err := ops.inspect(p)
			switch {
			case errors.Is(err, fs.ErrNotExist):
				continue
			case err != nil:
				return fmt.Sprintf("%s cannot be inspected (%v)", p, err)
			case !e.trusted:
				return p + " is owned by another account"
			case e.kind == entryDir:
				stack = append(stack, p)
			}
		}
	}
	return ""
}

// fixTree deletes the links, multi-linked and special files below dir and
// secures everything else, top-down: a directory is secured before it is
// listed. dir itself is already secured.
func fixTree(ops treeOps, dir string, private bool, rep *TakeoverReport) string {
	type item struct {
		path    string
		private bool
	}
	stack := []item{{dir, private}}
	for len(stack) > 0 {
		it := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		names, err := ops.list(it.path)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) && it.path != dir {
				continue
			}
			return fmt.Sprintf("%s cannot be listed (%v)", it.path, err)
		}
		for _, name := range names {
			if strings.Contains(name, asideMarker) {
				continue
			}
			p := filepath.Join(it.path, name)
			e, err := ops.inspect(p)
			switch {
			case errors.Is(err, fs.ErrNotExist):
				continue
			case err != nil:
				return fmt.Sprintf("%s cannot be inspected (%v)", p, err)
			case !e.trusted:
				return p + " is owned by another account"
			}
			if e.kind == entryLink || e.kind == entryOther || (e.kind == entryFile && e.links > 1) {
				if err := ops.remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
					return fmt.Sprintf("%s cannot be removed (%v)", p, err)
				}
				rep.Removed = append(rep.Removed, p)
				continue
			}
			childPrivate := it.private || e.private
			if err := ops.secure(p, e, false, childPrivate); err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					continue
				}
				return fmt.Sprintf("%s cannot be secured (%v)", p, err)
			}
			if e.kind == entryDir {
				stack = append(stack, item{p, childPrivate})
			}
		}
	}
	return ""
}

// moveAside renames dir to "<dir>.untrusted-<unix time>" so a fresh one can be
// created, and returns the new name. Renaming touches only the top entry:
// nothing inside a tree another account controls is ever opened, changed or
// deleted.
func moveAside(dir string) (string, error) {
	base := dir + asideMarker + strconv.FormatInt(time.Now().Unix(), 10)
	aside := base
	for i := 1; ; i++ {
		if _, err := os.Lstat(aside); errors.Is(err, fs.ErrNotExist) {
			break
		}
		aside = base + "-" + strconv.Itoa(i)
	}
	return aside, os.Rename(dir, aside)
}

// secureLoop creates dir (create), takes it over and, while it cannot be
// trusted, moves it aside and tries again (secureAttempts times).
func secureLoop(ops treeOps, dir string, private bool, create func() error, rep *TakeoverReport) error {
	for attempt := 1; ; attempt++ {
		if err := create(); err != nil {
			return err
		}
		problem, err := takeOver(ops, dir, private, rep)
		if err != nil {
			return err
		}
		if problem == "" {
			return nil
		}
		if attempt == secureAttempts {
			return fmt.Errorf("cannot trust %s: %s", dir, problem)
		}
		aside, err := moveAside(dir)
		if err != nil {
			return fmt.Errorf("cannot trust %s (%s) and could not move it aside: %w", dir, problem, err)
		}
		rep.MovedAside = append(rep.MovedAside, aside)
	}
}
