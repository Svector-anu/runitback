import type { ReactNode } from "react";
import { LANDING_CONTENT, type CompareRow } from "../landing-content";
import { SectionHead, stagger } from "./parts";

const { compare } = LANDING_CONTENT;

function Cell({ row, side }: { row: CompareRow; side: "runitback" | "capcut" }): ReactNode {
  return (
    <td className="lp-compare__cell" data-side={side} data-label={compare.columns[side]}>
      {row[side]}
      {row.ahead === side ? <span className="lp-compare__ahead">{compare.aheadLabel}</span> : null}
    </td>
  );
}

export function Compare(): ReactNode {
  return (
    <section id="compare" className="lp-section lp-wrap" aria-labelledby="compare-title" tabIndex={-1}>
      <SectionHead index={6} eyebrow={compare.eyebrow} title={compare.title} intro={compare.intro} titleId="compare-title" />
      <div className="zn-frame zn-reveal" style={stagger(1)}>
        <table className="lp-compare">
          <caption className="sr-only">{compare.title}</caption>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Feature</span></th>
              <th scope="col" data-side="runitback">{compare.columns.runitback}</th>
              <th scope="col" data-side="capcut">{compare.columns.capcut}</th>
            </tr>
          </thead>
          <tbody>
            {compare.rows.map((row) => (
              <tr key={row.feature}>
                <th scope="row">{row.feature}</th>
                <Cell row={row} side="runitback" />
                <Cell row={row} side="capcut" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="lp-compare__note zn-mono">{compare.checked}</p>
    </section>
  );
}
