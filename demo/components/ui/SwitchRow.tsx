/** A labelled on/off row (`.switch-row`): the whole row is the switch. */
export function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch-row" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-text">
        <span className="switch-label">{label}</span>
        {hint && <span className="switch-hint">{hint}</span>}
      </span>
      <span className="switch" aria-hidden="true" />
    </button>
  );
}
