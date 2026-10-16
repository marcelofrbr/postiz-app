import {
  AnalyticsData,
  AuthTokenDetails,
  PendingCheckResponse,
  ClientInformation,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import dayjs from 'dayjs';
import {
  BadBody,
  RefreshToken,
  SocialAbstract,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  FacebookDto,
  FACEBOOK_PRESET_MAX_CHARS,
} from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/facebook.dto';
import { DribbbleDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/dribbble.dto';
import { Integration } from '@prisma/client';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { timer } from '@gitroom/helpers/utils/timer';
import { Rules } from '@gitroom/nestjs-libraries/chat/rules.description.decorator';
import {
  META_FACEBOOK_GRAPH_URL,
  META_FACEBOOK_OAUTH_URL,
} from '@gitroom/nestjs-libraries/integrations/social/meta-graph.constants';

// Aborta a chamada Graph API se passar de `timeoutMs` ms. Evita que uma
// chamada lenta a graph.facebook.com (comum em agencias com muitas pages
// via Business Manager) trave o OAuth callback inteiro e cause 504 do Nginx.
async function fetchWithTimeout(
  url: string,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export { META_GRAPH_API_VERSION } from '@gitroom/nestjs-libraries/integrations/social/meta-graph.constants';

@Rules(
  "Facebook posts can be text only, or include photos or a video. If it's a story, it must have at least one attachment (photo or video), and each media is published as a separate story. Video posts (not stories) can carry an optional title."
)
export class FacebookProvider extends SocialAbstract implements SocialProvider {
  identifier = 'facebook';
  name = 'Facebook Page';
  isBetweenSteps = true;
  // refreshToken() abaixo e stub: Page Access Token nao se renova por
  // refresh_token. Ver noNativeRefresh na interface.
  noNativeRefresh = true;
  scopes = [
    'pages_show_list',
    'business_management',
    'pages_manage_posts',
    'pages_manage_engagement',
    'pages_read_engagement',
    'read_insights',
  ];
  override maxConcurrentJob = 500; // Facebook has reasonable rate limits
  editor = 'normal' as const;
  maxLength() {
    return 63206;
  }
  dto = FacebookDto;

  override async checkValidity(
    [firstPost]: Array<ValidityMedia[]>,
    settings: any
  ): Promise<string | true> {
    if (settings?.post_type === 'story') {
      if (!firstPost?.length) {
        return 'Story should have at least one media';
      }
    }
    return true;
  }

  override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry';
        value: string;
      }
    | undefined {
    // Access token validation errors - require re-authentication
    if (body.indexOf('Error validating access token') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Please re-authenticate your Facebook account',
      };
    }

    if (body.indexOf('REVOKED_ACCESS_TOKEN') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Access token has been revoked, please re-authenticate',
      };
    }

    // The token is valid but belongs to the user, not to the page - the page
    // was never granted to the app, so only reconnecting can fix it
    if (
      body.indexOf(
        'Unpublished posts must be posted to a page as the page itself'
      ) > -1
    ) {
      return {
        type: 'refresh-token' as const,
        value:
          'Postiz is not authorized to publish as this page, please reconnect the channel',
      };
    }

    if (body.indexOf('(#200)') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Facebook rejected the post due to missing permissions. Make sure your Facebook account has full content access to the Page, then reconnect the channel.',
      };
    }

    if (body.indexOf('1366046') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Photos should be smaller than 4 MB and saved as JPG, PNG',
      };
    }

    // code 368 "Temporarily blocked for policies violations" (subcode
    // 1390008): Meta documents it as temporary, "wait and retry the operation"
    if (body.indexOf('1390008') > -1) {
      return {
        type: 'retry' as const,
        value: 'You are posting too fast, please slow down',
      };
    }

    // Content policy violations
    if (body.indexOf('1346003') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Content flagged as abusive by Facebook',
      };
    }

    if (body.indexOf('1404006') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          "We couldn't post your comment, A security check in facebook required to proceed.",
      };
    }

    if (body.indexOf('2069019') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid file',
      }
    }

    if (body.indexOf('1404102') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Content violates Facebook Community Standards',
      };
    }

    // Permission errors
    if (body.indexOf('1404078') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Page publishing authorization required, please re-authenticate',
      };
    }

    if (body.indexOf('1366051') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'These photos were already posted.',
      };
    }

    if (body.indexOf('1609008') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Cannot post Facebook.com links',
      };
    }

    // Parameter validation errors
    if (body.indexOf('2061006') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid URL format in post content',
      };
    }

    if (body.indexOf('1349125') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Invalid content format',
      };
    }

    if (body.indexOf('1404112') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'For security reasons, your account has limited access to the site for a few days',
      };
    }

    if (body.indexOf('Name parameter too long') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Post content is too long',
      };
    }

    // Service errors - checking specific subcodes first
    if (body.indexOf('1363047') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Facebook service temporarily unavailable',
      };
    }

    if (body.indexOf('1609010') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Facebook service temporarily unavailable',
      };
    }

    if (body.indexOf('4854002') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Confirm your identity before you can publish as this Page. Open the Facebook app on your phone and follow the instructions',
      };
    }
    if (body.indexOf('(#100) No permission to publish the video') > -1) {
      return {
        type: 'bad-body' as const,
        value: 'Facebook return: No permission to publish the video',
      };
    }
    if (/"error_subcode":459\b/.test(body)) {
      return {
        type: 'bad-body' as const,
        value:
          'Facebook is asking you to resolve a security check. Log in at facebook.com, complete it, then try again',
      };
    }
    if (/"error_subcode":492\b/.test(body)) {
      return {
        type: 'bad-body' as const,
        value:
          'Your Facebook user no longer has a role on this Page. Ask a Page admin to grant you a role, then reconnect the channel',
      };
    }
    if (body.indexOf('must be granted before impersonating') > -1) {
      return {
        type: 'refresh-token' as const,
        value:
          'Facebook Page permissions are missing, please reconnect the channel and allow all permissions',
      };
    }
    if (
      /"error_subcode":33\b/.test(body) &&
      body.indexOf('does not exist') > -1
    ) {
      return {
        type: 'bad-body' as const,
        value:
          'The Facebook Page or post this was targeting no longer exists, please reconnect the channel and schedule again',
      };
    }
    if (body.indexOf('Sorry, something went wrong') > -1) {
      return {
        type: 'retry' as const,
        value: 'Facebook is temporarily unavailable, please try again later',
      };
    }
    if (body.indexOf('490') > -1) {
      return {
        type: 'refresh-token' as const,
        value: 'Access token expired, please re-authenticate',
      };
    }

    if (status === 401) {
      return {
        type: 'bad-body' as const,
        value:
          'An unknown error occurred, please try again later or contact support',
      };
    }

    return undefined;
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async generateAuthUrl(clientInformation?: ClientInformation) {
    const clientId = clientInformation?.client_id || process.env.FACEBOOK_APP_ID;
    const state = makeSecureId(6);
    return {
      url:
        `${META_FACEBOOK_OAUTH_URL}/dialog/oauth` +
        `?client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(
          `${process.env.FRONTEND_URL}/integrations/social/facebook`
        )}` +
        `&state=${state}` +
        `&scope=${this.scopes.join(',')}`,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const information = await this.fetchPageInformation(accessToken, {
      page: requiredId,
    });

    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }, clientInformation?: ClientInformation) {
    const clientId = clientInformation?.client_id || process.env.FACEBOOK_APP_ID;
    const clientSecret = clientInformation?.client_secret || process.env.FACEBOOK_APP_SECRET;

    console.log('[Facebook.authenticate] credentials source:', {
      hasClientInfo: !!clientInformation,
      clientIdPrefix: String(clientId || '').slice(0, 6) + '...',
      hasSecret: !!clientSecret,
      redirectUri: `${process.env.FRONTEND_URL}/integrations/social/facebook${
        params.refresh ? `?refresh=${params.refresh}` : ''
      }`,
    });

    const getAccessToken = await (
      await fetchWithTimeout(
        `${META_FACEBOOK_GRAPH_URL}/oauth/access_token` +
          `?client_id=${clientId}` +
          `&redirect_uri=${encodeURIComponent(
            `${process.env.FRONTEND_URL}/integrations/social/facebook${
              params.refresh ? `?refresh=${params.refresh}` : ''
            }`
          )}` +
          `&client_secret=${clientSecret}` +
          `&code=${params.code}`
      )
    ).json();

    if (!getAccessToken.access_token) {
      console.error('[Facebook.authenticate] token exchange retornou erro:', getAccessToken);
      throw new Error(
        `Meta token exchange failed: ${JSON.stringify(getAccessToken.error || getAccessToken)}`
      );
    }

    const longLivedResponse = await (
      await fetchWithTimeout(
        `${META_FACEBOOK_GRAPH_URL}/oauth/access_token` +
          '?grant_type=fb_exchange_token' +
          `&client_id=${clientId}` +
          `&client_secret=${clientSecret}` +
          `&fb_exchange_token=${getAccessToken.access_token}&fields=access_token,expires_in`
      )
    ).json();

    if (!longLivedResponse.access_token) {
      console.error('[Facebook.authenticate] long-lived token exchange retornou erro:', longLivedResponse);
      throw new Error(
        `Meta long-lived token exchange failed: ${JSON.stringify(longLivedResponse.error || longLivedResponse)}`
      );
    }
    const { access_token } = longLivedResponse;

    const permsResponse = await (
      await fetchWithTimeout(
        `${META_FACEBOOK_GRAPH_URL}/me/permissions?access_token=${access_token}`
      )
    ).json();

    if (!permsResponse.data) {
      console.error('[Facebook.authenticate] /me/permissions retornou erro:', permsResponse);
      throw new Error(
        `Meta /me/permissions failed: ${JSON.stringify(permsResponse.error || permsResponse)}`
      );
    }
    const { data } = permsResponse;

    const permissions = data
      .filter((d: any) => d.status === 'granted')
      .map((p: any) => p.permission);
    this.checkScopes(this.scopes, permissions);

    const { id, name, picture } = await (
      await fetchWithTimeout(
        `${META_FACEBOOK_GRAPH_URL}/me?fields=id,name,picture&access_token=${access_token}`
      )
    ).json();

    return {
      id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(59, 'days').unix() - dayjs().unix(),
      picture: picture?.data?.url || '',
      username: '',
    };
  }

  async pages(accessToken: string) {
    const seenIds = new Set<string>();
    const allPages: any[] = [];

    // Orcamento total de 90s para o pages() inteiro. Se ultrapassar, retornamos
    // os resultados parciais ja coletados — evita 504 do Nginx em agencias com
    // muitas pages via Business Manager.
    const overallDeadline = Date.now() + 90000;
    const budgetExceeded = () => Date.now() > overallDeadline;

    const fetchPaginated = async (startUrl: string) => {
      let nextUrl: string | undefined = startUrl;
      while (nextUrl) {
        if (budgetExceeded()) return;
        const response = await (await fetchWithTimeout(nextUrl)).json();
        if (response.data) {
          for (const page of response.data) {
            if (!seenIds.has(page.id)) {
              seenIds.add(page.id);
              allPages.push(page);
            }
          }
        }
        nextUrl = response.paging?.next;
      }
    };

    // Fetch pages the user explicitly shared during the OAuth dialog
    try {
      await fetchPaginated(
        `${META_FACEBOOK_GRAPH_URL}/me/accounts?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${accessToken}`
      );
    } catch (err) {
      console.warn('[Facebook.pages] /me/accounts failed:', (err as Error)?.message);
    }

    // Also fetch pages via Business Manager API to discover pages not selected
    // during the OAuth page selection step. Atencao: o custo escala com o
    // numero de BMs selecionados no Meta App — apps com muitos BMs podem
    // estourar o rate limit (#4 "Application request limit reached"). Controle
    // no painel do Meta App selecionando apenas os BMs necessarios. O budget
    // de 90s + timeouts individuais garantem que nunca pendura indefinido.
    if (!budgetExceeded()) {
      try {
        let bizUrl:
          | string
          | undefined = `${META_FACEBOOK_GRAPH_URL}/me/businesses?access_token=${accessToken}`;

        while (bizUrl && !budgetExceeded()) {
          const bizResponse = await (await fetchWithTimeout(bizUrl)).json();
          if (bizResponse.data) {
            for (const business of bizResponse.data) {
              if (budgetExceeded()) break;
              try {
                await fetchPaginated(
                  `${META_FACEBOOK_GRAPH_URL}/${business.id}/owned_pages?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${accessToken}`
                );
              } catch {
                // Continue with other businesses
              }

              if (budgetExceeded()) break;
              try {
                await fetchPaginated(
                  `${META_FACEBOOK_GRAPH_URL}/${business.id}/client_pages?fields=id,username,name,access_token,picture.type(large)&limit=100&access_token=${accessToken}`
                );
              } catch {
                // Continue with other businesses
              }
            }
          }
          bizUrl = bizResponse.paging?.next;
        }
      } catch {
        // Business Manager API not available for all users
      }
    }

    if (budgetExceeded()) {
      console.warn(
        `[Facebook.pages] budget de 90s estourado — retornando ${allPages.length} paginas coletadas ate agora`
      );
    }

    return allPages;
  }

  async fetchPageInformation(accessToken: string, data: { page: string }) {
    const pageId = data.page;
    const fields = 'id,username,name,access_token,picture.type(large)';
    let foundWithoutToken = false;

    const searchPaginated = async (startUrl: string) => {
      let url: string | undefined = startUrl;
      while (url) {
        const response = await (await fetchWithTimeout(url)).json();
        if (response.data) {
          const page = response.data.find(
            (p: any) => String(p.id) === String(pageId)
          );
          // A page listed through a business the user has no role on comes
          // back without a page token, keep looking for a listing that has one
          if (page && !page.access_token) {
            foundWithoutToken = true;
          } else if (page) {
            return {
              id: page.id,
              name: page.name,
              access_token: page.access_token,
              picture: page.picture?.data?.url || '',
              username: page.username,
            };
          }
        }
        url = response.paging?.next;
      }
      return null;
    };

    // 1. Check /me/accounts
    const fromAccounts = await searchPaginated(
      `${META_FACEBOOK_GRAPH_URL}/me/accounts?fields=${fields}&limit=100&access_token=${accessToken}`
    );
    if (fromAccounts) return fromAccounts;

    // 2. Check Business Manager owned_pages and client_pages.
    // Custo escala com o numero de BMs no Meta App — controle a quantidade
    // de BMs selecionados no painel do App para evitar estourar rate limit.
    try {
      let bizUrl:
        | string
        | undefined = `${META_FACEBOOK_GRAPH_URL}/me/businesses?access_token=${accessToken}`;

      while (bizUrl) {
        const bizResponse = await (await fetchWithTimeout(bizUrl)).json();
        if (bizResponse.data) {
          for (const business of bizResponse.data) {
            try {
              const fromOwned = await searchPaginated(
                `${META_FACEBOOK_GRAPH_URL}/${business.id}/owned_pages?fields=${fields}&limit=100&access_token=${accessToken}`
              );
              if (fromOwned) return fromOwned;
            } catch {
              // Continue with other businesses
            }

            try {
              const fromClient = await searchPaginated(
                `${META_FACEBOOK_GRAPH_URL}/${business.id}/client_pages?fields=${fields}&limit=100&access_token=${accessToken}`
              );
              if (fromClient) return fromClient;
            } catch {
              // Continue with other businesses
            }
          }
        }
        bizUrl = bizResponse.paging?.next;
      }
    } catch {
      // Business Manager API not available for all users
    }

    if (foundWithoutToken) {
      throw new Error(
        'Your Facebook user has no permission to manage this page. Ask a page admin for full content access, then reconnect the channel'
      );
    }

    throw new Error('Page not found in your accounts');
  }

  // Single, read-only status check of a story video - the polling loop that
  // used to live inside post() is now driven by the post workflow.
  private async fbVideoStatus(videoId: string, accessToken: string) {
    const { status } = await (
      await this.fetch(
        `${META_FACEBOOK_GRAPH_URL}/${videoId}?fields=status&access_token=${accessToken}`,
        undefined,
        '',
        0,
        true
      )
    ).json();

    const videoStatus = status?.video_status || 'in_progress';

    if (videoStatus === 'error') {
      throw new BadBody(
        this.identifier,
        JSON.stringify({ status }),
        '{}',
        'Video processing failed'
      );
    }

    return videoStatus === 'upload_complete' || videoStatus === 'ready';
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const isStory = firstPost?.settings?.post_type === 'story';

    if (isStory) {
      // Only upload the media here - uploads are invisible until the
      // publish calls, which run one at a time in finalizePost so a failure
      // can never re-publish the stories that already went out.
      const items = [];
      for (const media of firstPost?.media || []) {
        if (hasExtension(media.path, 'mp4')) {
          const { video_id, upload_url } = await (
            await this.fetch(
              `${META_FACEBOOK_GRAPH_URL}/${id}/video_stories?upload_phase=start&access_token=${accessToken}`,
              {
                method: 'POST',
              },
              'start video story upload'
            )
          ).json();

          await this.fetch(
            upload_url,
            {
              method: 'POST',
              headers: {
                Authorization: `OAuth ${accessToken}`,
                file_url: media.path,
              },
            },
            'upload video story'
          );

          items.push({ kind: 'video', mediaId: video_id });
        } else {
          const { id: photoId } = await (
            await this.fetch(
              `${META_FACEBOOK_GRAPH_URL}/${id}/photos?access_token=${accessToken}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  url: media.path,
                  published: false,
                }),
              },
              'upload photo story'
            )
          ).json();

          items.push({ kind: 'photo', mediaId: photoId });
        }
      }

      return [
        {
          id: firstPost.id,
          postId: '',
          releaseURL: '',
          status: 'pending',
          pendingData: {
            postType: 'story',
            items,
            publishedCount: 0,
            lastPostId: '',
          },
        },
      ];
    }

    return this.postNonStory(id, accessToken, postDetails);
  }

  override async checkPostStatus(
    accessToken: string,
    pendingData: {
      postType: 'story';
      items: { kind: 'video' | 'photo'; mediaId: string }[];
      publishedCount: number;
      lastPostId: string;
      attempting?: number | null;
      confirmed?: boolean;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    // A confirmed publish attempt died without reporting its result: Facebook
    // has no API to ask whether a story was published, so never publish that
    // item again - stop with an explicit warning instead.
    if (pendingData.attempting != null && pendingData.confirmed) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Facebook may have already published part of the story, please check your page before posting again to avoid duplicates'
      );
    }

    // wait for every not-yet-published video to finish processing, photos are
    // ready as soon as they are uploaded
    for (const item of pendingData.items.slice(pendingData.publishedCount)) {
      if (item.kind !== 'video') {
        continue;
      }

      if (!(await this.fbVideoStatus(item.mediaId, accessToken))) {
        return { status: 'pending', pendingData };
      }
    }

    // witness the armed publish so finalizePost knows the attempt is uniquely
    // accounted for before it mutates anything
    if (pendingData.attempting != null && !pendingData.confirmed) {
      return {
        status: 'ready',
        pendingData: { ...pendingData, confirmed: true },
      };
    }

    return { status: 'ready', pendingData };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: {
      postType: 'story';
      items: { kind: 'video' | 'photo'; mediaId: string }[];
      publishedCount: number;
      lastPostId: string;
      attempting?: number | null;
      confirmed?: boolean;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    // Publish exactly one story per call, with an arm -> confirm -> publish
    // handshake: the publish only runs after checkPostStatus witnessed the
    // intent, so a run that dies mid-publish is detectable and the item is
    // never published twice.
    if (pendingData.attempting == null || !pendingData.confirmed) {
      return {
        status: 'pending',
        pendingData: {
          ...pendingData,
          attempting: pendingData.publishedCount,
          confirmed: false,
        },
      };
    }

    const item = pendingData.items[pendingData.publishedCount];

    const { post_id: storyPostId } = await (
      await this.fetch(
        item.kind === 'video'
          ? `${META_FACEBOOK_GRAPH_URL}/${integration.internalId}/video_stories?upload_phase=finish&video_id=${item.mediaId}&access_token=${accessToken}`
          : `${META_FACEBOOK_GRAPH_URL}/${integration.internalId}/photo_stories?photo_id=${item.mediaId}&access_token=${accessToken}`,
        {
          method: 'POST',
        },
        item.kind === 'video'
          ? 'finish video story upload'
          : 'publish photo story'
      )
    ).json();

    const publishedCount = pendingData.publishedCount + 1;

    if (publishedCount < pendingData.items.length) {
      return {
        status: 'pending',
        pendingData: {
          ...pendingData,
          publishedCount,
          lastPostId: storyPostId,
          attempting: null,
          confirmed: false,
        },
      };
    }

    return {
      status: 'completed',
      postId: storyPostId,
      releaseURL: `https://www.facebook.com/stories/${storyPostId}`,
    };
  }

  // Old blocking behavior, kept for workflow versions before v1.0.6 that don't
  // know how to resolve a `pending` response.
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const [response] = await this.postPending(
      id,
      accessToken,
      postDetails,
      integration
    );

    if (response.status !== 'pending') {
      return [response];
    }

    let pendingData = response.pendingData;
    const started = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Cap below the 10-minute activity timeout of the old workflows using
      // this method: failing here (non-retryable) is safe, timing the
      // activity out is not - a retried activity would publish again.
      if (Date.now() - started > 8 * 60 * 1000) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          'Video processing timed out'
        );
      }

      const check = await this.checkPostStatus(
        accessToken,
        pendingData,
        integration
      );

      if (check.status === 'pending') {
        pendingData = check.pendingData;
        await timer(10000);
        continue;
      }

      const result =
        check.status === 'ready'
          ? await this.finalizePost(accessToken, check.pendingData, integration)
          : check;

      if (result.status === 'completed') {
        return [
          {
            id: firstPost.id,
            postId: result.postId,
            releaseURL: result.releaseURL,
            status: 'success',
          },
        ];
      }

      pendingData = result.pendingData;
    }
  }

  private async postNonStory(
    id: string,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[]
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;

    // Facebook Page Stories: publica via /photo_stories e /video_stories.
    // Story nao tem carrossel — cada midia vira um story separado, igual ao IG.
    if (firstPost?.settings?.post_type === 'story') {
      return this.postStory(id, accessToken, firstPost);
    }

    let finalId = '';
    let finalUrl = '';
    if (hasExtension(firstPost?.media?.[0]?.path, 'mp4')) {
      const {
        id: videoId,
        permalink_url,
        ...all
      } = await (
        await this.fetch(
          `${META_FACEBOOK_GRAPH_URL}/${id}/videos?access_token=${accessToken}&fields=id,permalink_url`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              file_url: firstPost?.media?.[0]?.path!,
              description: firstPost.message,
              ...(firstPost?.settings?.title
                ? { title: firstPost.settings.title }
                : {}),
              published: true,
            }),
          },
          'upload mp4'
        )
      ).json();

      finalUrl = 'https://www.facebook.com/reel/' + videoId;
      finalId = videoId;
    } else {
      const uploadPhotos = !firstPost?.media?.length
        ? []
        : await Promise.all(
            firstPost.media.map(async (media) => {
              const { id: photoId } = await (
                await this.fetch(
                  `${META_FACEBOOK_GRAPH_URL}/${id}/photos?access_token=${accessToken}`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                      url: media.path,
                      published: false,
                    }),
                  },
                  'upload images slides'
                )
              ).json();

              return { media_fbid: photoId };
            })
          );

      // Background presets are only valid on text-only posts (no media) and
      // Facebook caps them at ~130 chars, so we only attach the preset when it
      // can apply.
      const presetId =
        !uploadPhotos?.length &&
        firstPost?.settings?.text_format_preset_id &&
        (firstPost.message?.length || 0) <= FACEBOOK_PRESET_MAX_CHARS
          ? firstPost.settings.text_format_preset_id
          : undefined;

      const publishFeed = async (withPreset: boolean) =>
        (
          await this.fetch(
            `${META_FACEBOOK_GRAPH_URL}/${id}/feed?access_token=${accessToken}&fields=id,permalink_url`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                ...(uploadPhotos?.length
                  ? { attached_media: uploadPhotos }
                  : {}),
                ...(firstPost?.settings?.url
                  ? { link: firstPost.settings.url }
                  : {}),
                ...(withPreset && presetId
                  ? { text_format_preset_id: presetId }
                  : {}),
                message: firstPost.message,
                published: true,
              }),
            },
            'finalize upload'
          )
        ).json();

      // Facebook exposes no official preset list and adds/retires backgrounds
      // over time, so a stale text_format_preset_id can make FB reject the whole
      // post. Observed Graph API responses for a bad preset:
      //   - malformed id  -> HTTP 400, code 100, message names
      //                      "text_format_preset_id" explicitly
      //   - retired numeric id -> HTTP 500, code 1, generic "unknown error"
      //     (our fetch() retries 500s and then reports it with the body stripped)
      // So retry once without the preset on an explicit preset error or a
      // generic/unknown failure, but never on a recognized auth/token error
      // (dropping the background can't fix that). A retry that only succeeds once
      // the preset is removed confirms the preset was the cause.
      const isPresetRejection = (err: any): boolean => {
        const detail = `${err?.details?.[0]?.json ?? ''} ${err?.message ?? ''}`;
        if (
          /access token|re-authenticate|revoked|"code":\s*190\b/i.test(detail)
        ) {
          return false;
        }
        return (
          /text_format_preset_id/i.test(detail) ||
          /"code":\s*1\b/.test(detail) ||
          String(err?.message) === 'Unknown Error'
        );
      };

      let feedResult: any;
      try {
        feedResult = await publishFeed(!!presetId);
      } catch (err) {
        if (!presetId || !isPresetRejection(err)) {
          throw err;
        }
        // Surface the (recovered) rejection in the logs, since the fallback
        // below makes the activity succeed and Facebook's error would otherwise
        // be swallowed silently.
        console.warn(
          'Facebook rejected text_format_preset_id — dropping the background and publishing as plain text',
          {
            preset: presetId,
            facebook: (err as any)?.details?.[0]?.json,
            message: (err as any)?.message,
          }
        );
        feedResult = await publishFeed(false);
      }

      const { id: postId, permalink_url, ...all } = feedResult;

      finalUrl = permalink_url;
      finalId = postId;
    }

    return [
      {
        id: firstPost.id,
        postId: finalId,
        releaseURL: finalUrl,
        status: 'success',
      },
    ];
  }

  // Publica uma ou mais midias como Facebook Page Stories. Story nao suporta
  // carrossel, entao cada midia e publicada como um story independente —
  // mesmo comportamento do InstagramProvider para stories com multiplas midias.
  private async postStory(
    id: string,
    accessToken: string,
    firstPost: PostDetails<FacebookDto>
  ): Promise<PostResponse[]> {
    const medias = firstPost?.media || [];
    if (!medias.length) {
      // A validacao do frontend (checkValidity) ja impede isso; guarda defensiva.
      throw new BadBody(
        'facebook-story',
        '{}',
        '{}',
        'Facebook Stories require at least one media'
      );
    }

    let lastPostId = '';
    for (const media of medias) {
      const isVideo = (media?.path?.indexOf('mp4') || -2) > -1;
      lastPostId = isVideo
        ? await this.uploadVideoStory(id, accessToken, media.path)
        : await this.uploadPhotoStory(id, accessToken, media.path);
    }

    return [
      {
        id: firstPost.id,
        postId: lastPostId,
        releaseURL: `https://www.facebook.com/${lastPostId}`,
        status: 'success',
      },
    ];
  }

  // Story de foto: faz upload da imagem como nao-publicada para obter o photo_id
  // e em seguida publica via /photo_stories. Retorna o post_id do story.
  private async uploadPhotoStory(
    id: string,
    accessToken: string,
    url: string
  ): Promise<string> {
    const { id: photoId } = await (
      await this.fetch(
        `${META_FACEBOOK_GRAPH_URL}/${id}/photos?access_token=${accessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, published: false }),
        },
        'upload story photo'
      )
    ).json();

    const { post_id } = await (
      await this.fetch(
        `${META_FACEBOOK_GRAPH_URL}/${id}/photo_stories?access_token=${accessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photo_id: photoId }),
        },
        'publish photo story'
      )
    ).json();

    return String(post_id || photoId);
  }

  // Story de video: upload resumavel em 3 fases (start -> upload -> finish).
  // No upload usamos o header `file_url` para a Meta buscar o arquivo do nosso
  // storage hospedado (R2/local com URL publica), evitando streamar bytes.
  private async uploadVideoStory(
    id: string,
    accessToken: string,
    fileUrl: string
  ): Promise<string> {
    // Fase 1 — start: cria a sessao e devolve video_id + upload_url (rupload).
    const { video_id, upload_url } = await (
      await this.fetch(
        `${META_FACEBOOK_GRAPH_URL}/${id}/video_stories?access_token=${accessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upload_phase: 'start' }),
        },
        'start video story'
      )
    ).json();

    // Fase 2 — upload hospedado: Meta busca o arquivo pela URL.
    await this.fetch(
      upload_url,
      {
        method: 'POST',
        headers: {
          Authorization: `OAuth ${accessToken}`,
          file_url: fileUrl,
        },
      },
      'upload video story'
    );

    await this.waitForVideoStoryUpload(video_id, accessToken);

    // Fase 3 — finish: publica o story.
    const { post_id } = await (
      await this.fetch(
        `${META_FACEBOOK_GRAPH_URL}/${id}/video_stories?access_token=${accessToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upload_phase: 'finish', video_id }),
        },
        'finish video story'
      )
    ).json();

    return String(post_id || video_id);
  }

  private async waitForVideoStoryUpload(
    videoId: string,
    accessToken: string
  ): Promise<void> {
    // O activity de publicacao tem timeout de 10 minutos. Limitamos o polling
    // a menos de 8 minutos para falhar de forma explicita antes de o Temporal
    // interromper a activity e correr o risco de um retry cego.
    const maxAttempts = 48;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const { status } = await (
        await this.fetch(
          `${META_FACEBOOK_GRAPH_URL}/${videoId}?fields=status&access_token=${accessToken}`,
          undefined,
          'check video story upload',
          0,
          true
        )
      ).json();
      const videoStatus = status?.video_status || 'in_progress';

      if (videoStatus === 'upload_complete' || videoStatus === 'ready') {
        return;
      }
      if (videoStatus === 'error') {
        throw new BadBody(
          'facebook-story',
          JSON.stringify({ status }),
          '{}',
          'Facebook could not process the Story video'
        );
      }

      if (attempt < maxAttempts - 1) {
        await timer(10000);
      }
    }

    throw new BadBody(
      'facebook-story',
      '{}',
      '{}',
      'Facebook Story video processing timed out'
    );
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<FacebookDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [commentPost] = postDetails;
    const replyToId = lastCommentId || postId;

    const data = await (
      await this.fetch(
        `${META_FACEBOOK_GRAPH_URL}/${replyToId}/comments?access_token=${accessToken}&fields=id,permalink_url`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...(commentPost.media?.length
              ? { attachment_url: commentPost.media[0].path }
              : {}),
            message: commentPost.message,
          }),
        },
        'add comment'
      )
    ).json();

    return [
      {
        id: commentPost.id,
        postId: data.id,
        releaseURL: data.permalink_url,
        status: 'success',
      },
    ];
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const until = dayjs().endOf('day').unix();
    const since = dayjs().subtract(date, 'day').unix();

    // Reach/impression metrics (page_impressions_unique, page_posts_impressions_unique,
    // page_video_views) were deprecated by Meta on 2026-06-15 and now return an
    // "invalid metric" error. They are replaced by the Media Views metrics, which
    // require Graph API v23.0+:
    //   - page_total_media_view_unique: total unique views on the page's media (reach)
    //   - page_media_view: total media views, broken down between paid and organic
    const { data, error } = await (
      await this.analyticsFetch(
        `${META_FACEBOOK_GRAPH_URL}/${id}/insights?metric=page_total_media_view_unique,page_media_view,page_post_engagements,page_daily_follows&access_token=${accessToken}&period=day&since=${since}&until=${until}`
      )
    ).json();

    // Throw so checkAnalytics doesn't cache the empty result for an hour.
    if (error) {
      console.warn('Facebook page insights returned an error:', { id, error });
      throw new Error(error.message);
    }

    // page_media_view returns paid/organic breakdowns as an object; sum them to
    // keep the single-total UI working.
    const sumValue = (value: any): number => {
      if (value && typeof value === 'object') {
        return Object.values(value as Record<string, number>).reduce(
          (sum: number, v: number) => sum + (Number(v) || 0),
          0
        );
      }
      return Number(value) || 0;
    };

    return (
      data?.map((d: any) => ({
        label:
          d.name === 'page_total_media_view_unique'
            ? 'Page Impressions'
            : d.name === 'page_post_engagements'
            ? 'Posts Engagement'
            : d.name === 'page_daily_follows'
            ? 'Page followers'
            : 'Media views',
        percentageChange: 5,
        data: d?.values?.map((v: any) => ({
          total: sumValue(v.value),
          date: dayjs(v.end_time).format('YYYY-MM-DD'),
        })),
      })) || []
    );
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');

    // The stored id (releaseId) shape depends on the post type set in post():
    //   - feed post  -> `{pageid}_{postid}` (contains `_`), has an `insights` edge
    //   - reel/video -> bare numeric video id, NO `insights` edge (only `video_insights`)
    //   - story      -> bare story id, no usable insights via this path
    // There is no separate stored type, so id shape is the discriminator. Calling
    // `/{videoId}/insights` on a video/story node returns
    // `(#100) Tried accessing nonexisting field (insights)`, which is what surfaced
    // in prod as "Error fetching Facebook post analytics: ApplicationFailure". Route
    // bare ids to the video-only edge instead.
    if (!postId.includes('_')) {
      return this.videoPostAnalytics(accessToken, postId, today);
    }

    try {
      // Fetch post insights from Facebook Graph API.
      // post_impressions_unique was deprecated by Meta on 2026-06-15; it is replaced
      // by post_total_media_view_unique (unique media views = reach), available on
      // Graph API v23.0+. Engagement metrics below are unaffected.
      const { data } = await (
        await this.analyticsFetch(
          `${META_FACEBOOK_GRAPH_URL}/${postId}/insights?metric=post_total_media_view_unique,post_reactions_by_type_total,post_clicks,post_clicks_by_type&access_token=${accessToken}`
        )
      ).json();

      if (!data || data.length === 0) {
        return [];
      }

      const result: AnalyticsData[] = [];

      for (const metric of data) {
        const value = metric.values?.[0]?.value;
        if (value === undefined) continue;

        let label = '';
        let total = '';

        switch (metric.name) {
          case 'post_total_media_view_unique':
            label = 'Impressions';
            total = String(value);
            break;
          case 'post_clicks':
            label = 'Clicks';
            total = String(value);
            break;
          case 'post_clicks_by_type':
            // This returns an object with click types
            if (typeof value === 'object') {
              const totalClicks = Object.values(
                value as Record<string, number>
              ).reduce((sum: number, v: number) => sum + v, 0);
              label = 'Clicks by Type';
              total = String(totalClicks);
            }
            break;
          case 'post_reactions_by_type_total':
            // This returns an object with reaction types
            if (typeof value === 'object') {
              const totalReactions = Object.values(
                value as Record<string, number>
              ).reduce((sum: number, v: number) => sum + v, 0);
              label = 'Reactions';
              total = String(totalReactions);
            }
            break;
        }

        if (label) {
          result.push({
            label,
            percentageChange: 0,
            data: [{ total, date: today }],
          });
        }
      }

      return result;
    } catch (err) {
      if (err instanceof RefreshToken) {
        throw err;
      }
      console.error('Error fetching Facebook post analytics:', err);
      return [];
    }
  }

  // Video/reel posts store a bare video id whose node has no `insights` edge; their
  // analytics live on the `/{videoId}/video_insights` edge instead. Story posts also
  // store a bare id but have no usable insights here — the video_insights call comes
  // back with an `error` (or empty data), which we swallow to an empty result so a
  // single story/video can't break the statistics page.
  private async videoPostAnalytics(
    accessToken: string,
    videoId: string,
    today: string
  ): Promise<AnalyticsData[]> {
    try {
      // Metric names verified against the Graph API v23.0 video_insights docs:
      //   - total_video_views: 3s+ (or full, if shorter) plays
      //   - total_video_reactions_by_type_total: reactions object, keyed by type
      // total_video_impressions is no longer accepted (Graph answers
      // "The value must be a valid insights metric", which fails the whole
      // request), so it is not requested.
      // Reels never return the total_video_* metrics (the edge answers with an
      // empty data array), only the reels ones, so both sets are requested at
      // once and Graph simply omits the metrics that don't apply:
      //   - fb_reels_total_plays: plays including replays
      //   - post_video_likes_by_reaction_type: reactions object, keyed by type
      //   - post_video_social_actions: comments/shares object, keyed by type
      // Use plain fetch (not this.fetch) so a `(#100) nonexisting field` / story
      // response doesn't throw an ApplicationFailure — we want a quiet `[]` instead.
      const { data, error } = await (
        await this.analyticsFetch(
          `${META_FACEBOOK_GRAPH_URL}/${videoId}/video_insights?metric=total_video_views,total_video_reactions_by_type_total,fb_reels_total_plays,post_video_likes_by_reaction_type,post_video_social_actions&access_token=${accessToken}`
        )
      ).json();

      // Stories (and videos without this edge) come back with an error / no data —
      // return an empty result quietly rather than logging a scary error. But a
      // `nonexisting field (video_insights)` is the only "expected" error here; any
      // other error (bad metric name, token, permissions) means the fix is silently
      // returning empty when it shouldn't be, so surface it as a warning (not a throw,
      // not a scary error) so it's diagnosable without breaking the statistics page.
      if (error || !data || data.length === 0) {
        if (error && !/nonexisting field/i.test(error.message || '')) {
          console.warn('Facebook video_insights returned an error:', {
            videoId,
            error,
          });
        }
        return [];
      }

      const result: AnalyticsData[] = [];

      for (const metric of data) {
        const value = metric.values?.[0]?.value;
        if (value === undefined) continue;

        let label = '';
        let total = '';

        switch (metric.name) {
          case 'total_video_views':
            label = 'Views';
            total = String(value);
            break;
          case 'fb_reels_total_plays':
            label = 'Plays';
            total = String(value);
            break;
          case 'total_video_reactions_by_type_total':
          case 'post_video_likes_by_reaction_type':
            // This returns an object with reaction types
            if (typeof value === 'object') {
              const totalReactions = Object.values(
                value as Record<string, number>
              ).reduce((sum: number, v: number) => sum + v, 0);
              label = 'Reactions';
              total = String(totalReactions);
            }
            break;
          case 'post_video_social_actions':
            // This returns an object with action types (comments, shares)
            if (typeof value === 'object') {
              const totalActions = Object.values(
                value as Record<string, number>
              ).reduce((sum: number, v: number) => sum + v, 0);
              label = 'Engagement';
              total = String(totalActions);
            }
            break;
        }

        if (label) {
          result.push({
            label,
            percentageChange: 0,
            data: [{ total, date: today }],
          });
        }
      }

      return result;
    } catch (err) {
      console.error('Error fetching Facebook video post analytics:', err);
      return [];
    }
  }
}
