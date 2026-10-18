import { useStore } from '../state/store';

export function Toast() {
  const { state, dispatch } = useStore();
  const toast = state.toast;
  if (!toast) return null;

  return (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      <span className="actions">
        {toast.actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={action.primary ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
            onClick={() => {
              action.run();
              dispatch({ type: 'toast', toast: null });
            }}
          >
            {action.label}
          </button>
        ))}
      </span>
    </div>
  );
}
