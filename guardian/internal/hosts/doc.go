// Package hosts manages the Céntrate section of the system hosts file, the
// first blocking layer of the guardian (PROMPT.md section 5, «capa 1»).
//
// # The section
//
// The guardian owns only the lines between two markers and never touches
// anything else:
//
//	# >>> CENTRATE START
//	# Managed by Céntrate. Do not edit: changes are restored.
//	0.0.0.0 example.com
//	:: example.com
//	# <<< CENTRATE END
//
// Every blocked domain gets an IPv4 and an IPv6 line. Domains are strict ASCII
// hostnames (see ValidateDomain): the hosts file has no wildcards, so the
// catalog lists the subdomains it needs. A new section is appended at the end
// of the file after one blank line; an existing one is rewritten where it is.
//
// # Preserving the user's file
//
// Lines outside the section are written back byte for byte, whatever their
// encoding or line terminator. The lines we write use the file's dominant
// terminator (CRLF in a typical Windows file; the OS default for an empty
// file). A UTF-8 BOM is kept, and so is the presence or absence of a final
// line break. The header is ASCII («Centrate») in files that are not valid
// UTF-8, so a legacy code page file never gets mixed encodings. UTF-16 files
// are refused (ErrUnsupportedEncoding) and files with NUL bytes are refused
// (ErrCorrupt) rather than guessed at. Remove takes the section out together
// with one of the blank lines around it, so Apply followed by Remove returns
// the original bytes.
//
// Writes go through a temporary file in the same directory that inherits the
// original's permissions, owner, SELinux label and ACL (Windows: owner, group,
// DACL and attributes), is fsynced and replaces the original atomically; see
// Manager.write for the retry and in-place fallback used when an antivirus
// holds the file or the file is a bind mount.
//
// # Repairs
//
// Apply and Remove normalize damaged markers without losing user lines:
// a START with no END claims only the lines right after it that look exactly
// like ours; an END with no START claims only the lines right above it that
// look exactly like ours; duplicated sections are merged into one at the
// position of the first. Lines between the markers of a well-formed section
// belong to Céntrate and are discarded, as its header warns.
//
// # Backups and restore
//
// Before the first write of each process lifetime the file is copied to
// BackupDir/hosts.bak (older copies rotate to hosts.bak.1 and hosts.bak.2).
// Manager.Damaged tells when the file looks broken by an interrupted write of
// ours (NUL bytes, or empty while the backup is not); only then should the
// engine call Manager.RestoreFromBackup and re-apply.
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
