// Replicates the ARRAYFORMULA/REGEXEXTRACT logic the user's own Google Sheet
// already uses (header "Wallet Name") to pull the real shop code — e.g.
// "YORU005", "JETT003", "CYPHER001" — out of a raw wallet/account string
// like "01727307628 - N-K1AG-O1-YORU005-NG". Kept as its own module since
// it's a direct line-for-line port of that formula, not something to
// silently drift from.
//
// Original Sheets formula (for reference):
//   oldFlag  = SEARCH("OLD", i)            — case-insensitive "contains"
//   yujiFlag = SEARCH("YUJI", i)           — case-insensitive "contains"
//   pattern1 = known brand-name list (case-sensitive alternation)
//   pattern2 = "-([A-Z]+[0-9]+)-[A-Z]{2}$" — brand+number just before the
//              trailing 2-letter wallet-type suffix (-NG/-BK/-RK/-UP)
//   pattern3 = " - (.+)$"                  — everything after " - " (AG- fallback)
//   pattern4 = "[A-Z]{2,}[0-9]+"           — generic letters+digits fallback
//   IF oldFlag -> "OLD"
//   ELSE IF yujiFlag -> REGEXEXTRACT(i, "YUJI[0-9]+")
//   ELSE IF i matches pattern1 -> REGEXEXTRACT(i, pattern2)
//   ELSE IF i contains "AG-" -> REGEXEXTRACT(i, pattern3)
//   ELSE -> REGEXEXTRACT(i, pattern4)

const KNOWN_BRAND_NAMES =
  '(AEGIS|AEROX|ASTRA|BRIM|BREACH|CLOVE|CYPHER|DOOM|FADE|GARNET|GEKKO|GREED|GROCK|HAYA|HYPER|ISO|JETT|KAYO|KJ|MARBLE|NEON|OBSIDIAN|OMEN|OWL|PHOENIX|PINGU|RAZE|REYNA|RONY|RYUMEN|SAGE|SATAN|SKYE|SOVA|TEJO|VALE|VIPER|VYSE|WAYLAY|WISE|YORU|CALAMARI|ZARA|SUPER|YUJI|SERPENT)';

// Case-insensitive (/i) on all four — the sheets these get read from mix
// casing inconsistently (e.g. "Clove003" next to "SATAN002"), which the
// original case-sensitive patterns silently failed to match, undercounting
// affected shops. Output is always normalized to uppercase below so a
// mixed-case source never produces a mismatched lookup key downstream.
const PATTERN1_HAS_KNOWN_BRAND = new RegExp(KNOWN_BRAND_NAMES, 'i');
const PATTERN2_BRAND_BEFORE_SUFFIX = /-([A-Za-z]+[0-9]+)-[A-Za-z]{2}$/i;
const PATTERN3_AFTER_DASH = / - (.+)$/i;
const PATTERN4_LETTERS_DIGITS = /[A-Za-z]{2,}[0-9]+/i;
const YUJI_PATTERN = /YUJI[0-9]+/i;

/**
 * Extracts the real shop/wallet code from a raw account string, exactly
 * mirroring the user's existing Google Sheets formula. Returns '' if
 * nothing extractable (blank input or no pattern matched). Always
 * uppercased so callers can match/group shop names without also having to
 * normalize case themselves.
 */
export function extractRealShopName(raw: string | number | undefined | null): string {
  const i = String(raw ?? '').trim();
  if (!i) return '';

  if (/OLD/i.test(i)) return 'OLD';

  if (/YUJI/i.test(i)) {
    const m = i.match(YUJI_PATTERN);
    return m ? m[0].trim().toUpperCase() : '';
  }

  if (PATTERN1_HAS_KNOWN_BRAND.test(i)) {
    const m = i.match(PATTERN2_BRAND_BEFORE_SUFFIX);
    return m ? m[1].trim().toUpperCase() : '';
  }

  if (/AG-/i.test(i)) {
    const m = i.match(PATTERN3_AFTER_DASH);
    return m ? m[1].trim().toUpperCase() : '';
  }

  const m = i.match(PATTERN4_LETTERS_DIGITS);
  return m ? m[0].trim().toUpperCase() : '';
}

// Send Money's own "SSP PS" shop-name formula — a completely different
// formula from Cashout's above (confirmed by the user: "have diff formula
// for Cashout"), simpler and unrelated to the known-brand-list/suffix logic.
//
// Original Sheets formula (for reference, header "Wallet Name"):
//   ={"Wallet Name";
//     ARRAYFORMULA(
//       IF(LEN(I4:I),
//         IF(REGEXMATCH(I4:I, "(?i)(^|[\s\-])OLD($|[\s\-])"), "OLD",
//           TRIM(MID(TRIM(I4:I), FIND(" - ", TRIM(I4:I)) + 3, LEN(TRIM(I4:I))))
//         ),
//       )
//     )}
// i.e. "OLD" (whole word, bounded by start/whitespace/hyphen) short-circuits
// to "OLD"; otherwise the shop name is simply everything after the first
// " - " (space-hyphen-space) separator. Output uppercased, same reasoning as
// extractRealShopName above — keeps lookup keys case-consistent against the
// live "Opening AG"/"PS BD STLM + TOPUP" data downstream.
const SENDMONEY_OLD_WHOLE_WORD = /(^|[\s-])OLD($|[\s-])/i;

export function extractSendMoneyShopName(raw: string | number | undefined | null): string {
  const i = String(raw ?? '').trim();
  if (!i) return '';

  if (SENDMONEY_OLD_WHOLE_WORD.test(i)) return 'OLD';

  const idx = i.indexOf(' - ');
  if (idx === -1) return '';
  return i.slice(idx + 3).trim().toUpperCase();
}
