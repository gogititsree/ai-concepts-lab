import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildOtpauthUri,
  currentStep,
  generateTotp,
  generateTotpSecret,
  renderQrSvg,
  stepToDate,
  TOTP_PERIOD_SECONDS,
  verifyTotp,
} from '../src/auth/totp.js';

/**
 * TOTP against RFC 6238 itself, plus the two properties the design doc adds on top of the
 * RFC: a ±1-step acceptance window, and a *reported* step index so the caller can refuse
 * replays.
 *
 * The vectors are the reason this file exists. Anyone can write a TOTP implementation
 * that agrees with itself; the only test that means anything is one where the expected
 * digits came from the standard rather than from the code under test.
 */

/**
 * RFC 6238 Appendix B, SHA-1 rows. The published values are 8 digits; a 6-digit
 * authenticator shows the last six, because truncation takes the low-order digits
 * (`Snum mod 10^Digit`).
 *
 * Note the third row: `050471` belongs to t = **1111111111**, not 1234567890 — the two
 * are adjacent in the RFC's table and easy to transpose. 1234567890 is `005924`.
 */
const RFC_SECRET_ASCII = '12345678901234567890';
/** The same 20 bytes in base32, which is what every authenticator app speaks. */
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const RFC_VECTORS: Array<{ unixSeconds: number; eightDigit: string; sixDigit: string }> = [
  { unixSeconds: 59, eightDigit: '94287082', sixDigit: '287082' },
  { unixSeconds: 1_111_111_109, eightDigit: '07081804', sixDigit: '081804' },
  { unixSeconds: 1_111_111_111, eightDigit: '14050471', sixDigit: '050471' },
  { unixSeconds: 1_234_567_890, eightDigit: '89005924', sixDigit: '005924' },
  { unixSeconds: 2_000_000_000, eightDigit: '69279037', sixDigit: '279037' },
  { unixSeconds: 20_000_000_000, eightDigit: '65353130', sixDigit: '353130' },
];

/**
 * RFC 4648 base32, written out here rather than imported: the point of the fixture check
 * below is to convert the RFC's ASCII secret *independently* of the library that will
 * later decode it.
 */
function base32Encode(input: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

/** Freezes the clock at a Unix second, so `new Date()` inside the code under test agrees. */
function freezeAt(unixSeconds: number): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(unixSeconds * 1000));
}

describe('RFC 6238 Appendix B (SHA-1)', () => {
  it('encodes the RFC ASCII secret to the base32 the vectors are run against', () => {
    // Checks the test's own fixture. The RFC gives the secret as ASCII; otplib (like every
    // authenticator app) takes base32. If this conversion is wrong, every vector below is
    // testing a different secret than the standard does — and would still pass, because
    // the generator and the verifier would agree with each other.
    expect(base32Encode(Buffer.from(RFC_SECRET_ASCII, 'ascii'))).toBe(RFC_SECRET_BASE32);
  });

  it.each(RFC_VECTORS)(
    'generates $sixDigit at t=$unixSeconds (RFC prints $eightDigit)',
    ({ unixSeconds, sixDigit }) => {
      freezeAt(unixSeconds);
      expect(generateTotp(RFC_SECRET_BASE32)).toBe(sixDigit);
    },
  );

  it.each(RFC_VECTORS)('accepts $sixDigit at t=$unixSeconds', ({ unixSeconds, sixDigit }) => {
    freezeAt(unixSeconds);
    const result = verifyTotp({ secret: RFC_SECRET_BASE32, token: sixDigit });
    expect(result.valid).toBe(true);
    expect(result.delta).toBe(0);
    expect(result.step).toBe(Math.floor(unixSeconds / TOTP_PERIOD_SECONDS));
  });
});

