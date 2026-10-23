import { signLine, type ContractDoc, type Run } from "@brookclean/shared";

const runs = (rs: Run[]) => rs.map((r, i) => (typeof r === "string" ? r : <b key={i} className="fill">{r.b}</b>));

/** Текст договора на странице: те же блоки, что и в PDF. Данные клиента выделены. */
export function ContractView({ doc, label, short }: { doc: ContractDoc; label: string; short?: boolean }) {
  return (
    <div className={"doc" + (short ? " short" : "")} tabIndex={0} aria-label={label}>
      {doc.blocks.map((b, i) => {
        switch (b.k) {
          case "title": return <p key={i} className="t pre">{b.text}</p>;
          case "center": return <p key={i} className="c">{b.text}</p>;
          case "right": return <p key={i} className="r pre small">{b.text}</p>;
          case "row": return <p key={i} className="row-between"><span>{b.left}</span><span>{b.right}</span></p>;
          case "h": return <p key={i} className="h">{b.text}</p>;
          case "p": return <p key={i}>{runs(b.runs)}</p>;
          case "break": return <hr key={i} />;
          case "table":
            return (
              <table key={i}>
                <tbody>
                  {b.rows.map(([k, v], j) => (
                    <tr key={j} className={j === b.strong ? "strong" : undefined}><td>{k}</td><td>{v}</td></tr>
                  ))}
                </tbody>
              </table>
            );
          case "parties":
            return (
              <div key={i} className="parties">
                {b.parties.map((p, j) => (
                  <div key={j}>
                    <b>{p.title}</b>
                    {p.lines.map((l, n) => <div key={n}>{l}</div>)}
                    <div className="sign">{signLine(p.sign)}</div>
                  </div>
                ))}
              </div>
            );
        }
      })}
    </div>
  );
}
