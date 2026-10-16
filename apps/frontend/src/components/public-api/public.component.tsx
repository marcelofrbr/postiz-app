'use client';

import { useState, useCallback } from 'react';
import { useSWRConfig } from 'swr';
import { useUser } from '../layout/user.context';
import { useCurrentProfile } from '@gitroom/frontend/hooks/use-current-profile.hook';
import copy from 'copy-to-clipboard';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useDecisionModal } from '@gitroom/frontend/components/layout/new-modal';
import { McpClientIcon } from '@gitroom/frontend/components/public-api/mcp.client.icons';
import clsx from 'clsx';

// Remote clients can't set headers, they get a URL to paste (hint = where)
export const remoteMcpClients = {
  Claude:
    'In Claude go to Settings > Connectors > Add custom connector and paste this URL.',
  ChatGPT:
    'In ChatGPT go to Settings > Connectors > Create and paste this URL.',
} as const;

// Official one-click connectors listed in the assistants' directories, they
// point at the public MCP server: the hosted Postiz (billingEnabled), or a
// self-hosted install through "Use self-hosted" on its sign-in page.
export const mcpConnectorUrls = {
  Claude: 'https://claude.ai/directory/postiz',
  ChatGPT:
    'https://chatgpt.com/plugins/plugin_asdk_app_6aaaf1a529808191a2a15fde824bb013',
  Cursor: 'https://cursor.com/marketplace/postiz',
  'Grok Bot': 'https://x.ai/bot/plugin/58737848',
} as const;

// Clients with no MCP or CLI settings: you paste instructions into the chat,
// the agent installs the CLI itself and asks you for the API key
export const chatOnlyMcpClients = {
  'Grok Bot':
    'Install the Postiz CLI with `npm install -g postiz`, then install the Postiz skill with `npx skills add gitroomhq/postiz-agent`. Ask me for my Postiz API key and set it as the POSTIZ_API_KEY environment variable before using the CLI.',
} as const;

export const mcpClients = [
  'OpenClaw',
  'Hermes',
  'NanoClaw',
  'Claude Code',
  'Cursor',
  'Codex',
  'VS Code / Copilot',
  'Windsurf',
  'Amp',
  'Gemini CLI',
  'Warp',
] as const;

export type RemoteMcpClient = keyof typeof remoteMcpClients;
export type ChatOnlyMcpClient = keyof typeof chatOnlyMcpClients;
export type McpClient = (typeof mcpClients)[number];
export type AnyMcpClient = RemoteMcpClient | ChatOnlyMcpClient | McpClient;

// oauth: no API key, the client registers itself (DCR) and the user signs in to Postiz
// apikey: the organization API key, as a Bearer header (or inside the URL for remote clients)
export type McpAuth = 'oauth' | 'apikey';

// Only the self-hosted docker images are built with a version
export const isSelfHosted = !!process.env.NEXT_PUBLIC_VERSION;

// The directory listings behind the "Official connector" tab
const officialConnectorClients = [
  'Claude',
  'ChatGPT',
  'Cursor',
  'Grok Bot',
] as const;

export const getMcpOauthUrl = (mcpBase: string) =>
  `${mcpBase}/mcp-oauth-dynamic`;

export const isRemoteMcpClient = (client: string): client is RemoteMcpClient =>
  client in remoteMcpClients;

export const isChatOnlyMcpClient = (
  client: string
): client is ChatOnlyMcpClient => client in chatOnlyMcpClients;

