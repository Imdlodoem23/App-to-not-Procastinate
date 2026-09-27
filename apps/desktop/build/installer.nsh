; Céntrate NSIS hooks: register the guardian service on install, clean up on uninstall,
; and keep blocks, hosts and points untouched when the uninstaller runs as part of an update.

!define CENTRATE_GUARDIAN "$INSTDIR\resources\guardian\centrate-guardian.exe"

!macro customInit
  ; Stop the guardian before files are replaced, otherwise the binary is in use.
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop CentrateGuardian'
  Sleep 2000
!macroend

!macro customInstall
  ; Installs (or updates) and starts the service. Idempotent.
  nsExec::ExecToLog '"${CENTRATE_GUARDIAN}" install'
!macroend

!macro customUnInit
  ${IfNot} ${Silent}
    IfFileExists "${CENTRATE_GUARDIAN}" 0 centrate_no_guardian
      nsExec::ExecToStack '"${CENTRATE_GUARDIAN}" has-active'
      Pop $0
      Pop $1
      ${If} $0 == "10"
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "Tienes un bloqueo activo.$\r$\n$\r$\nSi desinstalas Céntrate ahora, el bloqueo se quitará y perderás tus puntos y tu racha.$\r$\n$\r$\n¿Quieres desinstalar de todas formas?" /SD IDOK IDOK centrate_no_guardian
        Abort
      ${EndIf}
    centrate_no_guardian:
  ${EndIf}
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Real uninstall: remove the service, the hosts section and all guardian data.
    nsExec::ExecToLog '"${CENTRATE_GUARDIAN}" uninstall'
  ${else}
    ; Update: only stop the service; the new installer starts it again.
    nsExec::ExecToLog '"$SYSDIR\sc.exe" stop CentrateGuardian'
    Sleep 2000
  ${endIf}
!macroend
