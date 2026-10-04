/**
 * Email masking for credential names on the quota page.
 *
 * Auth files are usually named after the account (`claude-jane@example.com.json`),
 * so the page leaks every address on a screen share. Masked, the name still
 * tells two credentials apart — first letter of the mailbox, first letter of the
 * domain, and the TLD — without spelling either out:
 * `claude-j•••@e•••.com.json`.
 */

const MASK = '•••';

/**
 * Mailbox characters exclude `-` so a provider prefix (`claude-`) is not taken
 * for part of the address; `knownEmail` covers addresses that do contain one.
 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Mask a single address: `jane@example.com` → `j•••@e•••.com`. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const lastDot = domain.lastIndexOf('.');
  const tld = lastDot > 0 ? domain.slice(lastDot) : '';
  return `${local[0]}${MASK}@${domain[0]}${MASK}${tld}`;
}

/**
 * Mask every address inside `text`.
 *
 * A trailing `.json` is set aside first: `jane@example.com.json` would
 * otherwise read as the domain `example.com.json` and keep `.json` as its TLD.
 */
export function maskEmailsInText(text: string, knownEmail?: string | null): string {
  const extension = /\.json$/i.exec(text)?.[0] ?? '';
  let stem = extension ? text.slice(0, -extension.length) : text;

  const known = knownEmail?.trim();
  if (known && known.includes('@') && stem.includes(known)) {
    stem = stem.split(known).join(maskEmail(known));
  }
  return (
    stem.replace(EMAIL_PATTERN, (match) => (match.includes(MASK) ? match : maskEmail(match))) +
    extension
  );
}
