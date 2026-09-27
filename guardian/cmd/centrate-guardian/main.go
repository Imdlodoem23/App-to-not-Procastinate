// Command centrate-guardian is the Céntrate system service that enforces blocks.
package main

import (
	"fmt"

	"github.com/imdlodoem23/centrate/guardian/internal/version"
)

func main() {
	fmt.Println("centrate-guardian", version.Version)
}