const getMcpConfigRaw = (
  client: AnyMcpClient,
  auth: McpAuth,
  mcpBase: string,
  apiKey: string
): {
  config: string;
  hint?: string;
  hintKey?: string;
  hintDefault?: string;
} => {
  if (isChatOnlyMcpClient(client)) {
    return {
      config: chatOnlyMcpClients[client],
      hint: 'Paste this into the chat. The agent will ask you for your API key.',
    };
  }
  if (isRemoteMcpClient(client)) {
    return {
      config:
        auth === 'oauth' ? getMcpOauthUrl(mcpBase) : `${mcpBase}/mcp/${apiKey}`,
      hint: remoteMcpClients[client],
    };
  }

  const oauthUrl = getMcpOauthUrl(mcpBase);
  const urlBase = `${mcpBase}/mcp`;
  const bearer = `Bearer ${apiKey}`;

  const json = (obj: object) => JSON.stringify(obj, null, 2);

  if (auth === 'oauth') {
    switch (client) {
      case 'Claude Code':
        return {
          config: `claude mcp add postiz --transport http "${oauthUrl}"`,
          hint: 'Run this command in your terminal.',
        };
      case 'Cursor':
        return {
          config: json({ mcpServers: { postiz: { url: oauthUrl } } }),
          hint: 'Add to .cursor/mcp.json in your project root.',
        };
      case 'VS Code / Copilot':
        return {
          config: json({
            servers: { postiz: { type: 'http', url: oauthUrl } },
          }),
          hint: 'Add to .vscode/mcp.json in your project root.',
        };
      case 'Windsurf':
        return {
          config: json({
            mcpServers: { postiz: { serverUrl: oauthUrl } },
          }),
          hint: 'Add to ~/.codeium/windsurf/mcp_config.json',
        };
      case 'Amp':
        return {
          config: `amp mcp add postiz ${oauthUrl}`,
          hint: 'Run this command in your terminal.',
        };
      case 'Codex':
        return {
          config: `# ~/.codex/config.toml\n\n[mcp_servers.postiz]\nurl = "${oauthUrl}"`,
          hint: 'Add to ~/.codex/config.toml, then run: codex mcp login postiz',
        };
      case 'Gemini CLI':
        return {
          config: json({ mcpServers: { postiz: { url: oauthUrl } } }),
          hint: 'Add to ~/.gemini/settings.json',
        };
      case 'Warp':
        return {
          config: json({ postiz: { url: oauthUrl } }),
          hint: 'Settings > MCP Servers > + Add, then paste this config.',
        };
      case 'Hermes':
        return {
          config: `# ~/.hermes/config.yaml\n\nmcp_servers:\n  postiz:\n    url: "${oauthUrl}"\n    auth: oauth`,
          hint: 'Add to ~/.hermes/config.yaml, then run /reload-mcp in the chat.',
        };
      case 'OpenClaw':
        return {
          config: `openclaw mcp add postiz --url ${oauthUrl} --transport streamable-http --auth oauth && openclaw mcp login postiz`,
          hint: 'Run this command in your terminal.',
        };
      case 'NanoClaw':
        return {
          config: `ncl groups config add-mcp-server --id <group-id> --name postiz --url ${oauthUrl}`,
          hint: 'Run this in your terminal, replace <group-id> with the agent group that should get Postiz.',
        };
    }
  }

  switch (client) {
    case 'Claude Code':
      return {
        config: `claude mcp add --transport http postiz ${urlBase} --header "Authorization: ${bearer}"`,
        hintKey: 'mcp_hint_terminal',
        hintDefault: 'Run this command in your terminal.',
      };
    case 'Cursor':
      return {
        config: json({ mcpServers: { postiz: { url: urlBase, headers: { Authorization: bearer } } } }),
        hintKey: 'mcp_hint_cursor', hintDefault: 'Add to .cursor/mcp.json in your project root.',
      };
    case 'VS Code / Copilot':
      return {
        config: json({ servers: { postiz: { type: 'http', url: urlBase, headers: { Authorization: bearer } } } }),
        hintKey: 'mcp_hint_vscode', hintDefault: 'Add to .vscode/mcp.json in your project root.',
      };
    case 'Windsurf':
      return {
        config: json({ mcpServers: { postiz: { serverUrl: urlBase, headers: { Authorization: bearer } } } }),
        hintKey: 'mcp_hint_windsurf', hintDefault: 'Add to ~/.codeium/windsurf/mcp_config.json',
      };
    case 'Amp':
      return {
        config: json({ 'amp.mcpServers': { postiz: { url: urlBase, headers: { Authorization: bearer } } } }),
        hintKey: 'mcp_hint_amp', hintDefault: 'Add to your Amp settings.json',
      };
    case 'Codex':
      return {
        config: `# ~/.codex/config.toml\n\n[mcp_servers.postiz]\nurl = "${urlBase}"\nhttp_headers = { "Authorization" = "${bearer}" }`,
        hintKey: 'mcp_hint_codex', hintDefault: 'Add to ~/.codex/config.toml',
      };
    case 'Gemini CLI':
      return {
        config: json({ mcpServers: { postiz: { url: urlBase, headers: { Authorization: bearer } } } }),
        hintKey: 'mcp_hint_gemini', hintDefault: 'Add to ~/.gemini/settings.json',
      };
    case 'Warp':
      return {
        config: json({ postiz: { url: urlBase, headers: { Authorization: bearer } } }),
        hintKey: 'mcp_hint_warp', hintDefault: 'Settings > MCP Servers > + Add, then paste this config.',
      };
    case 'Hermes':
      return {
        config: `# ~/.hermes/config.yaml\n\nmcp_servers:\n  postiz:\n    url: "${urlBase}"\n    headers:\n      Authorization: "${bearer}"`,
        hint: 'Add to ~/.hermes/config.yaml, then run /reload-mcp in the chat.',
      };
    case 'OpenClaw':
      return {
        config: json({
          mcp: {
            servers: {
              postiz: {
                url: urlBase,
                transport: 'streamable-http',
                headers: { Authorization: bearer },
              },
            },
          },
        }),
        hint: 'Add to ~/.openclaw/openclaw.json',
      };
    case 'NanoClaw':
      // No headers flag, the key travels inside the URL like remote clients
      return {
        config: `ncl groups config add-mcp-server --id <group-id> --name postiz --url ${mcpBase}/mcp/${apiKey}`,
        hint: 'Run this in your terminal, replace <group-id> with the agent group that should get Postiz.',
      };
  }
};

