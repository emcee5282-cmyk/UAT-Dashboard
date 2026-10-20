// The one Discrepancy TG table card markup/CSS, shared by both render
// targets: the single-page photo template (page.tsx, one card per
// screenshot) and the multi-page PDF template
// (../discrepancy-tg-pdf/page.tsx, N stacked cards -> N PDF pages). Kept in
// one place so neither can drift from the other — "the exact same design"
// per explicit instruction. `.tgimg` styles are scoped with that one class
// prefix so this never leaks into/collides with the rest of the app's CSS
// regardless of which page renders it.
//
// Send to TG v2 — rebuilt to match the reference tg-page-template.html
// exactly (every size/color/spacing copied from it, not approximated):
// dark-blue-gradient header with "GROUP WALLET DISCREPANCY REPORT" +
// leader + line chip on the left, "TOTAL GROUP DISCREPANCY" + the big
// total + shop count on the right; table columns are
// # | Shop Name | Company Balance | Balance Inside | Agent Withdrawal |
// Account Status (no
// Line/Leader/SDP columns); footer is "Account Managing Operations" +
// "X / N", same gradient as the header. The card is a flex column with a
// `.grow` spacer between the table and the footer so a short page (fewer
// than 30 rows) still holds the footer at the very bottom of the full
// TG_IMAGE_PAGE_HEIGHT_PX card for a PHOTO (`fillHeight` true, the
// default) — every photo in a Telegram album needs the same height for a
// clean grid. The PDF explicitly opts out (`fillHeight={false}`, per
// explicit correction): a short PDF page shrinks to its own content height
// instead, footer right after the last row, no trailing white space —
// PDF pages don't share a visual grid with each other the way album
// photos do, so there's no uniform-height requirement to preserve.
import type { TgImagePageData } from '@/app/lib/discrepancyTgImageTypes';
import { formatTgImageNumber } from '@/app/lib/discrepancyTgImageFormat';
import { TG_IMAGE_PAGE_HEIGHT_PX } from '@/app/lib/discrepancyTgImagePagination';

export const TGIMG_STYLES = `
  .tgimg, .tgimg * { box-sizing: border-box; font-family: Inter, sans-serif; }
  .tgimg .card { background: #fff; border-radius: 22px; overflow: hidden; box-shadow: 0 10px 30px rgba(15,23,42,.10); display: flex; flex-direction: column; }
  .tgimg .grow { flex: 1; }
  .tgimg .top { background: linear-gradient(135deg,#0f1e3d 0%,#1e3a8a 60%,#2b4fb8 100%); color: #fff; padding: 30px 36px 28px; display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; }
  .tgimg .kt { font-size: 15px; letter-spacing: 2.4px; text-transform: uppercase; color: #c3d0f0; font-weight: 700; }
  .tgimg .nm { display: flex; align-items: center; gap: 16px; margin: 8px 0 12px; }
  .tgimg .ld { font-size: 42px; font-weight: 700; letter-spacing: -.5px; line-height: 1; }
  .tgimg .chip { font-size: 16px; font-weight: 700; letter-spacing: 1.6px; padding: 8px 16px; border-radius: 999px; line-height: 1; }
  .tgimg .co { background: #dbe6ff; color: #1e3a8a; }
  .tgimg .sm { background: #ffe9c7; color: #8a4b00; }
  .tgimg .ts { font-size: 18px; color: #dbe3f8; font-weight: 500; }
  .tgimg .k { font-size: 12px; letter-spacing: 2.6px; text-transform: uppercase; color: #a9b8e0; font-weight: 600; }
  .tgimg .tot { text-align: right; }
  .tgimg .big { font-size: 38px; font-weight: 700; color: #fff; margin-top: 8px; font-variant-numeric: tabular-nums; line-height: 1; }
  .tgimg .sub { font-size: 18px; font-weight: 600; color: #e3e9fb; margin-top: 10px; }
  .tgimg table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .tgimg th { font-size: 11.5px; letter-spacing: 1.4px; text-transform: uppercase; color: #64748b; font-weight: 700; text-align: right; padding: 16px 36px 12px 10px; background: #f6f8fc; }
  .tgimg td { font-size: 15px; color: #1f2937; padding: 10px 36px 10px 10px; text-align: right; }
  .tgimg th.l, .tgimg td.l { text-align: left; padding-left: 36px; }
  .tgimg tbody tr:nth-child(odd) td { background: #e2e8f2; }
  .tgimg tbody tr:nth-child(even) td { background: #ffffff; }
  .tgimg td.l { font-weight: 600; color: #0f172a; }
  .tgimg td.wd { color: #c81e3a; font-weight: 700; }
  .tgimg td.z { color: #b6bfcc; }
  .tgimg th.n, .tgimg td.n { text-align: center; width: 70px; padding-left: 28px; padding-right: 0; color: #94a3b8; font-weight: 500; }
  .tgimg td.n { font-weight: 400; }
  .tgimg th.l2, .tgimg td.l2 { text-align: left; padding-left: 10px; }
  .tgimg td.st { font-weight: 600; vertical-align: middle; }
  .tgimg td.st.on { color: #047857; }
  .tgimg td.st.off { color: #64748b; }
  .tgimg td.st.has-la { padding-top: 2px; padding-bottom: 2px; line-height: 1.15; }
  .tgimg td.st .la { font-size: 11px; font-weight: 400; line-height: 1.2; margin-top: 2px; text-align: right; color: #64748b; white-space: nowrap; }
  .tgimg td.st .la .muted { color: #64748b; }
  .tgimg td.st .la .amber { color: #d97706; }
  .tgimg td.st .la .red { color: #c81e3a; }
  .tgimg .foot { display: flex; justify-content: space-between; align-items: center; padding: 20px 36px; font-size: 16px; font-weight: 600; color: #dbe3f8; background: linear-gradient(135deg,#0f1e3d 0%,#1e3a8a 60%,#2b4fb8 100%); letter-spacing: .3px; }
  .tgimg .foot b { color: #fff; font-weight: 700; font-size: 17px; }
`;

