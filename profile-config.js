// DSH config cells expose get(); snapshots and exported settings use ordinary values.
export function setting(config, key, fallback) {
  const cell = config?.[key];
  return cell?.get ? cell.get() : (cell ?? fallback);
}
