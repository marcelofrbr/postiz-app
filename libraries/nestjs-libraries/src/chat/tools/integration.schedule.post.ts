import { AgentToolInterface } from '@gitroom/nestjs-libraries/chat/agent.tool.interface';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { Injectable } from '@nestjs/common';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { AllProvidersSettings } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/all.providers.settings';
import { Integration } from '@prisma/client';
import { checkAuth } from '@gitroom/nestjs-libraries/chat/auth.context';
import {
  ValidUrlExtension,
  ValidUrlPath,
} from '@gitroom/helpers/utils/valid.url.path';
import { readRequestContext } from '@gitroom/nestjs-libraries/chat/tools/tool.context.helper';

const validUrlExtension = new ValidUrlExtension();
const validUrlPath = new ValidUrlPath();

// Same URL validation as MediaDto (valid.url.path) - each attachment must
// point to an allowed upload domain and a supported file extension.
const attachmentUrl = z
  .string()
  .refine((url) => validUrlPath.validate(url, {} as any), {
    message: validUrlPath.defaultMessage({} as any),
  })
  .refine((url) => validUrlExtension.validate(url, {} as any), {
    message: validUrlExtension.defaultMessage({} as any),
  });

// Settings values chegam do agent sempre como string (schema compatibility com
// Gemini). Tentamos reidratar via JSON.parse — se for "true", "42", "[...]",
// "{...}" volta o tipo nativo. Strings cruas ("video-id-xyz") nao sao JSON
// validas e ficam intactas. Numeros como "42" sao parseaveis e voltam number.
function tryParseJson(value: string): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (
    trimmed === '' ||
    (!/^[\[{]/.test(trimmed) &&
      !/^(true|false|null)$/i.test(trimmed) &&
      !/^-?\d/.test(trimmed))
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

@Injectable()
export class IntegrationSchedulePostTool implements AgentToolInterface {
  constructor(
    private _postsService: PostsService,
    private _integrationService: IntegrationService
  ) {}
  name = 'integrationSchedulePostTool';

  run() {
    return createTool({
      id: 'schedulePostTool',
      mcp: {
        annotations: {
          title: 'Schedule Social Media Post',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      description: `
Use this when the user wants to create a draft, scheduled, or immediate social media post on their connected channels, based on the integrationSchema tool.
Examples of the input shape:

A single LinkedIn post with one comment
- socialPost array length will be one
- postsAndComments array length will be two (one for the post, one for the comment)

20 Facebook posts each on individual days without comments
- socialPost array length will be 20
- postsAndComments array length will be one

Do not use this to update or delete existing posts.
On success, each item in output contains a previewUrl the user can open to see the post.
If validation fails, the result contains output.errors describing what to fix; the call can be retried with corrected parameters.
`,
      inputSchema: z.object({
        socialPost: z
          .array(
            z.object({
              integrationId: z
                .string()
                .describe('The id of the integration (not internal id)'),
              isPremium: z
                .boolean()
                .describe(
                  "If the integration is X, return if it's premium or not"
                ),
              date: z.string().describe('The date of the post in UTC time'),
              shortLink: z
                .boolean()
                .describe(
                  'If the post has a link inside, we can ask the user if they want to add a short link'
                ),
              type: z
                .enum(['draft', 'schedule', 'now'])
                .describe(
                  'The type of the post, if we pass now, we should pass the current date also'
                ),
              postsAndComments: z
                .array(
                  z.object({
                    content: z
                      .string()
                      .describe(
                        "The content of the post, HTML, Each line must be wrapped in <p> here is the possible tags: h1, h2, h3, u, strong, li, ul, p (you can't have u and strong together), img (<img src=\"...\">) only when the integration rules say pictures go inside the content, and span only for a mention in the exact format given by a mention tool from the integrationSchema tools"
                      ),
                    attachments: z
                      .array(attachmentUrl)
                      .describe('The image of the post (URLS)'),
                  })
                )
                .describe(
                  'first item is the post, every other item is the comments'
                ),
              settings: z
                .array(
                  z.object({
                    key: z
                      .string()
                      .describe('Name of the settings key to pass'),
                    value: z
                      .string()
                      .describe(
                        'Value of the key as a string. For complex values (objects, arrays, numbers, booleans) send a JSON-stringified representation — the backend will JSON.parse it transparently. For simple ids/labels, send the raw string. Always prefer the id then label if possible. When the settings schema says a field is an id, pass the id returned by the channel tools, never the display label.'
                      ),
                  })
                )
                .describe(
                  'This relies on the integrationSchema tool to get the settings [input:settings]'
                ),
            })
          )
          .describe('Individual post'),
      }),
      outputSchema: z.object({
        output: z
          .array(
            z.object({
              postId: z.string(),
              integration: z.string(),
              previewUrl: z
                .string()
                .describe(
                  'Public preview page of the created post, share it with the user'
                ),
            })
          )
          .or(z.object({ errors: z.string() })),
      }),
      execute: async (input: any, options: any) => {
        checkAuth(input, options);
        const requestContext = readRequestContext(options);
        const organizationId = JSON.parse(
          requestContext.get('organization') as string
        ).id;
        const profileId =
          (requestContext.get('profileId') as string) || undefined;
        const finalOutput = [];

        const integrations = {} as Record<string, Integration>;
        for (const platform of input.socialPost) {
          integrations[platform.integrationId] =
            await this._integrationService.getIntegrationById(
              organizationId,
              platform.integrationId
            );

          if (
            profileId &&
            integrations[platform.integrationId]?.profileId &&
            integrations[platform.integrationId].profileId !== profileId
          ) {
            throw new Error('Integration does not belong to the active profile');
          }

          // Same server-side validation as the dashboard / public API
          // (settings DTO + media checkValidity + empty / too-long content).
          const settings = platform.settings.reduce(
            (acc: AllProvidersSettings, s: { key: string; value: any }) => ({
              ...acc,
              [s.key]: tryParseJson(s.value),
            }),
            {} as AllProvidersSettings
          );

          const [validation] = await this._postsService.validatePosts(
            organizationId,
            [
              {
                integration: { id: platform.integrationId },
                settings,
                value: platform.postsAndComments.map((p: any) => ({
                  content: p.content,
                  image: (p.attachments || []).map((path: string) => ({
                    path,
                  })),
                })),
              },
            ]
          );

          if (validation.emptyContent) {
            return {
              output: {
                errors: `${validation.name}: Your post should have at least one character or one image.`,
              },
            };
          }

          if (platform.type !== 'draft') {
            if (!validation.valid) {
              return {
                output: {
                  errors: `${validation.name}: ${
                    validation.settingsError || 'Please fix your settings'
                  }, please fix it, and try integrationSchedulePostTool again.`,
                },
              };
            }

            if (validation.errors !== true) {
              return {
                output: {
                  errors: `${validation.name}: ${validation.errors}, please fix it, and try integrationSchedulePostTool again.`,
                },
              };
            }

            if (validation.tooLong) {
              return {
                output: {
                  errors: `${validation.name}: The maximum characters is ${validation.maximumCharacters}, please fix it, and try integrationSchedulePostTool again.`,
                },
              };
            }
          }
        }

        for (const post of input.socialPost) {
          const integration = integrations[post.integrationId];

          if (!integration) {
            throw new Error('Integration not found');
          }

          const output = await this._postsService.createPost(organizationId, {
            date: post.date,
            type: post.type as 'draft' | 'schedule' | 'now',
            shortLink: post.shortLink,
            tags: [],
            posts: [
              {
                integration,
                group: makeId(10),
                settings: post.settings.reduce(
                  (acc: any, s: any) => ({
                    ...acc,
                    // Schema declara value como string (compatibilidade Gemini);
                    // tentamos JSON.parse para reidratar arrays/objects/numbers/booleans.
                    // Falha de parse → mantemos como string crua.
                    [s.key]: tryParseJson(s.value),
                  }),
                  {
                    __type: integration.providerIdentifier,
                  } as AllProvidersSettings
                ),
                value: post.postsAndComments.map((p: any) => ({
                  content: p.content,
                  id: makeId(10),
                  delay: 0,
                  image: p.attachments.map((p: any) => ({
                    id: makeId(10),
                    path: p,
                  })),
                })),
              },
            ],
          }, 'MCP', false, profileId);
          // Same public preview page the calendar "Preview Post" button opens.
          finalOutput.push(
            ...output.map((p) => ({
              ...p,
              previewUrl: `${process.env.FRONTEND_URL}/p/${p.postId}?share=true`,
            }))
          );
        }

        return {
          output: finalOutput,
        };
      },
    });
  }
}
