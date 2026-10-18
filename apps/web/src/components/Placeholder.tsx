import { AddButton } from './AddButton';

interface Props {
  title: string;
  badge: string;
  description: string;
  bullets: string[];
}

export function Placeholder({ title, badge, description, bullets }: Props) {
  return (
    <div className="placeholder">
      <span className="badge">{badge}</span>
      <h2>{title}</h2>
      <p style={{ maxWidth: 520 }}>{description}</p>
      <ul style={{ textAlign: 'left', maxWidth: 520, margin: '6px 0 14px', paddingLeft: 20 }}>
        {bullets.map((b) => (
          <li key={b} style={{ margin: '3px 0' }}>
            {b}
          </li>
        ))}
      </ul>
      <AddButton label="先导入发票试试" />
    </div>
  );
}