describe('the acceptance window', () => {
  const NOW = 1_700_000_000; // an arbitrary instant, not on a step boundary
  const secret = RFC_SECRET_BASE32;

  const codeAtOffset = (steps: number): string =>
    generateTotp(secret, new Date((NOW + steps * TOTP_PERIOD_SECONDS) * 1000));

  it.each([-1, 0, 1])('accepts a code from step %i and reports its index', (offset) => {
    freezeAt(NOW);
    const result = verifyTotp({ secret, token: codeAtOffset(offset) });

    expect(result.valid).toBe(true);
    expect(result.delta).toBe(offset);
    // The step index is what `mfa_totp.last_used_step` stores, so it must be the step the
    // code belongs to, not the step the clock is in.
    expect(result.step).toBe(Math.floor(NOW / TOTP_PERIOD_SECONDS) + offset);
  });

  it.each([-3, -2, 2, 3])('rejects a code from step %i', (offset) => {
    freezeAt(NOW);
    expect(verifyTotp({ secret, token: codeAtOffset(offset) })).toEqual({ valid: false });
  });

  it('holds at a step boundary, where off-by-one errors live', () => {
    // Exactly on a multiple of 30: floor((t-30)/30) and floor((t+30)/30) are still ±1.
    const boundary = 1_700_000_010 - (1_700_000_010 % TOTP_PERIOD_SECONDS);
    freezeAt(boundary);
    for (const offset of [-1, 0, 1]) {
      const token = generateTotp(secret, new Date((boundary + offset * 30) * 1000));
      expect(verifyTotp({ secret, token }).valid).toBe(true);
    }
    const twoBack = generateTotp(secret, new Date((boundary - 60) * 1000));
    expect(verifyTotp({ secret, token: twoBack }).valid).toBe(false);
  });

  it('rejects anything that is not six digits without consulting the secret', () => {
    freezeAt(NOW);
    for (const token of ['', '12345', '1234567', 'abcdef', '12 34 56x']) {
      expect(verifyTotp({ secret, token })).toEqual({ valid: false });
    }
  });

  it('tolerates the spaces an authenticator app displays', () => {
    freezeAt(NOW);
    const token = generateTotp(secret);
    expect(verifyTotp({ secret, token: `${token.slice(0, 3)} ${token.slice(3)}` }).valid).toBe(
      true,
    );
  });
});

describe('step arithmetic', () => {
  it('currentStep is floor(unixSeconds / 30)', () => {
    freezeAt(1_234_567_890);
    expect(currentStep()).toBe(41_152_263);
    expect(currentStep(new Date(59_000))).toBe(1);
    expect(currentStep(new Date(29_999))).toBe(0);
    expect(currentStep(new Date(30_000))).toBe(1);
  });

  it('stepToDate inverts it', () => {
    expect(stepToDate(41_152_263).getTime()).toBe(41_152_263 * 30_000);
    expect(currentStep(stepToDate(12_345))).toBe(12_345);
  });
});

describe('secrets and the provisioning URI', () => {
  it('generates a 20-byte (32-character base32) secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  it('builds the URI the design doc specifies', () => {
    const uri = buildOtpauthUri({ secret: RFC_SECRET_BASE32, email: 'learner@example.com' });

    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    // Label is `<issuer>:<email>`, percent-encoded as one path segment.
    expect(uri).toContain('AI%20Concepts%20Lab%3Alearner%40example.com');
    expect(uri).toContain(`secret=${RFC_SECRET_BASE32}`);
    expect(uri).toContain('issuer=AI+Concepts+Lab');
    // Spelled out rather than left to the reader's defaults.
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('round-trips through a real authenticator parse: the secret in the URI still verifies', () => {
    freezeAt(1_700_000_000);
    const secret = generateTotpSecret();
    const uri = buildOtpauthUri({ secret, email: 'a@b.test' });
    const parsed = new URL(uri).searchParams.get('secret');

    expect(parsed).toBe(secret);
    expect(verifyTotp({ secret: parsed as string, token: generateTotp(secret) }).valid).toBe(true);
  });

  it('renders the URI as SVG server-side', async () => {
    const svg = await renderQrSvg(
      buildOtpauthUri({ secret: RFC_SECRET_BASE32, email: 'a@b.test' }),
    );
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    // Whatever else it contains, it must not contain the secret as readable text.
    expect(svg).not.toContain(RFC_SECRET_BASE32);
  });
});
