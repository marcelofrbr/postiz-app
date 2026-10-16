import { selectPostWorkflowVersion } from './post-workflow-version';

describe('selectPostWorkflowVersion', () => {
  const target = {
    integrationId: 'integration-1',
    providerIdentifier: 'instagram',
  };

  it('mantem V102 quando nenhum gate esta configurado', () => {
    expect(selectPostWorkflowVersion(target, {})).toBe('postWorkflowV102');
  });

  it('ativa V112 por integration id exato', () => {
    expect(
      selectPostWorkflowVersion(target, {
        POST_WORKFLOW_V113_INTEGRATION_IDS: ' integration-2, integration-1 ',
      })
    ).toBe('postWorkflowV113');
  });

  it('ativa V112 por provider exato', () => {
    expect(
      selectPostWorkflowVersion(target, {
        POST_WORKFLOW_V113_PROVIDERS: 'facebook, instagram',
      })
    ).toBe('postWorkflowV113');
  });

  it('ativa V112 globalmente apenas com true explicito', () => {
    expect(
      selectPostWorkflowVersion(target, {
        POST_WORKFLOW_V113_ALL: 'true',
      })
    ).toBe('postWorkflowV113');
    expect(
      selectPostWorkflowVersion(target, {
        POST_WORKFLOW_V113_ALL: '1',
      })
    ).toBe('postWorkflowV102');
  });

  it('mantem providers Zernio em V102 mesmo com gate global', () => {
    expect(
      selectPostWorkflowVersion(
        {
          integrationId: 'integration-zernio',
          providerIdentifier: 'zernio-instagram',
        },
        { POST_WORKFLOW_V113_ALL: 'true' }
      )
    ).toBe('postWorkflowV102');
  });

  it('nao aceita correspondencia parcial de id ou provider', () => {
    expect(
      selectPostWorkflowVersion(target, {
        POST_WORKFLOW_V113_INTEGRATION_IDS: 'integration',
        POST_WORKFLOW_V113_PROVIDERS: 'insta',
      })
    ).toBe('postWorkflowV102');
  });
});