function fmtCell(n: number): { text: string; zero: boolean } {
  const rounded = Math.round(n);
  return rounded === 0 ? { text: '0', zero: true } : { text: formatTgImageNumber(n), zero: false };
}

export function DiscrepancyTgCard({ data, fillHeight = true }: { data: TgImagePageData; fillHeight?: boolean }) {
  const lineLabel = data.line === 'cashout' ? 'Cashout' : 'Send Money';
  const lineClass = data.line === 'cashout' ? 'co' : 'sm';

  return (
    <div className="card" style={fillHeight ? { minHeight: TG_IMAGE_PAGE_HEIGHT_PX } : undefined}>
      <div className="top">
        <div>
          <div className="kt">Group Wallet Discrepancy Report</div>
          <div className="nm">
            <span className="ld">{data.leader}</span>
            <span className={`chip ${lineClass}`}>{lineLabel.toUpperCase()}</span>
          </div>
          <div className="ts">Last update: {data.timestamp}</div>
        </div>
        <div className="tot">
          <div className="k">Total Group Discrepancy</div>
          <div className="big">{formatTgImageNumber(data.headerTotal)}</div>
          <div className="sub">{data.headerShopCount} shops</div>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th className="n">#</th>
            <th className="l l2">Shop Name</th>
            <th>Company Balance</th>
            <th>Balance Inside</th>
            <th>Agent Withdrawal</th>
            <th>Account Status</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const cb = fmtCell(row.companyBalance);
            const bi = fmtCell(row.balanceInside);
            const aw = fmtCell(row.agentWithdrawal);
            return (
              <tr key={row.rowNumber}>
                <td className="n">{row.rowNumber}</td>
                <td className="l l2">{row.shopName}</td>
                <td className={cb.zero ? 'z' : ''}>{cb.text}</td>
                <td className={bi.zero ? 'z' : ''}>{bi.text}</td>
                <td className="wd">{aw.text}</td>
                {/* Subline cell trims its own vertical padding so the two
                    stacked lines fit inside the normal row height — every
                    row stays the same height, so the 30-row page calibration
                    (TG_IMAGE_PAGE_HEIGHT_PX) still holds. */}
                <td className={`st ${row.accountStatus === 'Active' ? 'on' : 'off'}${row.lastActive ? ' has-la' : ''}`}>
                  {row.accountStatus}
                  {row.lastActive && (
                    <div className="la">
                      Last active: <span className={row.lastActive.tone}>{row.lastActive.text}</span>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="grow" />
      <div className="foot">
        <span>Account Managing Operations</span>
        <b>
          {data.pageNumber} / {data.totalPages}
        </b>
      </div>
    </div>
  );
}
