package points

import (
	"errors"
	"math"
	"strconv"
)

// Civil days and wire timestamps, time-zone free, with exactly the JavaScript semantics
// points.ts relies on (Date.UTC, Date.parse, toISOString).

const (
	msPerDay = 86_400_000
	// maxDateMs is the largest |time value| a JavaScript Date can hold (±8.64e15 ms).
	maxDateMs = 8_640_000_000_000_000
)

// daysFromCivil is the number of days since 1970-01-01 of a proleptic Gregorian date
// (month 1–12; day may exceed the month, like Date.UTC).
func daysFromCivil(y, m, d int64) int64 {
	if m <= 2 {
		y--
	}
	era := floorDiv(y, 400)
	yoe := y - era*400
	mp := (m + 9) % 12
	doy := (153*mp+2)/5 + d - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146097 + doe - 719468
}

// civilFromDays is the inverse of daysFromCivil.
func civilFromDays(z int64) (y, m, d int64) {
	z += 719468
	era := floorDiv(z, 146097)
	doe := z - era*146097
	yoe := (doe - doe/1460 + doe/36524 - doe/146096) / 365
	y = yoe + era*400
	doy := doe - (365*yoe + yoe/4 - yoe/100)
	mp := (5*doy + 2) / 153
	d = doy - (153*mp+2)/5 + 1
	if mp < 10 {
		m = mp + 3
	} else {
		m = mp - 9
	}
	if m <= 2 {
		y++
	}
	return y, m, d
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func isLeap(y int64) bool {
	return y%4 == 0 && (y%100 != 0 || y%400 == 0)
}

func daysInMonth(y, m int64) int64 {
	switch m {
	case 2:
		if isLeap(y) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}

// digits parses s[from:to] as ASCII decimal digits (JavaScript \d without the u flag).
func digits(s string, from, to int) (int64, bool) {
	var n int64
	for i := from; i < to; i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int64(c-'0')
	}
	return n, true
}

// DayNumber is the number of days since 1970-01-01 of a YYYY-MM-DD string. ok is false
// (TypeScript NaN) when it is not a real calendar date. Like points.ts (Date.UTC maps
// years 0–99 to 1900–1999), years below 100 are not real dates.
func DayNumber(day string) (n int64, ok bool) {
	if len(day) != 10 || day[4] != '-' || day[7] != '-' {
		return 0, false
	}
	y, ok1 := digits(day, 0, 4)
	m, ok2 := digits(day, 5, 7)
	d, ok3 := digits(day, 8, 10)
	if !ok1 || !ok2 || !ok3 || y < 100 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m) {
		return 0, false
	}
	return daysFromCivil(y, m, d), true
}

// dayNum is DayNumber as a float64 with NaN for invalid days, so comparisons keep the
// JavaScript semantics of points.ts (every comparison with NaN is false).
func dayNum(day string) float64 {
	n, ok := DayNumber(day)
	if !ok {
		return math.NaN()
	}
	return float64(n)
}

// IsLocalDay reports whether value is a real calendar date written as YYYY-MM-DD.
func IsLocalDay(value string) bool {
	_, ok := DayNumber(value)
	return ok
}

// ErrInvalidDay is returned by AddDays for a day that is not a real date, or a result a
// JavaScript Date cannot hold (points.ts throws a RangeError for both).
var ErrInvalidDay = errors.New("points: invalid day")

// AddDays is day plus n days, formatted like toISOString().slice(0, 10) (years outside
// 0–9999 use the expanded ±YYYYYY form).
func AddDays(day string, n int64) (string, error) {
	base, ok := DayNumber(day)
	if !ok {
		return "", ErrInvalidDay
	}
	const maxDays = maxDateMs / msPerDay
	if n > 2*maxDays || n < -2*maxDays {
		return "", ErrInvalidDay
	}
	days := base + n
	if days > maxDays || days < -maxDays {
		return "", ErrInvalidDay
	}
	y, m, d := civilFromDays(days)
	var year string
	if y >= 0 && y <= 9999 {
		year = pad(y, 4)
	} else if y > 9999 {
		year = "+" + pad(y, 6)
	} else {
		year = "-" + pad(-y, 6)
	}
	s := year + "-" + pad(m, 2) + "-" + pad(d, 2)
	if len(s) > 10 {
		s = s[:10]
	}
	return s, nil
}

func pad(v int64, width int) string {
	s := strconv.FormatInt(v, 10)
	for len(s) < width {
		s = "0" + s
	}
	return s
}

// ParseWireTime parses a wire timestamp (YYYY-MM-DDTHH:MM:SS.sssZ) into epoch
// milliseconds with the semantics of Date.parse on that format: month 1–12, day 1–31
// (a day past the end of its month rolls over, as V8 does), hour 0–24 (24 only as
// 24:00:00.000), minute and second 0–59. ok is false (TypeScript NaN) otherwise.
func ParseWireTime(s string) (ms int64, ok bool) {
	if len(s) != 24 || s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' ||
		s[16] != ':' || s[19] != '.' || s[23] != 'Z' {
		return 0, false
	}
	parts := [...][2]int{{0, 4}, {5, 7}, {8, 10}, {11, 13}, {14, 16}, {17, 19}, {20, 23}}
	var v [7]int64
	for i, p := range parts {
		n, ok := digits(s, p[0], p[1])
		if !ok {
			return 0, false
		}
		v[i] = n
	}
	y, mo, d, h, mi, sec, milli := v[0], v[1], v[2], v[3], v[4], v[5], v[6]
	if mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || sec > 59 {
		return 0, false
	}
	if h == 24 && (mi != 0 || sec != 0 || milli != 0) {
		return 0, false
	}
	days := daysFromCivil(y, mo, 1) + d - 1
	return days*msPerDay + h*3_600_000 + mi*60_000 + sec*1_000 + milli, true
}
