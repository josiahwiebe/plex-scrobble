import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "crypto";
import type { User } from "./schema.js";

const ENCRYPTION_ALGORITHM = "aes-256-cbc";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET || "fallback-secret-key";
  return scryptSync(secret, "salt", KEY_LENGTH);
}

export interface EncryptedPassword {
  encrypted: string;
  iv: string;
}

export function encryptPassword(password: string): EncryptedPassword {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(password, "utf8", "hex");
  encrypted += cipher.final("hex");

  return {
    encrypted,
    iv: iv.toString("hex"),
  };
}

export function decryptPassword(encryptedPassword: EncryptedPassword): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(encryptedPassword.iv, "hex");

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let decrypted = decipher.update(encryptedPassword.encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export function getUserPassword(user: User): string | null {
  if (!user.letterboxdPasswordHash || !user.letterboxdPasswordSalt) {
    return null;
  }

  try {
    return decryptPassword({
      encrypted: user.letterboxdPasswordHash,
      iv: user.letterboxdPasswordSalt,
    });
  } catch (error) {
    console.error("Failed to decrypt password:", error);
    return null;
  }
}