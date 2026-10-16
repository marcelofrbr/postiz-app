import { Injectable } from '@nestjs/common';
import {
  Activity,
  ActivityMethod,
  TemporalService,
} from 'nestjs-temporal-core';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import {
  NotificationPayload,
  NotificationService,
  NotificationType,
} from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { Integration, Post, State } from '@prisma/client';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  AuthTokenDetails,
  PendingCheckResponse,
  PostResponse,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { timer } from '@gitroom/helpers/utils/timer';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { WebhooksService } from '@gitroom/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { TypedSearchAttributes } from '@temporalio/common';
import {
  organizationId,
  postId as postIdSearchParam,
} from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { FlowsService } from '@gitroom/nestjs-libraries/database/prisma/flows/flows.service';
import { EncryptionService } from '@gitroom/nestjs-libraries/crypto/encryption.service';
import { decryptIntegrationToken } from '@gitroom/nestjs-libraries/crypto/integration-token.helper';
import {
  setHeartbeatDetails,
  withHeartbeat,
} from '@gitroom/nestjs-libraries/temporal/temporal.heartbeat';
import { assertSafePendingData } from '@gitroom/nestjs-libraries/temporal/pending-post-state';
import { selectPostWorkflowVersion } from '@gitroom/nestjs-libraries/temporal/post-workflow-version';
import {
  BadBody,
  Disconnect,
  PublishedWithError,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';

// Drops fields the workflow and downstream activities never read — biggest wins are `error` (grows per retry) and `childrenPost` (Prisma side-loads it on every recursive row).
function slimPost(post: any) {
  if (!post) return post;
  const {
    error,
    childrenPost,
    tags,
    description,
    title,
    submittedForOrderId,
    submittedForOrganizationId,
    submittedForOrder,
    submittedForOrganization,
    lastMessageId,
    parentPostId,
    approvedSubmitForOrder,
    deletedAt,
    createdAt,
    updatedAt,
    payoutProblems,
    comments,
    errors,
    ...rest
  } = post;
  return rest;
}

// A genuinely missed occurrence (dead workflow) is only recovered by the
// missing-posts sweep, which runs every hour - so anything later than the
// sweep period plus retry margin is a stale anchor, not a missed publish.
const REANCHOR_GRACE_MS = 2 * 60 * 60 * 1000;

// A repeat post keeps its original anchor publishDate forever (updatePost only
// flips the state, the calendar expands occurrences virtually). If the workflow
// gets that raw past date, any (re)start - an accidental edit resetting the
// state to QUEUE, or a missing-posts sweep poke - sleeps 0 and publishes
// instantly, machine-gunning the channel. Roll the returned date forward to the
// next occurrence on the anchor grid instead, so fresh starts wait for the next
// real occurrence. Only for the initial QUEUE run: repeat chain children
// (postNow) run against a PUBLISHED post and must keep publishing immediately.
// Occurrences missed within the grace window still catch up and post.
function reanchorInterval(post: any) {
  if (!post?.intervalInDays || post.state !== State.QUEUE) {
    return post;
  }

  const interval = post.intervalInDays * 24 * 60 * 60 * 1000;
  const late = Date.now() - new Date(post.publishDate).getTime();
  if (late <= REANCHOR_GRACE_MS) {
    return post;
  }

  const next =
    new Date(post.publishDate).getTime() +
    Math.ceil(late / interval) * interval;

  return { ...post, publishDate: new Date(next) };
}

@Injectable()
@Activity()
export class PostActivity {
  constructor(
    private _postService: PostsService,
    private _notificationService: NotificationService,
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _webhookService: WebhooksService,
    private _temporalService: TemporalService,
    private _subscriptionService: SubscriptionService,
    private _flowsService: FlowsService,
    private _encryption: EncryptionService
  ) {}

  @ActivityMethod()
  async getIntegrationById(orgId: string, id: string) {
    return this._integrationService.getIntegrationById(orgId, id);
  }

  @ActivityMethod()
  async searchForMissingThreeHoursPosts() {
    const list = await this._postService.searchForMissingThreeHoursPosts();
    for (const post of list) {
      const workflowName = selectPostWorkflowVersion({
        integrationId: post.integration.id,
        providerIdentifier: post.integration.providerIdentifier,
      });
      await this._temporalService.client
        .getRawClient()
        .workflow.signalWithStart(workflowName, {
          workflowId: `post_${post.id}`,
          taskQueue: 'main',
          signal: 'poke',
          workflowIdConflictPolicy: 'USE_EXISTING',
          signalArgs: [],
          args: [
            {
              taskQueue: post.integration.providerIdentifier.startsWith('zernio-')
                ? 'main'
                : post.integration.providerIdentifier
                    .split('-')[0]
                    .toLowerCase(),
              postId: post.id,
              organizationId: post.organizationId,
            },
          ],
          typedSearchAttributes: new TypedSearchAttributes([
            {
              key: postIdSearchParam,
              value: post.id,
            },
            {
              key: organizationId,
              value: post.organizationId,
            },
          ]),
        });
    }
  }

  @ActivityMethod()
  async updatePost(id: string, postId: string, releaseURL: string) {
    await this._postService.updatePost(id, postId, releaseURL);

    // Bind any pending "next_publication" flows to this freshly published
    // media. Stories are excluded. Failures must never break the publish.
    try {
      if (!postId) return;
      const post = await this._postService.getPostById(id);
      if (!post || post.integration?.providerIdentifier !== 'instagram') {
        return;
      }
      let settings: any = {};
      try {
        settings = JSON.parse(post.settings || '{}');
      } catch {
        settings = {};
      }
      if (settings?.post_type === 'story') return;
      await this._flowsService.bindPendingFlowsToPost(
        post.integrationId,
        postId
      );
    } catch {
      // ignore: bind errors must not fail the post publish
    }
  }

  @ActivityMethod()
  async getPost(orgId: string, postId: string) {
    if (process.env.STRIPE_SECRET_KEY) {
      const subscription = await this._subscriptionService.getSubscription(
        orgId
      );
      if (!subscription) {
        return false;
      }
    }
    const post = await this._postService.getPostById(postId, orgId);
    if (post.deletedAt) {
      return false;
    }

    return reanchorInterval(post);
  }

  @ActivityMethod()
  async getPostsList(orgId: string, postId: string) {
    if (process.env.STRIPE_SECRET_KEY) {
      const subscription = await this._subscriptionService.getSubscription(
        orgId
      );
      if (!subscription) {
        return [];
      }
    }

    const getPosts = await this._postService.getPostsRecursively(
      postId,
      true,
      orgId
    );
    if (!getPosts || getPosts.length === 0 || getPosts[0].parentPostId) {
      return [];
    }

    // only the root drives the pre-publish sleep and the repeat schedule,
    // the rest are comments
    const [root, ...comments] = getPosts.map(slimPost);
    return [reanchorInterval(root), ...comments];
  }

  // The V113 reads return the post without the integration credentials, only
  // the ids and flags the workflow needs. Mutating activities reload and
  // decrypt the integration on their own.
  @ActivityMethod()
  async getPostV113(orgId: string, postId: string) {
    if (process.env.STRIPE_SECRET_KEY) {
      const subscription = await this._subscriptionService.getSubscription(
        orgId
      );
      if (!subscription) {
        return false;
      }
    }

    const [post] = await this._postService.getPostsRecursively(
      postId,
      true,
      orgId,
      true
    );
    return post ? this.sanitizePostForWorkflow(reanchorInterval(post)) : false;
  }

  @ActivityMethod()
  async getPostsListV113(orgId: string, postId: string) {
    if (process.env.STRIPE_SECRET_KEY) {
      const subscription = await this._subscriptionService.getSubscription(
        orgId
      );
      if (!subscription) {
        return [];
      }
    }

    const getPosts = await this._postService.getPostsRecursively(
      postId,
      true,
      orgId,
      true
    );
    if (!getPosts || getPosts.length === 0 || getPosts[0].parentPostId) {
      return [];
    }

    const [root, ...comments] = getPosts.map((post) =>
      this.sanitizePostForWorkflow(post)
    );
    return [reanchorInterval(root), ...comments];
  }

  @ActivityMethod()
  async isCommentable(integration: Integration) {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    return !!getIntegration.comment;
  }

  @ActivityMethod()
  async isCommentableForWorkflow(providerIdentifier: string) {
    const provider =
      this._integrationManager.getSocialIntegration(providerIdentifier);
    return !!provider.comment;
  }

  @ActivityMethod()
  async postComment(
    postId: string,
    lastPostId: string | undefined,
    integration: Integration,
    posts: Post[]
  ) {
    // kept only for in-flight postWorkflowV108 runs, which set a
    // heartbeatTimeout on this activity - removing the sender would kill
    // them. Under V109+ (no heartbeatTimeout) this is a no-op and can be
    // dropped once all V108 executions have drained
    return withHeartbeat(() =>
      this.handleDisconnect(integration, async () => {
        const runtimeIntegration = this.withDecryptedToken(integration);
        const getIntegration = this._integrationManager.getSocialIntegration(
          runtimeIntegration.providerIdentifier
        );

        const newPosts = await this._postService.updateTags(
          runtimeIntegration.organizationId,
          posts
        );

        return getIntegration.comment(
          runtimeIntegration.internalId,
          postId,
          lastPostId,
          runtimeIntegration.token,
          await this.mapPosts(getIntegration, newPosts || []),
          runtimeIntegration
        );
      })
    );
  }

  @ActivityMethod()
  async postCommentV113(
    postId: string,
    lastPostId: string | undefined,
    organizationId: string,
    integrationId: string,
    posts: Post[]
  ) {
    return withHeartbeat(async () => {
      const runtimeIntegration = await this.loadRuntimeIntegration(
        organizationId,
        integrationId
      );
      const provider = this._integrationManager.getSocialIntegration(
        runtimeIntegration.providerIdentifier
      );

      setHeartbeatDetails(`${runtimeIntegration.providerIdentifier}: comment`);
      const newPosts = await this._postService.updateTags(
        runtimeIntegration.organizationId,
        posts
      );

      return provider.comment(
        runtimeIntegration.internalId,
        postId,
        lastPostId,
        runtimeIntegration.token,
        await this.mapPosts(provider, newPosts || []),
        runtimeIntegration
      );
    });
  }

  @ActivityMethod()
  async postSocial(integration: Integration, posts: Post[]) {
    return this.postSocialInternal(integration, posts, false);
  }

  // Used by postWorkflowV106 and up: providers that implement `postPending`
  // return a `pending` response the workflow resolves via checkPostStatus /
  // finalizePost. Older workflow versions keep calling `postSocial` and get
  // the old blocking behavior.
  @ActivityMethod()
  async postSocialPending(integration: Integration, posts: Post[]) {
    return this.postSocialInternal(integration, posts, true);
  }

  // Used by postWorkflowV113: same pending contract as postSocialPending, but
  // the integration is loaded and decrypted here instead of crossing the
  // workflow boundary, and pendingData is checked before it reaches history.
  @ActivityMethod()
  async postSocialPendingV113(
    organizationId: string,
    integrationId: string,
    posts: Post[]
  ): Promise<PostResponse[]> {
    return withHeartbeat(async () => {
      const runtimeIntegration = await this.loadRuntimeIntegration(
        organizationId,
        integrationId
      );
      const getIntegration = this._integrationManager.getSocialIntegration(
        runtimeIntegration.providerIdentifier
      );

      setHeartbeatDetails('update tags');
      const newPosts = await this._postService.updateTags(
        runtimeIntegration.organizationId,
        posts
      );
      setHeartbeatDetails('resolve media');
      const mappedPosts = await this.mapPosts(getIntegration, newPosts || []);
      setHeartbeatDetails(`${runtimeIntegration.providerIdentifier}: publish`);

      const response = getIntegration.postPending
        ? await getIntegration.postPending(
            runtimeIntegration.internalId,
            runtimeIntegration.token,
            mappedPosts,
            runtimeIntegration
          )
        : await getIntegration.post(
            runtimeIntegration.internalId,
            runtimeIntegration.token,
            mappedPosts,
            runtimeIntegration
          );

      const validated = response.map((item) =>
        item.status === 'pending'
          ? { ...item, pendingData: assertSafePendingData(item.pendingData) }
          : item
      );

      setHeartbeatDetails(
        `${runtimeIntegration.providerIdentifier}: published, streak`
      );
      try {
        await this.startStreak(runtimeIntegration.organizationId);
      } catch {
        // A notification/telemetry failure after publishing must not repeat it.
      }

      return validated;
    });
  }

  // A Disconnect error means the platform will keep rejecting this channel no
  // matter how many token refreshes (e.g. TikTok's daily active user cap):
  // mark the channel as needing a re-connect and notify the user, then rethrow
  // as BadBody so every workflow version - frozen once on main - treats it as
  // a terminal error without needing a new workflow.
  private async handleDisconnect<T>(
    integration: Integration,
    func: () => Promise<T>
  ): Promise<T> {
    try {
      return await func();
    } catch (err) {
      if (err instanceof Disconnect) {
        try {
          await this._integrationService.disconnectChannel(
            integration.organizationId,
            integration,
            err.message
          );
        } catch (e) {
          /**empty**/
        }

        throw new BadBody(
          integration.providerIdentifier,
          JSON.stringify({}),
          Buffer.from('{}'),
          err.message
        );
      }

      // The post is live but a follow-up mutation failed: keep its platform
      // id / URL on the post, then fail it as BadBody like any other error.
      if (err instanceof PublishedWithError) {
        try {
          await this._postService.updateResolvedRelease(
            err.postDbId,
            integration.organizationId,
            err.releaseId,
            err.releaseURL
          );
        } catch (e) {
          /**empty**/
        }

        throw new BadBody(
          integration.providerIdentifier,
          JSON.stringify({}),
          Buffer.from('{}'),
          err.message
        );
      }

      throw err;
    }
  }

  private async postSocialInternal(
    integration: Integration,
    posts: Post[],
    allowPending: boolean
  ) {
    // kept only for in-flight postWorkflowV108 runs, which set a
    // heartbeatTimeout on this activity - removing the sender would kill
    // them. Under V109+ (no heartbeatTimeout) this is a no-op and can be
    // dropped once all V108 executions have drained
    return withHeartbeat(() =>
      this.handleDisconnect(integration, () =>
        this.postSocialBody(integration, posts, allowPending)
      )
    );
  }

  private async postSocialBody(
    integration: Integration,
    posts: Post[],
    allowPending: boolean
  ) {
    integration = this.withDecryptedToken(integration);

    // Stage markers: whatever ran last is what a timed-out activity reports.
    // Providers that go through this.fetch overwrite these with the exact URL;
    // the ones on their own HTTP client (x, youtube, bluesky) are still
    // narrowed down to the step they hung on.
    setHeartbeatDetails('subscription lookup');
    if (process.env.STRIPE_SECRET_KEY) {
      const subscription = await this._subscriptionService.getSubscription(
        integration.organizationId
      );

      if (!subscription) {
        throw new Error('No active subscription found for this organization.');
      }
    }

    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    setHeartbeatDetails('update tags');
    const newPosts = await this._postService.updateTags(
      integration.organizationId,
      posts
    );

    setHeartbeatDetails('resolve media');
    const mappedPosts = await Promise.all(
      (newPosts || []).map(async (p) => ({
        id: p.id,
        message: stripHtmlValidation(
          getIntegration.editor,
          p.content,
          true,
          false,
          !/<\/?[a-z][\s\S]*>/i.test(p.content),
          getIntegration.mentionFormat,
          !!getIntegration.inlineImages?.(JSON.parse(p.settings || '{}'))
        ),
        settings: JSON.parse(p.settings || '{}'),
        media: await this._postService.updateMedia(
          p.id,
          JSON.parse(p.image || '[]'),
          getIntegration?.convertToJPEG || false
        ),
      }))
    );

    setHeartbeatDetails(`${integration.providerIdentifier}: publish`);
    const postNow =
      allowPending && getIntegration.postPending
        ? await getIntegration.postPending(
            integration.internalId,
            integration.token,
            mappedPosts,
            integration
          )
        : await getIntegration.post(
            integration.internalId,
            integration.token,
            mappedPosts,
            integration
          );

    // The post is already published at this point: the streak is best-effort,
    // failing the activity here would retry it and publish again.
    setHeartbeatDetails(`${integration.providerIdentifier}: published, streak`);
    try {
      await this.startStreak(integration.organizationId);
    } catch (err) {
      /**empty**/
    }

    return postNow;
  }

  private withDecryptedToken(integration: Integration): Integration {
    return {
      ...integration,
      token: decryptIntegrationToken(this._encryption, integration.token),
    };
  }

  private async loadRuntimeIntegration(
    organizationId: string,
    integrationId: string
  ): Promise<Integration> {
    return this.withDecryptedToken(
      await this.loadIntegration(organizationId, integrationId)
    );
  }

  private async loadIntegration(
    organizationId: string,
    integrationId: string
  ): Promise<Integration> {
    const integration = await this._integrationService.getIntegrationById(
      organizationId,
      integrationId
    );
    if (!integration) {
      throw new Error('Integration not found');
    }
    return integration;
  }

  private sanitizePostForWorkflow(post: any) {
    const safePost: any = { ...post };
    delete safePost.error;
    delete safePost.childrenPost;
    if (!post.integration) {
      return safePost;
    }
    const integration = post.integration;
    return {
      ...safePost,
      integration: {
        id: integration.id,
        organizationId: integration.organizationId,
        profileId: integration.profileId,
        providerIdentifier: integration.providerIdentifier,
        name: integration.name,
        disabled: integration.disabled,
        refreshNeeded: integration.refreshNeeded,
      },
    };
  }

  private mapPosts(getIntegration: any, posts: Post[]) {
    return Promise.all(
      posts.map(async (post) => ({
        id: post.id,
        message: stripHtmlValidation(
          getIntegration.editor,
          post.content,
          true,
          false,
          !/<\/?[a-z][\s\S]*>/i.test(post.content),
          getIntegration.mentionFormat
        ),
        settings: JSON.parse(post.settings || '{}'),
        media: await this._postService.updateMedia(
          post.id,
          JSON.parse(post.image || '[]'),
          getIntegration?.convertToJPEG || false
        ),
      }))
    );
  }

  private validatePendingCheckResponse(
    response: PendingCheckResponse
  ): PendingCheckResponse {
    return response.status === 'completed'
      ? response
      : {
          ...response,
          pendingData: assertSafePendingData(response.pendingData),
        };
  }

  private startStreak(organizationIdValue: string) {
    return this._temporalService.client
      .getRawClient()
      .workflow.start('streakWorkflowV2', {
        args: [{ organizationId: organizationIdValue }],
        workflowId: `streak_${organizationIdValue}`,
        taskQueue: 'main',
        // Keep a running streak, it checks for newer posts before it ends
        workflowIdConflictPolicy: 'USE_EXISTING',
        typedSearchAttributes: new TypedSearchAttributes([
          {
            key: organizationId,
            value: organizationIdValue,
          },
        ]),
      });
  }

  @ActivityMethod()
  async checkPostStatus(integration: Integration, pendingData: any) {
    const runtimeIntegration = this.withDecryptedToken(integration);
    const getIntegration = this._integrationManager.getSocialIntegration(
      runtimeIntegration.providerIdentifier
    );

    return this.handleDisconnect(integration, () =>
      getIntegration.checkPostStatus(
        runtimeIntegration.token,
        pendingData,
        runtimeIntegration
      )
    );
  }

  @ActivityMethod()
  async finalizePost(integration: Integration, pendingData: any) {
    const runtimeIntegration = this.withDecryptedToken(integration);
    const getIntegration = this._integrationManager.getSocialIntegration(
      runtimeIntegration.providerIdentifier
    );

    return withHeartbeat(() =>
      this.handleDisconnect(integration, () =>
        getIntegration.finalizePost(
          runtimeIntegration.token,
          pendingData,
          runtimeIntegration
        )
      )
    );
  }

  @ActivityMethod()
  async checkPostStatusV113(
    organizationId: string,
    integrationId: string,
    pendingData: unknown
  ): Promise<PendingCheckResponse> {
    const runtimeIntegration = await this.loadRuntimeIntegration(
      organizationId,
      integrationId
    );
    const provider = this._integrationManager.getSocialIntegration(
      runtimeIntegration.providerIdentifier
    );
    if (!provider.checkPostStatus) {
      throw new Error('Provider does not implement checkPostStatus');
    }

    const result = await provider.checkPostStatus(
      runtimeIntegration.token,
      assertSafePendingData(pendingData),
      runtimeIntegration
    );
    return this.validatePendingCheckResponse(result);
  }

  @ActivityMethod()
  async finalizePostV113(
    organizationId: string,
    integrationId: string,
    pendingData: unknown
  ): Promise<PendingCheckResponse> {
    return withHeartbeat(async () => {
      const runtimeIntegration = await this.loadRuntimeIntegration(
        organizationId,
        integrationId
      );
      const provider = this._integrationManager.getSocialIntegration(
        runtimeIntegration.providerIdentifier
      );
      if (!provider.finalizePost) {
        throw new Error('Provider does not implement finalizePost');
      }

      setHeartbeatDetails(`${runtimeIntegration.providerIdentifier}: finalize`);
      const result = await provider.finalizePost(
        runtimeIntegration.token,
        assertSafePendingData(pendingData),
        runtimeIntegration
      );
      return this.validatePendingCheckResponse(result);
    });
  }

  // Accepts the i18n payload (key + params) used by the profile-aware
  // workflows, and the legacy (subject, message) strings that the upstream
  // workflow versions still send; their activity arguments are frozen. A
  // legacy text goes through as its own key, which the catalog renders as is.
  async inAppNotification(
    orgId: string,
    payload: NotificationPayload,
    sendEmail?: boolean,
    digest?: boolean,
    type?: NotificationType
  ): Promise<void>;
  async inAppNotification(
    orgId: string,
    subject: string,
    message: string,
    sendEmail?: boolean,
    digest?: boolean,
    type?: NotificationType
  ): Promise<void>;
  @ActivityMethod()
  async inAppNotification(
    orgId: string,
    payloadOrSubject: NotificationPayload | string,
    ...rest: any[]
  ): Promise<void> {
    if (typeof payloadOrSubject === 'string') {
      const [message, sendEmail = false, digest = false, type = 'success'] =
        rest;
      await this._notificationService.inAppNotification(
        orgId,
        { subjectKey: payloadOrSubject, messageKey: message },
        sendEmail,
        digest,
        type
      );
      return;
    }

    const [sendEmail = false, digest = false, type = 'success'] = rest;
    await this._notificationService.inAppNotification(
      orgId,
      payloadOrSubject,
      sendEmail,
      digest,
      type
    );
  }

  @ActivityMethod()
  async globalPlugs(integration: Integration) {
    return this._postService.checkPlugs(
      integration.organizationId,
      integration.providerIdentifier,
      integration.id
    );
  }

  @ActivityMethod()
  async globalPlugsForWorkflow(organizationId: string, integrationId: string) {
    return this.globalPlugs(
      await this.loadIntegration(organizationId, integrationId)
    );
  }

  @ActivityMethod()
  async changeState(id: string, state: State, err?: any, body?: any) {
    await this._postService.changeState(id, state, err, body);
  }

  @ActivityMethod()
  async internalPlugs(integration: Integration, settings: any) {
    return this._postService.checkInternalPlug(
      integration,
      integration.organizationId,
      integration.id,
      settings
    );
  }

  @ActivityMethod()
  async internalPlugsForWorkflow(
    organizationId: string,
    integrationId: string,
    settings: any
  ) {
    return this.internalPlugs(
      await this.loadIntegration(organizationId, integrationId),
      settings
    );
  }

  @ActivityMethod()
  async sendWebhooks(postId: string, orgId: string, integrationId: string) {
    // Webhooks are best-effort and run after the post already published, so a
    // failure here must not fail the workflow.
    try {
      const webhooks = (await this._webhookService.getWebhooks(orgId)).filter(
        (f) => {
          return (
            f.integrations.length === 0 ||
            f.integrations.some((i) => i.integration.id === integrationId)
          );
        }
      );

      if (webhooks.length === 0) {
        return;
      }

      const post = await this._postService.getPostByForWebhookId(
        postId,
        integrationId
      );
      await Promise.all(
        webhooks.map(async (webhook) => {
          try {
            // webhook.url is validated at save time, but DNS can change
            // between then and now - pin resolution like every other
            // user-influenced outbound request.
            await fetch(webhook.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(post),
              // @ts-ignore — undici option, not in lib.dom fetch types
              dispatcher: getSsrfSafeDispatcher(),
            });
          } catch (e) {
            /**empty**/
          }
        })
      );
    } catch (err) {
      /**empty**/
    }
  }
  @ActivityMethod()
  async processPlug(data: {
    plugId: string;
    postId: string;
    delay: number;
    totalRuns: number;
    currentRun: number;
  }) {
    return this._integrationService.processPlugs(data);
  }

  @ActivityMethod()
  async processInternalPlug(data: {
    post: string;
    originalIntegration: string;
    integration: string;
    plugName: string;
    orgId: string;
    delay: number;
    information: any;
  }) {
    await this._integrationService.processInternalPlug(data);
  }

  @ActivityMethod()
  async refreshToken(
    integration: Integration
  ): Promise<false | AuthTokenDetails> {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    try {
      const refresh = await this._refreshIntegrationService.refresh(
        integration
      );
      if (!refresh) {
        return false;
      }

      if (getIntegration.refreshWait) {
        await timer(10000);
      }

      return refresh;
    } catch (err) {
      await this._refreshIntegrationService.setBetweenSteps(
        integration,
        (err as Error)?.message || ''
      );
      return false;
    }
  }

  @ActivityMethod()
  async refreshTokenWithCause(
    integration: Integration,
    cause: string
  ): Promise<false | AuthTokenDetails> {
    const getIntegration = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    try {
      const refresh = await this._refreshIntegrationService.refresh(
        integration,
        cause
      );
      if (!refresh) {
        return false;
      }

      if (getIntegration.refreshWait) {
        await timer(10000);
      }

      return refresh;
    } catch (err) {
      await this._refreshIntegrationService.setBetweenSteps(
        integration,
        cause || (err as Error)?.message || ''
      );
      return false;
    }
  }

  @ActivityMethod()
  async refreshTokenForWorkflow(
    organizationId: string,
    integrationId: string,
    cause: string
  ): Promise<boolean> {
    let integration: Integration;
    try {
      integration = await this.loadIntegration(organizationId, integrationId);
    } catch {
      return false;
    }
    return !!(await this.refreshTokenWithCause(integration, cause));
  }
}
