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

// Expanded 2026-08-18 — the original 47 names left 77 real brands
// unrecognized, which silently routed every one of their shops into the
// "AG-" fallback (Pattern3) instead of the correct Pattern2 brand+number
// extraction. Confirmed against real data: 2,042 Cashout `agents` rows
// exist under the WRONG (un-stripped, wallet-suffixed) identity as a
// direct result — 100% of them belong to one of these 77 missing brands,
// 0% unresolvable once added (first pass only found 67, scanning just the
// hyphenated-suffix subset; a second, no-hyphen-suffix subset — e.g.
// "AGATE002BK" with no hyphen before the suffix — surfaced 10 more:
// PULSE/RIDON/SAPPHIRE/TURQ/TOME/AZURITE/MOSCOW/CODEX/GRANITE/RIO. Full
// re-scan against the combined superset confirmed 0 unresolvable).
// Verified against live Balance Limit data too (1,493/1,493 real raw
// Account rows mentioning one of the first-pass 67 brands now extract to
// the correct short brand+number form, 0 regressions against the existing
// 47). See scripts/migrate-data.ts's shadow-agent reconciliation notes for
// the full incident writeup.
const KNOWN_BRAND_NAMES =
  '(AEGIS|AEROX|ASTRA|BRIM|KONAN|BREACH|CLOVE|CYPHER|DOOM|FADE|GARNET|GEKKO|GREED|GROCK|HAYA|HYPER|ISO|JETT|KAYO|KJ|MARBLE|NEON|OBSIDIAN|OMEN|OWL|PHOENIX|PINGU|RAZE|REYNA|RONY|RYUMEN|SAGE|SATAN|SKYE|SOVA|TEJO|VALE|VIPER|VYSE|WAYLAY|WISE|YORU|CALAMARI|ZARA|SUPER|YUJI|SERPENT|SHAKER|TOXIC|EGYPT|DAGON|BLUESTONE|SMOKER|BLITZ|MOONSTONE|SANGE|DRAGON|REAVER|URN|KAIDO|DIAMOND|FRANCH|GENTEL|AGHANIMS|KNIGHT|ATOS|TARRASQUE|EULS|YASHA|DECEIT|SALVE|BLOOD|GRANDI|PROFESSOR|ALFA|QOP|WAND|RADIANCE|CLINKZ|DAGGER|VLADS|DRUID|PALERMO|SIREN|TOKYO|TREADS|DAZZLE|AGATE|GENIE|CLOAK|PUGNA|AVENT|ABYSSAL|ALADDIN|WARD|DOGG|WOOD|MEODONI|FAMAN|PEARL|EORO|DIOR|DENVER|HAITI|ITALY|BURMA|BEAST|MAYA|LUFFY|GHOST|GOJO|BEARD|JINBE|SWORD|PULSE|RIDON|SAPPHIRE|TURQ|TOME|AZURITE|MOSCOW|CODEX|GRANITE|RIO)';

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

  // Placeholder rows for manual/off-system adjustments (e.g.
  // "00000000001 - MANUAL-BK") — not a real shop account, same
  // always-excluded treatment as "OLD" below.
  if (/MANUAL/i.test(i)) return 'MANUAL';

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

// Opening Balance's own Agent Name normalizer — deliberately NOT a call
// into extractRealShopName() above. That function parses a raw, phone-
// number-prefixed Account string (Balance Limit's own format, e.g.
// "01818938877 - D-M1AG-M1-JETT003-BK"); Opening's upload template has a
// plain typed code with no such prefix (confirmed via mapOpeningRows()'s
// own column mapping — just "Agent name"/"Wallet Name", no "Account").
// Feeding Opening's values through extractRealShopName() was tested and
// rejected: 0% success on the 2,042 real broken codes (every one contains
// "AG-", which routes into a branch requiring a raw-account-string-only
// " - " separator Opening's values never have) AND it mangles 2,213 of
// 2,251 (98%) of the currently-correct bare codes into empty strings — a
// raw-format mismatch, not a brand-list gap, so it needs its own logic.
//
// Two known raw shapes the real Opening upload template produces for the
// SAME "Agent Name" column (root cause: whoever prepares the file doesn't
// consistently use one convention):
//   Pattern A — already bare, e.g. "JETT013"            -> used as-is
//   Pattern B — wallet suffix baked in, hyphenated or not, e.g.
//               "N-K1AG-J3-AVENT001-BK" or "AGATE002BK" -> suffix stripped
//
// Verified against real data (all 2,042 currently-broken agents + all
// 2,251 currently-correct ones): produces the exact short brand+number
// form ("AVENT001", not "N-K1AG-J3-AVENT001") for every recognized-brand
// Pattern B case — matching what Balance Limit's own (now brand-expanded)
// extractRealShopName() independently derives from its own raw Account
// string for the same real shop, which is what actually matters: Balance
// Limit's import only ever MATCHES existing agents, it never creates one
// (confirmed: zero `insert(schema.agents)` calls in balanceLimitService.ts)
// — so unless Opening creates the exact identity Balance Limit will look
// for, that shop's real wallet data can never link up, no matter how
// "clean" a wrong identity looks. An unrecognized brand (not yet in
// KNOWN_BRAND_NAMES) safely falls through unchanged, same as Pattern A —
// this never mis-strips a real shop name that legitimately ends in
// BK/NG/RK/UP letters, since the digit-immediately-before-suffix guard
// only fires on the wallet-suffix shape, and even then only proceeds to
// shorten the match when the brand is one this module already recognizes.
const WALLET_SUFFIX_STRIP = /^(.*?[0-9])-?(BK|NG|RK|UP)$/i;
const BRAND_PLUS_NUMBER_AT_END = /([A-Za-z]+)([0-9]+[A-Za-z]?)$/;
const KNOWN_BRAND_SET = new Set(
  KNOWN_BRAND_NAMES.slice(1, -1).split('|').map((b) => b.toUpperCase())
);

export function normalizeOpeningAgentName(raw: string | number | undefined | null): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return trimmed;

  const suffixMatch = WALLET_SUFFIX_STRIP.exec(trimmed);
  const withoutSuffix = suffixMatch ? suffixMatch[1] : trimmed;

  const brandMatch = BRAND_PLUS_NUMBER_AT_END.exec(withoutSuffix);
  if (brandMatch && KNOWN_BRAND_SET.has(brandMatch[1].toUpperCase())) {
    return (brandMatch[1] + brandMatch[2]).toUpperCase();
  }

  return trimmed;
}
