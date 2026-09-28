; Céntrate NSIS hooks: register the guardian service on install, clean up on uninstall,
; and keep blocks, hosts and points untouched when the uninstaller runs as part of an update.
;
; The guardian is stopped only once the install section runs (after the user clicked
; «Instalar», or right away in a silent update), never in .onInit: the wizard is assisted
; (oneClick: false), and a stop before its pages would leave blocking off if the user
; cancels, and would be priced as a manual stop (service_stopped) at the next start.

!define CENTRATE_GUARDIAN "$INSTDIR\resources\guardian\centrate-guardian.exe"

; centrateStopGuardian stops the installed guardian as a planned update: prepare-update
; writes the planned-stop marker and waits for the process to exit. A guardian too old to
; know prepare-update (exit 2) or a missing binary falls back to a plain stop, so the files
; are never in use when they are replaced. Both are no-ops when nothing is installed.
!macro centrateStopGuardian
  Push $R9
  StrCpy $R9 "1"
  ${If} ${FileExists} "${CENTRATE_GUARDIAN}"
    nsExec::ExecToLog '"${CENTRATE_GUARDIAN}" prepare-update'
    Pop $R9
  ${EndIf}
  ${If} $R9 != "0"
    nsExec::ExecToLog '"$SYSDIR\sc.exe" stop CentrateGuardian'
    Pop $R9
    Sleep 2000
  ${EndIf}
  Pop $R9
!macroend

; customCheckAppRunning runs at the start of the install section, before the old version
; is uninstalled and the files are extracted (and in the uninstaller before files are
; removed). It stops the guardian first, then runs electron-builder's default check (the
; same includes and macros allowOnlyOneInstallerInstance.nsh uses when this hook is not
; defined). Stopping first also keeps that check, which kills every process under
; $INSTDIR, from killing the guardian service.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    ${if} ${isUpdated}
      !insertmacro centrateStopGuardian
    ${endIf}
  !else
    !insertmacro centrateStopGuardian
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!ifndef BUILD_UNINSTALLER
  ; A failed install restarts the guardian it stopped (a no-op when the service is
  ; missing or already running). The wizard pages stop nothing, so a cancel before
  ; «Instalar» needs no handler.
  Function .onInstFailed
    nsExec::ExecToLog '"$SYSDIR\sc.exe" start CentrateGuardian'
    Pop $0
  FunctionEnd
!endif

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
      ${OrIf} $0 == "11"
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
    ; Update: a planned stop (already done by customCheckAppRunning; idempotent). The new
    ; installer starts the service again.
    !insertmacro centrateStopGuardian
  ${endIf}
!macroend
