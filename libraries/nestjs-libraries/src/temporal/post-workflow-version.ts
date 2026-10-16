export type PostWorkflowName = 'postWorkflowV102' | 'postWorkflowV112' | 'postWorkflowV113';

type PostWorkflowTarget = {
  integrationId: string;
  providerIdentifier: string;
};

type PostWorkflowGateEnvironment = {
  POST_WORKFLOW_V113_INTEGRATION_IDS?: string;
  POST_WORKFLOW_V113_PROVIDERS?: string;
  POST_WORKFLOW_V113_ALL?: string;
};

const csvSet = (value?: string): Set<string> =>
  new Set(
    (value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

export const selectPostWorkflowVersion = (
  target: PostWorkflowTarget,
  env: PostWorkflowGateEnvironment = process.env as PostWorkflowGateEnvironment
): PostWorkflowName => {
  // Zernio keeps its current activity routing and remains pinned to V102 until
  // it has a provider-specific pending/finalize smoke test. V112 (official
  // Postiz workflow) is the default for every other channel; V113 (Robo
  // MultiPost id-only history) is opt-in through the POST_WORKFLOW_V113_* gates.
  if (target.providerIdentifier.startsWith('zernio-')) {
    return 'postWorkflowV102';
  }

  const enabledForAll = env.POST_WORKFLOW_V113_ALL === 'true';
  const enabledIntegrations = csvSet(env.POST_WORKFLOW_V113_INTEGRATION_IDS);
  const enabledProviders = csvSet(env.POST_WORKFLOW_V113_PROVIDERS);

  return enabledForAll ||
    enabledIntegrations.has(target.integrationId) ||
    enabledProviders.has(target.providerIdentifier)
    ? 'postWorkflowV113'
    : 'postWorkflowV112';
};
