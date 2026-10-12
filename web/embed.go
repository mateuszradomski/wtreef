// Package web embeds the built frontend so the server is a single binary.
// In git, web/dist holds only .gitkeep (which keeps this embed compiling);
// `make web` fills it before `make server` embeds it.
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
