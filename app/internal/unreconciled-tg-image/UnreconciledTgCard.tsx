// The one Unreconciled Balance TG table card markup/CSS — this feature's
// own distinct design (NOT a reuse of DiscrepancyTgCard's dark-blue-
// gradient look): a view-colored header with a gold underline, dotted-grid
// page background, alternating white/#e2e8f2 rows, a navy Total row that
// only ever appears on a view's own last page.
//
// Header/footer color is per-view, matching each line's own existing
// product-accent convention (Cashout = steel blue, Send Money = teal) plus
// a third navy tone for Group Total — distinguishing the three views at a
// glance instead of one identical color on every image.
//
// Column widths are a fixed `<colgroup>` + `table-layout: fixed` (not
// content-driven auto-sizing) — explicit instruction after Cashout and
// Send Money images came out with visibly different column/row proportions
// because each view's own data (digit counts, leader-name lengths) sized
// its columns independently. Every view now locks to the same proportions
// regardless of its own data, so every image in an album lines up.
//
// Built from the plan's written description (dotted grid, steel-blue
// header with a 3px #c9a24a underline, alternating white/#e2e8f2 rows,
// #13285a Total row, "QA Managing Operations" footer, "{VIEW} ·
// UNRECONCILED BALANCE" title) — the actual reference HTML wasn't
// available on disk when this was built, so treat the exact spacing/
// sizing here as a best-effort match pending a side-by-side comparison
// against the original.
import type { UnreconciledTgImagePageData } from '@/app/lib/unreconciledTgImageTypes';
import { formatTgImageNumber } from '@/app/lib/discrepancyTgImageFormat';
import { UNRECONCILED_TG_IMAGE_PAGE_HEIGHT_PX } from '@/app/lib/unreconciledTgImagePagination';

export const UTGIMG_STYLES = `
  .utgimg, .utgimg * { box-sizing: border-box; font-family: Inter, sans-serif; }
  .utgimg .page {
    background-color: #eef1f7;
    background-image: radial-gradient(circle, #c7cedb 1px, transparent 1px);
    background-size: 14px 14px;
  }
  .utgimg .card { background: #fff; border-radius: 18px; overflow: hidden; box-shadow: 0 10px 30px rgba(15,23,42,.10); display: flex; flex-direction: column; }
  .utgimg .grow { flex: 1; }
  .utgimg .top { border-bottom: 3px solid #c9a24a; color: #fff; padding: 26px 32px 22px; }
  .utgimg .top--cashout, .utgimg .foot--cashout { background: #2f5d9a; }
  .utgimg .top--sendmoney, .utgimg .foot--sendmoney { background: #0f766e; }
  .utgimg .top--group, .utgimg .foot--group { background: #13285a; }
  .utgimg .title { font-size: 20px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; }
  .utgimg .sub { margin-top: 6px; font-size: 13px; font-weight: 500; color: #dbe6f7; }
  .utgimg table { width: 100%; table-layout: fixed; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  .utgimg th { font-size: 10.5px; letter-spacing: 1.2px; text-transform: uppercase; color: #5b6b85; font-weight: 700; text-align: right; padding: 14px 24px 10px 8px; background: #f6f8fc; border-bottom: 2px solid #c9a24a; overflow-wrap: break-word; }
  .utgimg td { font-size: 13.5px; color: #1f2937; padding: 9px 24px 9px 8px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .utgimg th.l, .utgimg td.l { text-align: left; padding-left: 24px; }
  .utgimg td.l { white-space: normal; }
  .utgimg th.n, .utgimg td.n { text-align: center; padding-left: 20px; padding-right: 0; color: #94a3b8; font-weight: 500; }
  .utgimg tbody tr.odd td { background: #ffffff; }
  .utgimg tbody tr.even td { background: #e2e8f2; }
  .utgimg td.l { font-weight: 600; color: #0f172a; }
  .utgimg td.wd { color: #c81e3a; font-weight: 700; }
  .utgimg td.z { color: #b6bfcc; }
  .utgimg tr.total td { background: #13285a; color: #fff; font-weight: 700; border-top: 2px solid #c9a24a; }
  .utgimg tr.total td.l { color: #fff; }
  .utgimg .foot { display: flex; justify-content: space-between; align-items: center; padding: 16px 32px; font-size: 13px; font-weight: 600; color: #dbe6f7; letter-spacing: .3px; }
  .utgimg .foot b { color: #fff; font-weight: 700; font-size: 14px; }
`;

