// Package deps pins module dependencies until the packages that use them land.
package deps

import (
	_ "github.com/kardianos/service"
	_ "golang.org/x/sys/cpu"
)
