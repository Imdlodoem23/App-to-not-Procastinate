package procwatch

import "testing"

func TestDecomposeLatin1(t *testing.T) {
	tests := []struct{ in, want string }{
		{"Discord", "Discord"},
		{"Céntrate", "Ce\u0301ntrate"},
		{"Ce\u0301ntrate", "Ce\u0301ntrate"},
		{"ÀÁÂÃÄÅ", "A\u0300A\u0301A\u0302A\u0303A\u0308A\u030a"},
		{"Ñandú", "N\u0303andu\u0301"},
		{"Çç", "C\u0327c\u0327"},
		{"ÿÝý", "y\u0308Y\u0301y\u0301"},
		{"ÆØßÞð×÷", "ÆØßÞð×÷"}, // no canonical decomposition
		{"日本語", "日本語"},
	}
	for _, tc := range tests {
		if got := decomposeLatin1(tc.in); got != tc.want {
			t.Errorf("decomposeLatin1(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestLatin1TablesAligned(t *testing.T) {
	if len(latin1Base) != 64 {
		t.Fatalf("latin1Base has %d runes, want 64", len(latin1Base))
	}
	for i, m := range latin1Mark {
		r := rune(0xC0 + i)
		if m == 0 && latin1Base[i] != r {
			t.Errorf("U+%04X has no mark but base %q", r, latin1Base[i])
		}
		if m != 0 && (latin1Base[i] >= 0x80 || latin1Base[i] == r) {
			t.Errorf("U+%04X decomposes to non-ASCII base %q", r, latin1Base[i])
		}
	}
}

func TestMatchKey(t *testing.T) {
	tests := []struct{ goos, in, want string }{
		{"windows", "Discord.EXE", "discord"},
		{"windows", "discord", "discord"},
		{"windows", "Setup.exe.exe", "setup.exe"},
		{"windows", "Céntrate.exe", "ce\u0301ntrate"},
		{"darwin", "Roblox.app", "roblox"},
		{"darwin", "Discord.exe", "discord.exe"},
		{"darwin", "CAFE\u0301", "cafe\u0301"},
		{"linux", "Discord.exe", "Discord.exe"},
		{"linux", "Café", "Cafe\u0301"},
		{"plan9", "Steam", "Steam"},
	}
	for _, tc := range tests {
		if got := matchKey(tc.goos, tc.in); got != tc.want {
			t.Errorf("matchKey(%s, %q) = %q, want %q", tc.goos, tc.in, got, tc.want)
		}
	}
}

func TestSameName(t *testing.T) {
	if !sameName("windows", "DISCORD.exe", "discord.EXE") || sameName("linux", "Discord", "discord") {
		t.Error("sameName does not follow the OS rules")
	}
	if !sameName("darwin", "Céntrate", "Ce\u0301ntrate") || !sameName("linux", "Céntrate", "Ce\u0301ntrate") {
		t.Error("sameName does not treat composed and decomposed accents as equal")
	}
}

func TestDenyKey(t *testing.T) {
	tests := []struct{ in, want string }{
		{" Explorer.EXE ", "explorer"},
		{"Finder.app", "finder"},
		{"Ce\u0301ntrate Helper (GPU)", "centrate helper (gpu)"},
		{"CÉNTRATE.exe", "centrate"},
		{"", ""},
	}
	for _, tc := range tests {
		if got := denyKey(tc.in); got != tc.want {
			t.Errorf("denyKey(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestBaseName(t *testing.T) {
	tests := []struct{ in, want string }{
		{`C:\Program Files\Discord\Discord.exe`, "Discord.exe"},
		{"/usr/share/discord/Discord", "Discord"},
		{"steam", "steam"},
		{"/", ""},
	}
	for _, tc := range tests {
		if got := baseName(tc.in); got != tc.want {
			t.Errorf("baseName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
