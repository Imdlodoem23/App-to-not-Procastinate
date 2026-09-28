// Package hosts manages the Céntrate section of the system hosts file, the
// first blocking layer of the guardian (PROMPT.md section 5, «capa 1»).
//
// # The section
//
// The guardian owns only the lines between two markers and never touches
// anything else:
//
//	# >>> CENTRATE START
//	# Managed by Centrate. Do not edit: changes are restored.
//	# centrate-hosts v1 until=2026-09-27T17:42:00Z count=1
//	0.0.0.0 example.com
//	:: example.com
//	# <<< CENTRATE END
//
// The third line, written by ApplyUntil (not by Apply), records the latest
// trusted end of the active blocks and the number of domains, so the guardian
// keeps enforcing if every state file is lost; Section and SectionInfo parse
// it (docs/ARCHITECTURE.md §10.10, §10.12). Verify keeps whatever until the
// file has; VerifyUntil requires a given one.
//
// Every blocked domain gets an IPv4 and an IPv6 line. Domains are strict ASCII
// hostnames (see ValidateDomain): the hosts file has no wildcards, so the
// catalog lists the subdomains it needs. A new section is appended at the end
// of the file after one blank line; an existing one is rewritten where it is.
// The section is pure ASCII: a non-ASCII byte would make some editors save the
// file as UTF-8 with a BOM, which breaks the first entry for the Windows
// resolver. (Earlier builds wrote «Céntrate» in the header; that line is
// still recognised.)
//
// # Preserving the user's file
//
// Lines outside the section are written back byte for byte, whatever their
// encoding or line terminator. The lines we write use the file's dominant
// terminator (CRLF in a typical Windows file; the OS default for an empty
// file). A UTF-8 BOM is kept, and so is the presence or absence of a final
// line break. UTF-16 and UTF-32 files (with or without a byte order mark) and
// other files with scattered NUL bytes are refused with ErrUnsupportedEncoding;
// files with blocks of NUL bytes are refused with ErrCorrupt. Remove takes the
// section out together with one of the blank lines around it, so Apply
// followed by Remove returns the original bytes.
//
// # Lines that override the section
//
// The one exception to the rule above: while a domain is blocked, a user line
// outside the section that maps it to a real address ("142.250.184.14
// youtube.com", loopback included; 0.0.0.0 and :: are harmless) is commented
// out as ShadowMarker followed by the line, byte for byte. Resolvers that stop
// at the first matching line (the Windows DNS Client, Chromium's built-in
// resolver) would otherwise follow it wherever it sits, and glibc with "multi
// on" merges every match. The whole line is commented, other names on it
// included, and it comes back unchanged as soon as none of its names is
// blocked (Remove restores every such line, so Apply followed by Remove still
// returns the original bytes). Verify reports such a line as a difference, so
// the engine sees it as hosts tampering, and Current leaves the domains it
// overrides out, so a line added while the guardian was stopped changes
// CurrentSectionHash.
//
// Writes go through a temporary file in the same directory that inherits the
// original's permissions, owner, SELinux label and ACL (Windows: owner, group,
// DACL and attributes), is fsynced and replaces the original atomically; see
// Manager.write for the retry and in-place fallback used when an antivirus
// holds the file or the file is a bind mount.
// On Windows any user can open the hosts file for reading while denying
// write sharing; with Manager.BreakLocks, a write of a non-empty section
// still refused after those retries closes the interactive processes that
// hold the file (found with the Restart Manager) and tries again, while
// services and session-0 holders are waited for.
//
// # Repairs
//
// Apply and Remove normalize damaged markers without losing user lines. Only
// lines exactly as render writes them, in its order, are taken from beside a
// stray marker: the header and "0.0.0.0 d" / ":: d" pairs with the domains in
// ascending order. A START with no END claims the header and pairs right
// after it; an END with no START claims the pairs (and header) right above
// it only when they start after a blank line, at the start of the file or
// right below the header, and otherwise only the marker goes. A user's own
// "0.0.0.0 d" list next to a stray marker is therefore never taken; the price
// is that a few of our lines may stay behind as user lines when someone
// deletes a marker together with its neighbours. Duplicated sections are
// merged into one at the position of the first. Lines between the markers of
// a well-formed section belong to Céntrate and are discarded, as its header
// warns. The header line is claimed from beside a stray marker only in the
// exact form FormatSectionHeader writes.
//
// # Backups and restore
//
// The first time a Manager reads an existing, usable hosts file it writes
// BackupDir/hosts.original (the file with any Céntrate section taken out)
// unless that file already exists: it is never overwritten, is the last
// resort of Recover and RestoreFromBackup, and RestoreOriginal writes it
// back.
//
// Before a write, the file is copied to BackupDir/hosts.bak (older copies
// rotate to hosts.bak.1 and hosts.bak.2) when its user part (everything
// outside the section) differs from the newest backup: on the first write of
// a process and again after someone else edits the user's lines, but never
// for changes to our own section. A file that is empty while a backup has
// content is never backed up, so it cannot push the good copies out.
//
// Manager.Damaged tells when the file looks broken by an interrupted write of
// ours (blocks of NUL bytes, or empty while a backup has content), and
// Manager.Recover restores it from the newest backup with content in that case
// only. The first Apply or Remove of each process runs that check itself, so a
// file torn by a crash is restored before anything is built on it; the engine
// still calls Recover at startup to report it.
//
// # Antivirus (Microsoft Defender)
//
// Defender reports hosts entries for some Microsoft domains as
// SettingsModifier:Win32/HostsFileHijack and its remediation rewrites the
// file. On Windows the engine therefore passes its list through
// HostsLayerDomains, which leaves DefenderSensitiveDomains to the browser
// extension. Any program that keeps rewriting the file (Defender with a
// future rule, a hosts manager) is dampened with Contention: after five
// rewrites in a minute, re-applies back off from 10 s to 5 min and one warning
// is logged.
//
// If Defender still warns about the hosts file: open Windows Security, Virus
// & threat protection, Protection history, pick the HostsFileHijack entry and
// choose «Allow on device» (choosing Remove or Quarantine only rewrites the
// file, and the guardian writes its section again). Alternatively add the
// hosts file (platform.HostsPath, normally
// %SystemRoot%\System32\drivers\etc\hosts) under Exclusions. Nothing else
// is needed: the browser extension keeps blocking meanwhile.
//
// # Budget and hashes
//
// The section holds at most SectionBudget domains (hostsMaxDomains from the
// generated contract data). Apply and ApplyUntil refuse a longer list with
// ErrOverBudget instead of cutting it alphabetically; ApplyPrioritized takes
// the domains in priority groups and drops the lowest-priority ones. The
// engine persists LastSectionHash (SectionHash: SHA-256 of the sorted domain
// list) and compares it with CurrentSectionHash at the next start to detect a
// section changed while the guardian was stopped.
//
// # Path
//
// With Resolve set (the engine passes platform.HostsPath, which follows the
// Windows DataBasePath registry value), the path is re-read every
// ResolveEvery (60 s) and the Manager moves to the new file when it changes.
//
// # Watching and DNS
//
// Manager.Watch polls the file (size, modification time and SHA-256) every
// 2 s and reports changes that are not our own writes, so the engine can
// re-apply lines someone deleted. FlushDNS clears the OS resolver cache with
// fixed commands; Manager.AutoFlush runs it after every change.
//
// # Privacy
//
// Blocked domains are personal data: nothing here logs them, and error
// messages (InvalidDomainError included) never contain them.
package hosts