export const getMcpConfig = (
  ...args: Parameters<typeof getMcpConfigRaw>
): {
  config: string;
  hint: string;
  hintKey?: string;
  hintDefault?: string;
} => {
  const { config, hint, hintKey, hintDefault } = getMcpConfigRaw(...args);
  return { config, hint: hint ?? hintDefault ?? '', hintKey, hintDefault };
};

export const CopyButton = ({
  text,
  label,
}: {
  text: string;
  label: string;
}) => {
  const toaster = useToaster();
  return (
    <button
      type="button"
      onClick={() => {
        copy(text);
        toaster.show(`${label} copied to clipboard`, 'success');
      }}
      className="cursor-pointer px-[16px] h-[36px] bg-btnSimple hover:bg-boxHover transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
      </svg>
      {label}
    </button>
  );
};

const ExternalLinkIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const DocsLinkButton = ({
  href,
  label,
  tooltip,
}: {
  href: string;
  label: string;
  tooltip?: string;
}) => (
  <a
    className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    {...(tooltip
      ? { 'data-tooltip-id': 'tooltip', 'data-tooltip-content': tooltip }
      : {})}
  >
    <ExternalLinkIcon />
    {label}
  </a>
);

const McpSection = ({
  apiKey,
  mcpBase,
}: {
  apiKey: string;
  mcpBase: string;
}) => {
  const t = useT();
  const { billingEnabled } = useVariables();
  const [activeClient, setActiveClient] = useState<AnyMcpClient>('Claude');
  const officialConnectors = billingEnabled || isSelfHosted;
  // the directory connectors come first wherever they work
  const tabs: Array<'official' | McpAuth> = officialConnectors
    ? ['official', 'oauth', 'apikey']
    : ['oauth', 'apikey'];
  const [tab, setTab] = useState(tabs[0]);
  const auth: McpAuth = tab === 'apikey' ? 'apikey' : 'oauth';
  const [revealed, setRevealed] = useState(false);

  const {
    config,
    hint: rawHint,
    hintKey,
    hintDefault,
  } = getMcpConfig(activeClient, auth, mcpBase, apiKey);
  const hint = hintKey ? t(hintKey, hintDefault ?? rawHint) : rawHint;

  const baseUrl = auth === 'oauth' ? getMcpOauthUrl(mcpBase) : `${mcpBase}/mcp`;

  const chatOnly = isChatOnlyMcpClient(activeClient);

  const maskedConfig =
    revealed || auth === 'oauth' || chatOnly
      ? config
      : config.replace(
          new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          '*'.repeat(apiKey.length)
        );

  return (
    <div className="bg-newBgColorInnerInner rounded-[12px] border border-newBorder overflow-hidden">
      <div className="bg-newBgColorInner px-[20px] mobile:px-[14px] py-[14px] border-b border-newBorder flex items-start justify-between gap-[12px] mobile:flex-col">
        <div>
          <div className="text-[15px] font-[600]">
            {t('mcp_client_configuration', 'MCP Client Configuration')}
          </div>
          <div className="text-[13px] text-customColor18 mt-[2px]">
            {t(
              'connect_your_mcp_client_to_postiz_to_schedule_your_posts_faster',
              'Connect Postiz MCP server to your client (Http streaming) to schedule your posts faster.'
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-[6px] shrink-0 pt-[2px]">
          {officialConnectors && (
            <>
              <a
                className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
                href={mcpConnectorUrls.Claude}
                target="_blank"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                {t('add_to_claude', 'Add to Claude')}
              </a>
              <a
                className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
                href={mcpConnectorUrls.ChatGPT}
                target="_blank"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                {t('add_to_chatgpt', 'Add to ChatGPT')}
              </a>
            </>
          )}
          <DocsLinkButton
            href="https://docs.postiz.com/mcp/introduction"
            label={t('read_the_docs', 'Docs')}
          />
        </div>
      </div>
      <div className="p-[20px] mobile:p-[14px] flex flex-col gap-[16px]">
        {(tab === 'official' || !chatOnly) && (
          <div className="flex flex-col gap-[6px]">
            <div className="text-[13px] font-[600] text-customColor18">
              {t('auth_method', 'Authentication')}
            </div>
            <div className="flex flex-wrap gap-[6px]">
              {tabs.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={clsx(
                    'cursor-pointer px-[14px] h-[36px] text-[13px] font-[500] rounded-[8px] transition-colors',
                    tab === m
                      ? 'bg-[#612BD3] text-white'
                      : 'bg-btnSimple text-customColor18 hover:bg-boxHover hover:text-textColor'
                  )}
                  onClick={() => setTab(m)}
                >
                  {m === 'official'
                    ? t('official_connector', 'Official connector')
                    : m === 'oauth'
                    ? t('sign_in_no_api_key', 'Sign in with Postiz (no API key)')
                    : t('api_key', 'API Key')}
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === 'official' ? (
          <div className="flex flex-col gap-[8px]">
            <div className="text-[12px] text-customColor18 font-[500]">
              {isSelfHosted
                ? t(
                    'connector_self_hosted_description',
                    'The official connector works with self-hosted Postiz too. When asked to sign in, choose "Use self-hosted" and enter {{url}} with your API key.',
                    { url: mcpBase, interpolation: { escapeValue: false } }
                  )
                : t(
                    'connector_onboarding_description',
                    'The fastest way: add Postiz with one click, you will be asked to sign in'
                  )}
            </div>
            <div className="flex flex-wrap gap-[8px]">
              {officialConnectorClients.map((client) => (
                <a
                  key={client}
                  className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[8px]"
                  href={mcpConnectorUrls[client]}
                  target="_blank"
                >
                  <McpClientIcon client={client} />
                  {client === 'Claude'
                    ? t('add_to_claude', 'Add to Claude')
                    : client === 'ChatGPT'
                    ? t('add_to_chatgpt', 'Add to ChatGPT')
                    : client === 'Cursor'
                    ? t('add_to_cursor', 'Add to Cursor')
                    : t('add_to_grok_bot', 'Add to Grok Bot')}
                </a>
              ))}
            </div>
          </div>
        ) : (
          <>
        <div className="flex flex-col gap-[6px]">
          <div className="text-[13px] font-[600] text-customColor18">
            {t('mcp_client', 'Client')}
          </div>
          <div className="flex flex-wrap gap-[6px]">
            {[
              ...Object.keys(remoteMcpClients),
              ...mcpClients,
              ...Object.keys(chatOnlyMcpClients),
            ].map((client) => (
              <button
                key={client}
                type="button"
                className={clsx(
                  'cursor-pointer px-[14px] h-[36px] text-[13px] font-[500] rounded-[8px] transition-colors flex items-center gap-[8px]',
                  activeClient === client
                    ? 'bg-[#612BD3] text-white'
                    : 'bg-btnSimple text-customColor18 hover:bg-boxHover hover:text-textColor'
                )}
                onClick={() =>
                  setActiveClient(client as AnyMcpClient)
                }
              >
                <McpClientIcon client={client} />
                {client}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-[8px]">
          <div className="text-[12px] text-customColor18 font-[500]">
            {hint}
            {auth === 'oauth' &&
              !chatOnly &&
              ` ${t(
                'oauth_sign_in_hint',
                'Your agent will open a browser window to sign in to Postiz.'
              )}`}
          </div>
          <pre className="bg-newBgColorInner border border-newBorder rounded-[8px] p-[16px] text-[13px] whitespace-pre-wrap break-all overflow-x-auto leading-[1.6]">
            {maskedConfig}
          </pre>
          <div className="flex flex-wrap gap-[8px]">
            {auth === 'apikey' && !chatOnly && (
              <button
                type="button"
                onClick={() => setRevealed(!revealed)}
                className="cursor-pointer px-[16px] h-[36px] bg-btnSimple hover:bg-boxHover transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {revealed ? (
                    <>
                      <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </>
                  ) : (
                    <>
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </>
                  )}
                </svg>
                {revealed ? t('hide', 'Hide') : t('reveal', 'Reveal')}
              </button>
            )}
            <CopyButton text={config} label={t('copy', 'Copy')} />
            {!isRemoteMcpClient(activeClient) && !chatOnly && (
              <CopyButton text={baseUrl} label={t('copy_url', 'Copy URL')} />
            )}
            {activeClient === 'Claude' && officialConnectors && (
              <a
                className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
                href={mcpConnectorUrls.Claude}
                target="_blank"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                {t('add_to_claude', 'Add to Claude')}
              </a>
            )}
            {activeClient === 'ChatGPT' && officialConnectors && (
              <a
                className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
                href={mcpConnectorUrls.ChatGPT}
                target="_blank"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                {t('add_to_chatgpt', 'Add to ChatGPT')}
              </a>
            )}
            {activeClient === 'Grok Bot' && officialConnectors && (
              <a
                className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
                href={mcpConnectorUrls['Grok Bot']}
                target="_blank"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
                {t('add_to_grok_bot', 'Add to Grok Bot')}
              </a>
            )}
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
};

export const localCliSteps = [
  {
    label: 'Install the CLI',
    code: 'npm install -g postiz',
  },
  {
    label: 'Run: postiz auth:login',
    code: 'postiz auth:login',
  },
  {
    label: 'Install the Postiz skill for your AI agent',
    code: 'npx skills add gitroomhq/postiz-agent',
  },
] as const;

const ciCliSteps = [
  {
    label: 'Install the CLI',
    code: 'npm install -g postiz',
  },
  {
    label: 'Set your API key as an environment variable',
    code: 'export POSTIZ_API_KEY="{API_KEY}"',
  },
  {
    label: 'Install the Postiz skill for your AI agent',
    code: 'npx skills add gitroomhq/postiz-agent',
  },
] as const;

const cliStepKeys: Record<string, string> = {
  'Install the CLI': 'cli_step_install',
  'Set your API key as an environment variable': 'cli_step_set_key',
  'Install the Postiz skill for your AI agent': 'cli_step_install_skill',
};

const CliSection = ({ apiKey }: { apiKey: string }) => {
  const t = useT();
  const [mode, setMode] = useState<'local' | 'ci'>('local');
  const [revealed, setRevealed] = useState(false);

  const steps =
    mode === 'local'
      ? localCliSteps.map((step) => ({ ...step }))
      : ciCliSteps.map((step) => ({
          ...step,
          code: step.code.replace('{API_KEY}', apiKey),
        }));

  const displaySteps =
    mode === 'ci' && !revealed
      ? steps.map((step) => ({
          ...step,
          code: step.code.replace(
            new RegExp(apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
            '*'.repeat(apiKey.length)
          ),
        }))
      : steps;

  return (
    <div className="bg-newBgColorInnerInner rounded-[12px] border border-newBorder overflow-hidden">
      <div className="bg-newBgColorInner px-[20px] mobile:px-[14px] py-[14px] border-b border-newBorder flex items-start justify-between gap-[12px] mobile:flex-col">
        <div>
          <div className="text-[15px] font-[600]">
            {t('cli_and_skills', 'CLI & AI Skills')}
          </div>
          <div className="text-[13px] text-customColor18 mt-[2px]">
            {t(
              'cli_description',
              'Use the Postiz CLI to automate posting from your terminal, or install the skill to let your AI agent schedule posts for you.'
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-[6px] shrink-0 pt-[2px]">
          <a
            className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
            href="https://docs.postiz.com/cli/introduction"
            target="_blank"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
            {t('read_the_docs', 'Docs')}
          </a>
        </div>
      </div>
      <div className="p-[20px] mobile:p-[14px] flex flex-col gap-[16px]">
        <div className="flex gap-[6px]">
          {(['local', 'ci'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={clsx(
                'cursor-pointer px-[14px] h-[36px] text-[13px] font-[500] rounded-[8px] transition-colors',
                mode === m
                  ? 'bg-[#612BD3] text-white'
                  : 'bg-btnSimple text-customColor18 hover:bg-boxHover hover:text-textColor'
              )}
              onClick={() => setMode(m)}
            >
              {m === 'local'
                ? t('locally', 'Locally')
                : t('ci_remote_servers', 'CI / Remote servers')}
            </button>
          ))}
        </div>
        {displaySteps.map((step, i) => (
          <div key={i} className="flex flex-col gap-[6px]">
            <div className="text-[13px] font-[600] text-customColor18">
              {i + 1}.{' '}
              {cliStepKeys[step.label]
                ? t(cliStepKeys[step.label], step.label)
                : step.label}
            </div>
            <pre className="bg-newBgColorInner border border-newBorder rounded-[8px] p-[16px] text-[13px] whitespace-pre-wrap break-all overflow-x-auto leading-[1.6]">
              {step.code}
            </pre>
          </div>
        ))}
        <div className="flex flex-wrap gap-[8px]">
          {mode === 'ci' && (
            <button
              type="button"
              onClick={() => setRevealed(!revealed)}
              className="cursor-pointer px-[16px] h-[36px] bg-btnSimple hover:bg-boxHover transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {revealed ? (
                  <>
                    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </>
                ) : (
                  <>
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </>
                )}
              </svg>
              {revealed ? t('hide', 'Hide') : t('reveal', 'Reveal')}
            </button>
          )}
          <CopyButton
            text={steps.map((s) => s.code).join(' && ')}
            label={t('copy_all', 'Copy All')}
          />
        </div>
      </div>
    </div>
  );
};

const RevealEyeIcon = ({ revealed }: { revealed: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {revealed ? (
      <>
        <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" />
        <path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </>
    ) : (
      <>
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </>
    )}
  </svg>
);

const RotateIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.5 2v6h-6" />
    <path d="M21.34 15.57a10 10 0 11-.57-8.38L21.5 8" />
  </svg>
);

const ApiKeyCard = ({
  title,
  description,
  apiKey,
  reveal,
  onReveal,
  onRotate,
  extraActions,
  docsUrl,
}: {
  title: string;
  description: string;
  apiKey: string;
  reveal: boolean;
  onReveal: () => void;
  onRotate: () => void;
  extraActions?: React.ReactNode;
  docsUrl?: string;
}) => {
  const t = useT();
  return (
    <div className="bg-newBgColorInnerInner rounded-[12px] border border-newBorder overflow-hidden">
      <div className="bg-newBgColorInner px-[20px] mobile:px-[14px] py-[14px] border-b border-newBorder flex items-start justify-between gap-[12px] mobile:flex-col">
        <div>
          <div className="text-[15px] font-[600]">{title}</div>
          <div className="text-[13px] text-customColor18 mt-[2px]">{description}</div>
        </div>
        {docsUrl && (
          <div className="flex gap-[6px] shrink-0 pt-[2px]">
            <DocsLinkButton
              href={docsUrl}
              label={t('read_the_docs', 'Docs')}
              tooltip={t('api_reference_tooltip', 'Documentação da API (Swagger)')}
            />
          </div>
        )}
      </div>
      <div className="p-[20px] mobile:p-[14px] flex flex-col gap-[16px]">
        <div className="bg-newBgColorInner border border-newBorder rounded-[8px] px-[16px] h-[44px] flex items-center overflow-hidden">
          <code className="text-[14px] flex-1 truncate">
            {reveal ? (
              apiKey
            ) : (
              <span className="flex items-center">
                <span className="blur-sm select-none">{apiKey.slice(0, -5)}</span>
                <span>{apiKey.slice(-5)}</span>
              </span>
            )}
          </code>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          <button type="button" onClick={onReveal} className="cursor-pointer px-[16px] h-[36px] bg-btnSimple hover:bg-boxHover transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]">
            <RevealEyeIcon revealed={reveal} />
            {reveal ? t('hide', 'Hide') : t('reveal', 'Reveal')}
          </button>
          <CopyButton text={apiKey} label={t('copy', 'Copy')} />
          <button type="button" onClick={onRotate} className="cursor-pointer px-[16px] h-[36px] bg-btnSimple hover:bg-boxHover transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]">
            <RotateIcon />
            {t('rotate_key', 'Rotate Key')}
          </button>
          {extraActions}
        </div>
      </div>
    </div>
  );
};

const ProfileApiKeySection = ({ profileId }: { profileId: string }) => {
  const user = useUser();
  const fetch = useFetch();
  const toaster = useToaster();
  const decision = useDecisionModal();
  const { mutate } = useSWRConfig();
  const { backendUrl } = useVariables();
  const t = useT();
  const [reveal, setReveal] = useState(false);

  const docsUrl = `${backendUrl}/docs`;

  const generateKey = useCallback(async () => {
    await fetch(`/profiles/${profileId}/api-key/rotate`, { method: 'POST' });
    await mutate('/user/self');
    toaster.show(t('profile_api_key_generated', 'Profile API Key generated'), 'success');
  }, [fetch, mutate, profileId, t, toaster]);

  const rotateKey = useCallback(async () => {
    const approved = await decision.open({
      title: t('rotate_profile_api_key', 'Rotate Profile API Key?'),
      description: t('rotate_profile_api_key_description', 'The old key will stop working immediately.'),
      approveLabel: t('rotate', 'Rotate'),
      cancelLabel: t('cancel', 'Cancel'),
    });
    if (!approved) return;
    await fetch(`/profiles/${profileId}/api-key/rotate`, { method: 'POST' });
    await mutate('/user/self');
    setReveal(false);
    toaster.show(t('profile_api_key_rotated', 'Profile API Key rotated'), 'success');
  }, [decision, fetch, mutate, profileId, t, toaster]);

  if (!user) return null;

  if (!user.profileApiKey) {
    return (
      <div className="bg-newBgColorInnerInner rounded-[12px] border border-newBorder overflow-hidden">
        <div className="bg-newBgColorInner px-[20px] mobile:px-[14px] py-[14px] border-b border-newBorder flex items-start justify-between gap-[12px] mobile:flex-col">
          <div>
            <div className="text-[15px] font-[600]">{t('profile_api_key', 'Profile API Key')}</div>
            <div className="text-[13px] text-customColor18 mt-[2px]">{t('profile_api_key_description', 'Scoped access to this profile only.')}</div>
          </div>
          <div className="flex gap-[6px] shrink-0 pt-[2px]">
            <DocsLinkButton
              href={docsUrl}
              label={t('read_the_docs', 'Docs')}
              tooltip={t('api_reference_tooltip', 'Documentação da API (Swagger)')}
            />
          </div>
        </div>
        <div className="p-[20px]">
          <button type="button" onClick={generateKey} className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]">
            {t('generate_profile_api_key', 'Generate Key')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ApiKeyCard
      title={t('profile_api_key', 'Profile API Key')}
      description={t('profile_api_key_description', 'Scoped access to this profile only.')}
      apiKey={user.profileApiKey}
      reveal={reveal}
      onReveal={() => setReveal(!reveal)}
      onRotate={rotateKey}
      docsUrl={docsUrl}
    />
  );
};

const AgentSkillSection = ({ backendUrl }: { backendUrl: string }) => {
  const t = useT();
  const skillUrl = `${backendUrl}/public/agent-skill`;
  return (
    <div className="bg-newBgColorInnerInner rounded-[12px] border border-newBorder overflow-hidden">
      <div className="bg-newBgColorInner px-[20px] mobile:px-[14px] py-[14px] border-b border-newBorder flex items-start justify-between gap-[12px] mobile:flex-col">
        <div>
          <div className="text-[15px] font-[600]">
            {t('agent_skill', 'Skill para Agentes de IA')}
          </div>
          <div className="text-[13px] text-customColor18 mt-[2px]">
            {t(
              'agent_skill_description',
              'Guia completo (MCP + CLI + API) para o agente. Passe este link + sua Chave de API ao agente (Hermes, OpenClaw, Claude, etc.).'
            )}
          </div>
        </div>
        <div className="flex gap-[6px] shrink-0 pt-[2px]">
          <a
            className="cursor-pointer px-[16px] h-[36px] bg-[#612BD3] hover:bg-[#5520CB] text-white transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
            href={skillUrl}
            target="_blank"
            rel="noreferrer"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
            {t('open', 'Abrir')}
          </a>
        </div>
      </div>
      <div className="p-[20px] mobile:p-[14px] flex flex-col gap-[16px]">
        <div className="bg-newBgColorInner border border-newBorder rounded-[8px] px-[16px] h-[44px] flex items-center overflow-hidden">
          <code className="text-[14px] flex-1 truncate">{skillUrl}</code>
        </div>
        <div className="flex flex-wrap gap-[8px]">
          <CopyButton text={skillUrl} label={t('copy_skill_link', 'Copiar link da skill')} />
        </div>
      </div>
    </div>
  );
};

const PublicApiContent = () => {
  const user = useUser();
  const { profile } = useCurrentProfile();
  const { backendUrl, frontEndUrl, mcpUrl } = useVariables();
  const toaster = useToaster();
  const fetch = useFetch();
  const decision = useDecisionModal();
  const { mutate } = useSWRConfig();
  const t = useT();
  const [revealOrg, setRevealOrg] = useState(false);

  const isDefault = profile?.isDefault ?? true;

  const rotateOrgKey = useCallback(async () => {
    const approved = await decision.open({
      title: t('rotate_api_key', 'Rotate API Key?'),
      description: t(
        'rotate_api_key_description',
        'This will generate a new API key and invalidate the current one. Any integrations using the old key will stop working.'
      ),
      approveLabel: t('rotate', 'Rotate'),
      cancelLabel: t('cancel', 'Cancel'),
    });
    if (!approved) return;
    await fetch('/user/api-key/rotate', { method: 'POST' });
    await mutate('/user/self');
    setRevealOrg(false);
    toaster.show(t('api_key_rotated', 'API Key rotated successfully'), 'success');
  }, [decision, fetch, mutate, toaster]);

  if (!user || !user.publicApi) {
    return null;
  }

  const mcpBase = mcpUrl || backendUrl;
  const docsUrl = `${backendUrl}/docs`;
  const activeKey = isDefault ? user.publicApi : (user.profileApiKey ?? user.publicApi);

  const wizardButton = (
    <button
      type="button"
      data-tooltip-id="tooltip"
      data-tooltip-content={t(
        'payload_wizard_description',
        'Building a POST request to /posts can be complex. Use the wizard to schedule a post with the UI, then copy the generated payload.'
      )}
      onClick={() => window.open(`${frontEndUrl}/modal/dark/all`, '_blank')}
      className="cursor-pointer px-[16px] h-[36px] bg-btnSimple hover:bg-boxHover transition-colors rounded-[8px] text-[13px] font-[600] flex items-center gap-[6px]"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
      {t('open_wizard', 'Open Wizard')}
    </button>
  );

  return (
    <div className="flex flex-col gap-[40px]">
      <div className="text-[14px] text-textColor leading-[1.7]">
        {t('api_auth_note_line1', 'Use your API Key to automate your own account.')}
        <br />
        {t('api_auth_note_line2', 'If you are building a product that schedules posts on behalf of other Postiz users,')}
        <br />
        {t('api_auth_note_line3', 'create an OAuth App under the "Apps" tab. Your users will authorize your app via OAuth2,')}
        <br />
        {t('api_auth_note_line4', 'and you will receive a pos_ prefixed token that works with the API, MCP, and CLI — just like an API Key.')}
      </div>

      {isDefault && (
        <ApiKeyCard
          title={t('org_api_key', 'Organization API Key')}
          description={t('org_api_key_description', 'Full access to all profiles.')}
          apiKey={user.publicApi}
          reveal={revealOrg}
          onReveal={() => setRevealOrg(!revealOrg)}
          onRotate={rotateOrgKey}
          extraActions={wizardButton}
          docsUrl={docsUrl}
        />
      )}

      {user.profileId && (
        <ProfileApiKeySection profileId={user.profileId} />
      )}

      <AgentSkillSection backendUrl={backendUrl} />
      <CliSection apiKey={activeKey} />
      <McpSection apiKey={activeKey} mcpBase={mcpBase} />
    </div>
  );
};

export const PublicComponent = () => {
  const t = useT();

  return (
    <div className="flex flex-col gap-[20px]">
      <h3 className="text-[20px]">
        {t('integrations_menu', 'Integrations')}
      </h3>
      <PublicApiContent />
    </div>
  );
};
