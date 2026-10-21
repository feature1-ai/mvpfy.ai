/**
 * Keep credentials out of everything that leaves the worker.
 *
 * Two kinds of secret, needing two mechanisms. The ones the worker was handed
 * — a runner token, a GitHub token, an agent key — it knows the literal value
 * of, and those are replaced exactly. The ones it has never seen, because
 * they belong to the product being built and turned up in a log, can only be
 * caught by shape.
 *
 * Shape-matching alone is a sieve and is not treated as a guarantee: the
 * rule that actually holds the line is that logs stay on the worker. What
 * crosses to Feature1 is a one-line summary and a structured result, and this
 * is the last check before either goes.
 */

const PATTERNS: Array<{ re: RegExp; as: string }> = [
  // GitHub, in every form it currently mints.
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, as: '[redacted:github-token]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, as: '[redacted:github-token]' },
  // Anthropic and OpenAI keys, which an agent may be configured with.
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, as: '[redacted:anthropic-key]' },
  { re: /\bsk-[A-Za-z0-9]{32,}\b/g, as: '[redacted:api-key]' },
  { re: /\bscion_pat_[A-Za-z0-9_-]{16,}\b/g, as: '[redacted:token]' },
  // AWS.
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, as: '[redacted:aws-key-id]' },
  // Anything presented as a bearer credential.
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, as: 'Bearer [redacted]' },
  // A URL carrying credentials — how a token most often reaches a git log.
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, as: '$1[redacted]@' },
  // KEY=value in captured output, for the names that are always secret.
  {
    re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/g,
    as: '$1=[redacted]',
  },
];

/**
 * Exact values this worker holds. Registered at start-up so that a token
 * which matches no pattern — a bare UUID, something self-hosted — is still
 * never printed.
 */
export class Redactor {
  private readonly literals: string[] = [];

  /** Short values are ignored: redacting "abc" everywhere would ruin a log. */
  remember(...secrets: Array<string | undefined | null>): this {
    for (const secret of secrets) {
      const value = (secret ?? '').trim();
      if (value.length >= 8 && !this.literals.includes(value)) this.literals.push(value);
    }
    return this;
  }

  redact(text: string): string {
    let out = text;
    // Longest first, so a token that contains another is not left in pieces.
    for (const literal of [...this.literals].sort((a, b) => b.length - a.length)) {
      out = out.split(literal).join('[redacted]');
    }
    for (const { re, as } of PATTERNS) out = out.replace(re, as);
    return out;
  }

  /** One line, redacted and bounded. What a summary field is allowed to be. */
  line(text: string, max = 300): string {
    const single = this.redact(text).replace(/\s+/g, ' ').trim();
    return single.length > max ? `${single.slice(0, max - 1)}…` : single;
  }
}

/** A redactor holding nothing, for the shape-only case. */
export const plainRedactor = new Redactor();