function fmtCell(n: number): { text: string; zero: boolean } {
  const rounded = Math.round(n);
  return rounded === 0 ? { text: '0', zero: true } : { text: formatTgImageNumber(n), zero: false };
}

// Negative Withheld Balance shows as 0 in images only — page/export keep
// the real signed value, per explicit spec.
function fmtWithheld(n: number): { text: string; zero: boolean } {
  return fmtCell(n < 0 ? 0 : n);
}

const VIEW_LABEL: Record<UnreconciledTgImagePageData['view'], string> = {
  cashout: 'Cashout',
  sendmoney: 'Send Money',
  group: 'Group Total',
};

export function UnreconciledTgCard({ data, fillHeight = true }: { data: UnreconciledTgImagePageData; fillHeight?: boolean }) {
  return (
    <div className="card" style={fillHeight ? { minHeight: UNRECONCILED_TG_IMAGE_PAGE_HEIGHT_PX } : undefined}>
      <div className={`top top--${data.view}`}>
        <div className="title">{VIEW_LABEL[data.view]} &middot; Unreconciled Balance</div>
        <div className="sub">Last update: {data.timestamp}</div>
      </div>
      <table>
        <colgroup>
          <col style={{ width: '6%' }} />
          <col style={{ width: '18%' }} />
          <col style={{ width: '16%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '14%' }} />
          <col style={{ width: '16%' }} />
        </colgroup>
        <thead>
          <tr>
            <th className="n">#</th>
            <th className="l">Group Leader</th>
            <th>Total Company Balance</th>
            <th>Total Wallet Balance</th>
            <th>Total Discrepancy</th>
            <th>Total SDP</th>
            <th>Withheld Balance</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, i) => {
            const cb = fmtCell(row.companyBalance);
            const bi = fmtCell(row.balanceInside);
            const aw = fmtCell(row.agentWithdrawal);
            const sdp = fmtCell(row.sdp);
            const wh = fmtWithheld(row.withheld);
            return (
              <tr key={row.rowNumber} className={i % 2 === 0 ? 'odd' : 'even'}>
                <td className="n">{row.rowNumber}</td>
                <td className="l">{row.leader}</td>
                <td className={cb.zero ? 'z' : ''}>{cb.text}</td>
                <td className={bi.zero ? 'z' : ''}>{bi.text}</td>
                <td className="wd">{aw.text}</td>
                <td className={sdp.zero ? 'z' : ''}>{sdp.text}</td>
                <td className={wh.zero ? 'z' : ''}>{wh.text}</td>
              </tr>
            );
          })}
          {data.totals && (
            <tr className="total">
              <td />
              <td className="l">Total</td>
              <td>{formatTgImageNumber(data.totals.companyBalance)}</td>
              <td>{formatTgImageNumber(data.totals.balanceInside)}</td>
              <td>{formatTgImageNumber(data.totals.agentWithdrawal)}</td>
              <td>{formatTgImageNumber(data.totals.sdp)}</td>
              <td>{formatTgImageNumber(data.totals.withheld < 0 ? 0 : data.totals.withheld)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="grow" />
      <div className={`foot foot--${data.view}`}>
        <span>QA Managing Operations</span>
        <b>
          {data.pageNumber} / {data.totalPages}
        </b>
      </div>
    </div>
  );
}
