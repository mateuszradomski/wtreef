package pullrequest

// assert panics when a programmer-error invariant does not hold. External
// input never reaches an assert unparsed; it is rejected with an error first.
func assert(condition bool, message string) {
	if !condition {
		panic("assertion failed: " + message)
	}
}
