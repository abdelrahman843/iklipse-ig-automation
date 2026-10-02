import { hoursLeft, WINDOW_HOURS } from "../lib/time";

interface Props {
  lastInteractionAt: string | null;
  small?: boolean;
  label?: boolean;
}

/**
 * The 24-hour messaging window, one tick per hour. Everything this product can do to a
 * contact happens inside these ticks, so they appear wherever a contact does.
 */
export function WindowMeter({ lastInteractionAt, small, label = true }: Props) {
  const left = hoursLeft(lastInteractionAt);
  const lit = Math.ceil(left);
  const state = left === 0 ? "is-shut" : left <= 3 ? "is-closing" : "is-open";

  const text =
    left === 0
      ? "Window closed"
      : left < 1
        ? `${Math.ceil(left * 60)}m left`
        : `${Math.floor(left)}h left`;

  return (
    <div
      className={`meter ${state} ${small ? "meter-sm" : ""}`}
      title={`${text} of the 24-hour messaging window`}
    >
      <div className="meter-ticks" aria-hidden="true">
        {Array.from({ length: WINDOW_HOURS }, (_, i) => (
          <span key={i} className={`meter-tick ${i < lit ? "is-lit" : ""}`} />
        ))}
      </div>
      {label && <span className="meter-label">{text}</span>}
    </div>
  );
}
