package procwatch

var machoIdentities = fileIdentities{read: MachOIdentity}

// identify fills Identity from the code signature of the executable of the
// processes that are not System and have a Path.
func identify(procs []Process) {
	for i := range procs {
		if p := &procs[i]; !p.System && p.Path != "" {
			p.Identity = machoIdentities.get(p.Path)
		}
	}
}
