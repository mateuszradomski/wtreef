// Package pullrequest holds the domain types shared by the GitHub client, the
// caches, and the pruner. Every type is built by a Parse function, so a value
// that exists has already been checked and holders can trust it.
package pullrequest

import (
	"errors"
	"strconv"
	"strings"
)

const (
	ownerLengthMax  = 39
	repoLengthMax   = 100
	numberDigitsMax = 10
	// NumberMax is GitHub's GraphQL Int ceiling (signed 32-bit).
	NumberMax = 2147483647
)

var (
	ErrOwnerInvalid  = errors.New("owner must be 1-39 characters of [A-Za-z0-9-] and must not start or end with '-'")
	ErrRepoInvalid   = errors.New("repo must be 1-100 characters of [A-Za-z0-9._-] and must not be '.' or '..'")
	ErrNumberInvalid = errors.New("number must be a decimal from 1 to 2147483647 without sign or leading zero")
)

// Repository names a GitHub repository. Both parts are restricted to
// URL-safe characters, so they can be placed in request paths unescaped.
type Repository struct {
	owner string
	name  string
}

// ID identifies a pull request. Construct it with ParseID.
type ID struct {
	repository Repository
	number     int32
}

func ParseRepository(owner string, name string) (Repository, error) {
	if !isOwner(owner) {
		return Repository{}, ErrOwnerInvalid
	}
	if !isRepoName(name) {
		return Repository{}, ErrRepoInvalid
	}
	return Repository{owner: owner, name: name}, nil
}

// ParseNameWithOwner parses GitHub's canonical "owner/name" form.
func ParseNameWithOwner(nameWithOwner string) (Repository, error) {
	owner, name, found := strings.Cut(nameWithOwner, "/")
	if !found {
		return Repository{}, ErrRepoInvalid
	}
	return ParseRepository(owner, name)
}

func ParseID(owner string, repo string, number string) (ID, error) {
	repository, err := ParseRepository(owner, repo)
	if err != nil {
		return ID{}, err
	}
	parsedNumber, ok := parseNumber(number)
	if !ok {
		return ID{}, ErrNumberInvalid
	}
	assert(parsedNumber >= 1, "parsed number is positive")
	return ID{repository: repository, number: parsedNumber}, nil
}

func (repository Repository) Owner() string {
	assert(repository.owner != "", "Repository must come from ParseRepository")
	return repository.owner
}

func (repository Repository) Name() string {
	assert(repository.name != "", "Repository must come from ParseRepository")
	return repository.name
}

func (repository Repository) String() string {
	return repository.Owner() + "/" + repository.Name()
}

func (id ID) Repository() Repository {
	assert(id.number >= 1, "ID must come from ParseID")
	return id.repository
}

func (id ID) Number() int32 {
	assert(id.number >= 1, "ID must come from ParseID")
	return id.number
}

// CacheKey is case-insensitive because GitHub owner and repo names are.
func (id ID) CacheKey() string {
	return strings.ToLower(id.Repository().String()) + "#" + strconv.FormatInt(int64(id.Number()), 10)
}

func (id ID) String() string {
	return id.Repository().String() + "#" + strconv.FormatInt(int64(id.Number()), 10)
}

func isOwner(owner string) bool {
	if len(owner) < 1 || len(owner) > ownerLengthMax {
		return false
	}
	if owner[0] == '-' || owner[len(owner)-1] == '-' {
		return false
	}
	for index := 0; index < len(owner); index++ {
		character := owner[index]
		if !isAlphanumeric(character) && character != '-' {
			return false
		}
	}
	return true
}

func isRepoName(name string) bool {
	if len(name) < 1 || len(name) > repoLengthMax {
		return false
	}
	if name == "." || name == ".." {
		return false
	}
	for index := 0; index < len(name); index++ {
		character := name[index]
		if !isAlphanumeric(character) && character != '.' && character != '_' && character != '-' {
			return false
		}
	}
	return true
}

// parseNumber is hand-written because strconv accepts signs and leading zeros.
func parseNumber(number string) (int32, bool) {
	if len(number) < 1 || len(number) > numberDigitsMax {
		return 0, false
	}
	if number[0] == '0' {
		return 0, false
	}
	value := int64(0)
	for index := 0; index < len(number); index++ {
		character := number[index]
		if character < '0' || character > '9' {
			return 0, false
		}
		value = value*10 + int64(character-'0')
	}
	// Ten digits stay below 10^10, so value cannot overflow int64 above.
	if value > NumberMax {
		return 0, false
	}
	assert(value >= 1, "no leading zero implies a positive value")
	return int32(value), true
}

func isAlphanumeric(character byte) bool {
	if character >= 'a' && character <= 'z' {
		return true
	}
	if character >= 'A' && character <= 'Z' {
		return true
	}
	return character >= '0' && character <= '9'
}
