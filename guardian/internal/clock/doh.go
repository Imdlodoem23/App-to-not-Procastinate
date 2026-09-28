package clock

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"strings"
)

// dohServers are the DNS-over-HTTPS endpoints (RFC 8484) that resolve the
// hostname time sources. Like the first time sources they are IP literals
// whose certificates carry IP SANs, so resolving a calibration hostname never
// consults the system resolver or the hosts file (which the guardian itself
// writes, and where a user could list a calibration hostname as a block).
var dohServers = []string{
	"https://1.1.1.1/dns-query",
	"https://1.0.0.1/dns-query",
	"https://8.8.8.8/dns-query",
}

// DNS wire-format constants (RFC 1035, RFC 3596).
const (
	dnsTypeA     = 1
	dnsTypeAAAA  = 28
	dnsClassIN   = 1
	dnsHeaderLen = 12
	// dnsFlagQR marks a response; dnsFlagTC a truncated one; dnsFlagRD asks
	// for recursion.
	dnsFlagQR = 0x8000
	dnsFlagTC = 0x0200
	dnsFlagRD = 0x0100
	// maxDNSResponse bounds what is read of a DoH response. The answers for a
	// calibration hostname fit in a few hundred bytes.
	maxDNSResponse = 16 << 10
	// maxDNSAddrs bounds the addresses kept from one answer.
	maxDNSAddrs = 16
	// dnsMessageType is the RFC 8484 media type.
	dnsMessageType = "application/dns-message"
)

var (
	// errDNSUnspecified: the resolver answered 0.0.0.0 or :: for a time
	// source, which is what a blocking resolver does. The check reports it as
	// tampering, never as offline (docs/ARCHITECTURE.md §10.2).
	errDNSUnspecified = errors.New("clock: a time-source hostname resolved to an unspecified address")
	// errDNSNoAddress: the name exists but has no usable address of the type.
	errDNSNoAddress = errors.New("clock: no address in the DNS answer")
	// errDNSMalformed: the message is not a well-formed answer to the query.
	errDNSMalformed = errors.New("clock: malformed DNS message")
	// errDNSRcode: the resolver answered with an error (NXDOMAIN, SERVFAIL…).
	errDNSRcode = errors.New("clock: DNS error response")
)

// dohResolver resolves hostnames with DNS-over-HTTPS through client, which
// must not use the system resolver for the servers (they are IP literals).
type dohResolver struct {
	client  *http.Client
	servers []string
}

