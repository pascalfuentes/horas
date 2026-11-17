import { APP_NAME } from "~/config";

/**
 * Passwords that are long enough and still the first ones anyone tries.
 *
 * The minimum length (ten) already rules out most of the usual lists, so this
 * is short on purpose: it catches the shapes that survive a length rule. It
 * runs here, on the server, with nothing sent anywhere. Checking a password
 * against a list of leaked ones kept by a third party would catch far more,
 * and would mean telling that third party something about every password
 * typed here.
 */

/** Whole passwords, lower case, that pass the length rule and are in every list. */
const COMMON = new Set([
  "password12",
  "password123",
  "password1234",
  "password12345",
  "passwordpassword",
  "mypassword1",
  "mypassword123",
  "iloveyou12",
  "iloveyou123",
  "letmein123",
  "letmein1234",
  "welcome123",
  "welcome1234",
  "admin12345",
  "administrator",
  "qwerty12345",
  "qwerty123456",
  "1q2w3e4r5t",
  "1q2w3e4r5t6y",
  "q1w2e3r4t5",
  "q1w2e3r4t5y6",
  "1qaz2wsx3edc",
  "zaq12wsxcde3",
  "abc1234567",
  "abcd123456",
  "a123456789",
  "123456789a",
  "1234567890a",
  "123456789abc",
  "changeme123",
  "trustno1trustno1",
  "senha12345",
  "senha123456",
  "minhasenha1",
  "minhasenha123",
  "mudar12345",
]);

/** Words that are a password by themselves once a few digits are added. */
const BASE_WORDS = new Set([
  "password",
  "passwords",
  "passw",
  "senha",
  "minhasenha",
  "qwerty",
  "qwertyuiop",
  "admin",
  "administrator",
  "welcome",
  "letmein",
  "iloveyou",
  "changeme",
  "secret",
  "login",
]);

/** Runs a keyboard or a child would type, long enough to hold any password. */
const RUNS = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiopasdfghjklzxcvbnm"].flatMap((run) => {
  const long = run.repeat(Math.ceil(220 / run.length));
  return [long, [...long].reverse().join("")];
});

/**
 * Whether a password is one of the first anyone would try.
 *
 * @param password The password as typed.
 * @param related Things about the account that must not BE the password with a
 *   few digits around: the e-mail address, the person's name.
 * @returns `true` when the password should be refused.
 */
export function isCommonPassword(password: string, related: string[] = []): boolean {
  const text = password.toLowerCase();
  if (COMMON.has(text)) return true;

  // One character, or one short piece, over and over: "aaaaaaaaaa", "abcabcabcabc".
  if (/^(.{1,4})\1+$/.test(text)) return true;

  // A straight run: "1234567890", "abcdefghij", "qwertyuiop", forwards or backwards.
  if (RUNS.some((run) => run.includes(text))) return true;

  // A known word, or something about the account, with digits and symbols
  // around it: "password2026!", "maria123456", "clockfolio1".
  const core = text.replace(/^[^a-z]+|[^a-z]+$/g, "");
  if (!core) return false;
  if (BASE_WORDS.has(core)) return true;

  const own = [APP_NAME, ...related]
    .flatMap((value) => {
      const lower = String(value ?? "").toLowerCase();
      // An address counts by what is before the `@`; a name by each of its words and all of them together.
      const local = lower.includes("@") ? lower.split("@")[0] : lower;
      return [local, local.replace(/[^a-z]/g, ""), ...local.split(/[^a-z]+/)];
    })
    .filter((word) => word.length >= 4);
  return own.includes(core);
}
