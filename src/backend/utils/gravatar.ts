import * as crypto from "node:crypto";

/**
 * Gravatar hash of an email: MD5 of the trimmed, lower-cased address, per the
 * Gravatar spec. Normalising the case means addresses differing only in case
 * resolve to the same avatar (and the same cache entry).
 */
export function gravatarHash(email: string): string {
  return crypto.createHash("md5").update(email.trim().toLowerCase()).digest("hex");
}
