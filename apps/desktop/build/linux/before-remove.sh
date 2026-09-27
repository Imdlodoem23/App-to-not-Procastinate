#!/bin/bash
# Céntrate: runs before the package files are removed (dpkg prerm).
# $1 is "remove" on uninstall and "upgrade" on update: only a real removal cleans up.
GUARDIAN='/opt/Céntrate/resources/guardian/centrate-guardian'
case "$1" in
  remove|purge)
    if [ -x "$GUARDIAN" ]; then "$GUARDIAN" uninstall || true; fi
    ;;
  upgrade|failed-upgrade)
    if [ -x "$GUARDIAN" ]; then "$GUARDIAN" stop || true; fi
    ;;
esac
exit 0
