package catalog

import (
	"strings"
	"unicode/utf8"
)

// Punycode (RFC 3492) parameters.
const (
	punyBase        = 36
	punyTMin        = 1
	punyTMax        = 26
	punySkew        = 38
	punyDamp        = 700
	punyInitialBias = 72
	punyInitialN    = 128
	// punyMaxInput bounds a label before encoding or decoding; DNS labels are at most 63
	// bytes, so anything longer is never a usable domain and would only cost time.
	punyMaxInput = 256
)

func punyAdapt(delta, numPoints int, first bool) int {
	if first {
		delta /= punyDamp
	} else {
		delta /= 2
	}
	delta += delta / numPoints
	k := 0
	for delta > ((punyBase-punyTMin)*punyTMax)/2 {
		delta /= punyBase - punyTMin
		k += punyBase
	}
	return k + (punyBase-punyTMin+1)*delta/(delta+punySkew)
}

func punyDigit(d int) byte {
	if d < 26 {
		return byte('a' + d)
	}
	return byte('0' + d - 26)
}

func punyThreshold(k, bias int) int {
	switch t := k - bias; {
	case t < punyTMin:
		return punyTMin
	case t > punyTMax:
		return punyTMax
	default:
		return t
	}
}

// punyEncode encodes one label (without the "xn--" prefix). ok is false for input too
// long to be a DNS label.
func punyEncode(label []rune) (string, bool) {
	if len(label) > punyMaxInput {
		return "", false
	}
	var out strings.Builder
	basic := 0
	for _, r := range label {
		if r < 0x80 {
			out.WriteByte(byte(r))
			basic++
		}
	}
	handled := basic
	if basic > 0 {
		out.WriteByte('-')
	}
	n, delta, bias := punyInitialN, 0, punyInitialBias
	for handled < len(label) {
		m := rune(utf8.MaxRune + 1)
		for _, r := range label {
			if int(r) >= n && r < m {
				m = r
			}
		}
		delta += (int(m) - n) * (handled + 1)
		n = int(m)
		for _, r := range label {
			if int(r) < n {
				delta++
			}
			if int(r) != n {
				continue
			}
			q := delta
			for k := punyBase; ; k += punyBase {
				t := punyThreshold(k, bias)
				if q < t {
					break
				}
				out.WriteByte(punyDigit(t + (q-t)%(punyBase-t)))
				q = (q - t) / (punyBase - t)
			}
			out.WriteByte(punyDigit(q))
			bias = punyAdapt(delta, handled+1, handled == basic)
			delta = 0
			handled++
		}
		delta++
		n++
	}
	return out.String(), true
}

// punyDecode decodes one label (without the "xn--" prefix). ok is false when the input
// is not valid Punycode.
func punyDecode(s string) ([]rune, bool) {
	if len(s) > punyMaxInput {
		return nil, false
	}
	var out []rune
	pos := 0
	if d := strings.LastIndexByte(s, '-'); d >= 0 {
		for i := 0; i < d; i++ {
			if s[i] >= 0x80 {
				return nil, false
			}
			out = append(out, rune(s[i]))
		}
		pos = d + 1
	}
	n, i, bias := punyInitialN, 0, punyInitialBias
	for pos < len(s) {
		oldI, w := i, 1
		for k := punyBase; ; k += punyBase {
			if pos >= len(s) {
				return nil, false
			}
			c := s[pos]
			pos++
			var digit int
			switch {
			case c >= 'a' && c <= 'z':
				digit = int(c - 'a')
			case c >= 'A' && c <= 'Z':
				digit = int(c - 'A')
			case c >= '0' && c <= '9':
				digit = int(c-'0') + 26
			default:
				return nil, false
			}
			if digit > (1<<31-1-i)/w {
				return nil, false
			}
			i += digit * w
			t := punyThreshold(k, bias)
			if digit < t {
				break
			}
			if w > (1<<31-1)/(punyBase-t) {
				return nil, false
			}
			w *= punyBase - t
		}
		bias = punyAdapt(i-oldI, len(out)+1, oldI == 0)
		if i/(len(out)+1) > utf8.MaxRune-n {
			return nil, false
		}
		n += i / (len(out) + 1)
		i %= len(out) + 1
		if n < punyInitialN || n > utf8.MaxRune || (n >= 0xD800 && n <= 0xDFFF) {
			return nil, false
		}
		out = append(out, 0)
		copy(out[i+1:], out[i:])
		out[i] = rune(n)
		i++
	}
	return out, true
}