// lookup returns the IPv4 addresses of host (the IPv6 ones when it has none)
// from the first server that answers. errDNSUnspecified wins over every other
// outcome: one blocking answer is enough to report tampering.
func (r dohResolver) lookup(ctx context.Context, host string) ([]netip.Addr, error) {
	var firstErr error
	for _, srv := range r.servers {
		if ctx.Err() != nil {
			break
		}
		for _, qtype := range []uint16{dnsTypeA, dnsTypeAAAA} {
			addrs, err := r.query(ctx, srv, host, qtype)
			switch {
			case errors.Is(err, errDNSUnspecified):
				return nil, err
			case err == nil:
				return addrs, nil
			case errors.Is(err, errDNSNoAddress):
				// The server answered: try the other record type there.
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			// The server did not answer usefully: try the next one.
			if firstErr == nil {
				firstErr = err
			}
			break
		}
	}
	if firstErr == nil {
		firstErr = ctx.Err()
	}
	if firstErr == nil {
		firstErr = errDNSNoAddress
	}
	return nil, firstErr
}

// query asks one DoH server for one record type (RFC 8484 GET).
func (r dohResolver) query(ctx context.Context, server, host string, qtype uint16) ([]netip.Addr, error) {
	msg, err := buildDNSQuery(host, qtype)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, networkTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		server+"?dns="+base64.RawURLEncoding.EncodeToString(msg), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", dnsMessageType)
	req.Header.Set("User-Agent", userAgent)
	resp, err := r.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, errDNSRcode
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(strings.ToLower(ct), dnsMessageType) {
		return nil, errDNSMalformed
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxDNSResponse+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxDNSResponse {
		return nil, errDNSMalformed
	}
	return parseDNSResponse(body, host, qtype)
}

// buildDNSQuery returns a recursive query for name and qtype in class IN
// with ID 0, as RFC 8484 §4.1 recommends for GET. name must be a plain ASCII
// hostname (the fixed time-source list).
func buildDNSQuery(name string, qtype uint16) ([]byte, error) {
	name = strings.TrimSuffix(name, ".")
	if name == "" || len(name) > 253 {
		return nil, errDNSMalformed
	}
	msg := make([]byte, dnsHeaderLen, dnsHeaderLen+len(name)+6)
	binary.BigEndian.PutUint16(msg[2:], dnsFlagRD)
	binary.BigEndian.PutUint16(msg[4:], 1) // QDCOUNT
	for label := range strings.SplitSeq(name, ".") {
		if label == "" || len(label) > 63 || !hostLabel(label) {
			return nil, errDNSMalformed
		}
		msg = append(msg, byte(len(label)))
		msg = append(msg, label...)
	}
	msg = append(msg, 0)
	msg = binary.BigEndian.AppendUint16(msg, qtype)
	msg = binary.BigEndian.AppendUint16(msg, dnsClassIN)
	return msg, nil
}

// hostLabel reports whether s holds only letters, digits and hyphens.
func hostLabel(s string) bool {
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// parseDNSResponse returns the addresses of type qtype in msg, which must be
// the answer to the query buildDNSQuery(name, qtype) wrote: ID 0, a response
// without error or truncation, the same single question. Records of other
// types (the CNAME chain) are skipped. Any unspecified address (0.0.0.0, ::)
// makes the whole answer errDNSUnspecified.
func parseDNSResponse(msg []byte, name string, qtype uint16) ([]netip.Addr, error) {
	if len(msg) < dnsHeaderLen {
		return nil, errDNSMalformed
	}
	id := binary.BigEndian.Uint16(msg[0:])
	flags := binary.BigEndian.Uint16(msg[2:])
	qd := binary.BigEndian.Uint16(msg[4:])
	an := binary.BigEndian.Uint16(msg[6:])
	switch {
	case id != 0, flags&dnsFlagQR == 0, flags&dnsFlagTC != 0, qd != 1:
		return nil, errDNSMalformed
	case flags&0x000f != 0:
		return nil, errDNSRcode
	}
	off := dnsHeaderLen
	qname, next, ok := readDNSName(msg, off)
	if !ok || next+4 > len(msg) || !strings.EqualFold(qname, strings.TrimSuffix(name, ".")) ||
		binary.BigEndian.Uint16(msg[next:]) != qtype || binary.BigEndian.Uint16(msg[next+2:]) != dnsClassIN {
		return nil, errDNSMalformed
	}
	off = next + 4
	var addrs []netip.Addr
	for range an {
		_, next, ok := readDNSName(msg, off)
		if !ok || next+10 > len(msg) {
			return nil, errDNSMalformed
		}
		typ := binary.BigEndian.Uint16(msg[next:])
		class := binary.BigEndian.Uint16(msg[next+2:])
		rdlen := int(binary.BigEndian.Uint16(msg[next+8:]))
		rdata := next + 10
		if rdata+rdlen > len(msg) {
			return nil, errDNSMalformed
		}
		off = rdata + rdlen
		if class != dnsClassIN || typ != qtype {
			continue
		}
		addr, ok := netip.AddrFromSlice(msg[rdata:off])
		if !ok || (typ == dnsTypeA) != addr.Is4() {
			return nil, errDNSMalformed
		}
		if addr.IsUnspecified() {
			return nil, errDNSUnspecified
		}
		if len(addrs) < maxDNSAddrs {
			addrs = append(addrs, addr)
		}
	}
	if len(addrs) == 0 {
		return nil, errDNSNoAddress
	}
	return addrs, nil
}

// readDNSName decodes the (possibly compressed) name at off and returns it
// in dotted form without the final dot, and the offset right after it in the
// message (after the first pointer when compressed). Pointers must point
// backwards, which also rules out loops.
func readDNSName(msg []byte, off int) (string, int, bool) {
	var b strings.Builder
	end := -1
	for pos, limit := off, off; ; {
		if pos >= len(msg) {
			return "", 0, false
		}
		n := int(msg[pos])
		switch {
		case n == 0:
			if end < 0 {
				end = pos + 1
			}
			return b.String(), end, b.Len() <= 253
		case n&0xc0 == 0xc0:
			if pos+1 >= len(msg) {
				return "", 0, false
			}
			ptr := int(binary.BigEndian.Uint16(msg[pos:]) & 0x3fff)
			if ptr >= limit {
				return "", 0, false
			}
			if end < 0 {
				end = pos + 2
			}
			pos, limit = ptr, ptr
		case n&0xc0 != 0:
			return "", 0, false
		default:
			if pos+1+n > len(msg) || b.Len()+n+1 > 254 {
				return "", 0, false
			}
			if b.Len() > 0 {
				b.WriteByte('.')
			}
			b.Write(msg[pos+1 : pos+1+n])
			pos += 1 + n
		}
	}
}
