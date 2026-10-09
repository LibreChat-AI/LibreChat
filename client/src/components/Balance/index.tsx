import useBalanceSummary from '~/hooks/useBalanceSummary';
import Summary from './Summary';

/** The user's balance, or nothing when the deployment does not meter credits. */
export default function Balance({ className }: { className?: string }) {
  const { enabled, state, currency } = useBalanceSummary();
  if (!enabled) {
    return null;
  }
  return <Summary state={state} currency={currency} className={className} />;
}

export { Summary };
