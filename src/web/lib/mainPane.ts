export type MainPaneState = 'skeleton' | 'error' | 'empty' | 'group' | 'stale';

/**
 * What a grouped view's main pane shows. `group` is the selected group (undefined when there is
 * none to select). An analysis with zero groups is 'empty', not an endless skeleton.
 */
export function mainPaneState(input: {
  loading: boolean;
  error: unknown;
  analysis: object | undefined;
  group: object | undefined;
  stale?: boolean;
}): MainPaneState {
  const { loading, error, analysis, group, stale } = input;
  if (stale) return 'stale';
  if (analysis && group) return 'group';
  if (analysis) return 'empty';
  if (error && !loading) return 'error';
  return 'skeleton';
}
