import type { OperationSummary } from "@/services/operation-status";

export function OperationStatusSummary({ items }: { items: OperationSummary[] }) {
  return (
    <section className="status-grid" aria-label="Current operation status">
      {items.map(item => (
        <article className={`status-card status-${item.tone}`} key={item.key}>
          <span className="status-icon" aria-hidden="true">{item.icon}</span>
          <div>
            <h3>{item.label}</h3>
            <p>{item.summary}</p>
            <small>{item.detail}</small>
          </div>
        </article>
      ))}
    </section>
  );
}
