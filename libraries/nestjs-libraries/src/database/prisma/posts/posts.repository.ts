import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { Post as PostBody } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import {
  APPROVED_SUBMIT_FOR_ORDER,
  CommentKind,
  CreationMethod,
  Post,
  State,
} from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.list.dto';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import utc from 'dayjs/plugin/utc';
import { v4 as uuidv4 } from 'uuid';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';

dayjs.extend(isoWeek);
dayjs.extend(weekOfYear);
dayjs.extend(isSameOrAfter);
dayjs.extend(utc);

@Injectable()
export class PostsRepository {
  constructor(
    private _post: PrismaRepository<'post'>,
    private _popularPosts: PrismaRepository<'popularPosts'>,
    private _comments: PrismaRepository<'comments'>,
    private _tags: PrismaRepository<'tags'>,
    private _tagsPosts: PrismaRepository<'tagsPosts'>,
    private _errors: PrismaRepository<'errors'>
  ) {}

  searchForMissingThreeHoursPosts() {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
          deletedAt: null,
        },
        publishDate: {
          gte: dayjs.utc().subtract(2, 'day').toDate(),
          lt: dayjs.utc().toDate(),
        },
        state: 'QUEUE',
        deletedAt: null,
        parentPostId: null,
        OR: [{ profileId: null }, { profile: { deletedAt: null } }],
      },
      select: {
        id: true,
        organizationId: true,
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
          },
        },
        publishDate: true,
      },
    });
  }

  /**
   * Posts que falharam ao publicar (state=ERROR) nos ultimos 30 dias, para a
   * tela de Status. Escopado por org; `profileId` opcional (drill-down futuro).
   * Traz canal + perfil de origem embutidos. Limite defensivo: um unico canal
   * caido gera muitos erros, entao capamos e ordenamos pelos mais recentes.
   */
  getErrorPosts(orgId: string, profileId?: string, limit = 50) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        parentPostId: null,
        state: 'ERROR',
        OR: [{ profileId: null }, { profile: { deletedAt: null } }],
        updatedAt: { gte: dayjs.utc().subtract(30, 'day').toDate() },
        ...(profileId ? { profileId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: {
        // NAO selecionar `error`: Post.error e uma serializacao completa da
        // excecao e pode conter refresh_token/client_secret (details[].body de
        // RefreshToken/BadBody). A tela de Status so precisa da contagem por canal.
        id: true,
        updatedAt: true,
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            internalId: true,
            name: true,
            picture: true,
          },
        },
        profile: {
          select: { id: true, name: true },
        },
      },
    });
  }

  getOldPosts(orgId: string, date: string) {
    return this._post.model.post.findMany({
      where: {
        integration: {
          refreshNeeded: false,
          inBetweenSteps: false,
          disabled: false,
        },
        organizationId: orgId,
        publishDate: {
          lte: dayjs(date).toDate(),
        },
        deletedAt: null,
        parentPostId: null,
      },
      orderBy: {
        publishDate: 'desc',
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }

  updateImages(id: string, images: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        image: images,
      },
    });
  }

  getPostUrls(orgId: string, ids: string[]) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        id: {
          in: ids,
        },
      },
      select: {
        id: true,
        releaseURL: true,
      },
    });
  }

  // Post.error persists the raw serialized workflow failure; only curated
  // provider messages are surfaced to the calendar and the public API —
  // bad_body failures whose message came from a provider handleErrors
  // mapping or a hand-written provider throw (unmapped API responses carry
  // the 'Unknown Error' placeholder instead). Internal debug strings (e.g.
  // 'Refresh channel needed') and unmapped failures come out as null.
  private curatedError(error?: string | null): string | null {
    if (!error) {
      return null;
    }
    try {
      const parsed = JSON.parse(error);
      const [type, message] = parsed?.cause?.failure?.message
        ? [parsed?.cause?.type, parsed?.cause?.failure?.message]
        : [
            parsed?.failure?.cause?.applicationFailureInfo?.type,
            parsed?.failure?.cause?.message,
          ];
      return type === 'bad_body' && message && message !== 'Unknown Error'
        ? message
        : null;
    } catch (err) {
      return null;
    }
  }

  async getPosts(orgId: string, query: GetPostsDto, profileId?: string) {
    // Use the provided start and end dates directly
    const startDate = dayjs.utc(query.startDate).toDate();
    const endDate = dayjs.utc(query.endDate).toDate();

    const list = await this._post.model.post.findMany({
      where: {
        AND: [
          {
            OR: [
              {
                organizationId: orgId,
              },
            ],
          },
          ...(profileId ? [{ profileId }] : []),
          {
            OR: [
              {
                publishDate: {
                  gte: startDate,
                  lte: endDate,
                },
              },
              {
                intervalInDays: {
                  not: null,
                },
              },
            ],
          },
        ],
        integration: {
          deletedAt: null,
          organizationId: orgId,
          ...(query.customer ? { customerId: query.customer } : {}),
        },
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        releaseId: true,
        state: true,
        error: true,
        intervalInDays: true,
        group: true,
        creationMethod: true,
        settings: true,
        tags: {
          where: {
            tag: {
              deletedAt: null,
            },
          },
          select: {
            tag: true,
          },
        },
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
            name: true,
            picture: true,
          },
        },
        // Ultima acao de revisao do cliente (aprovar/pedir alteracao) — para o
        // selo de status no calendario. Leve: so o registro mais recente.
        comments: {
          where: {
            kind: { in: ['APPROVAL', 'CHANGE_REQUEST'] },
            deletedAt: null,
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { kind: true, createdAt: true },
        },
      },
    });

    return list
      .map((post) => ({ ...post, error: this.curatedError(post.error) }))
      .reduce((all, post) => {
      if (!post.intervalInDays) {
        return [...all, post];
      }

      const addMorePosts = [];
      let startingDate = dayjs.utc(post.publishDate);
      while (dayjs.utc(endDate).isSameOrAfter(startingDate)) {
        if (dayjs(startingDate).isSameOrAfter(dayjs.utc(post.publishDate))) {
          addMorePosts.push({
            ...post,
            publishDate: startingDate.toDate(),
            actualDate: post.publishDate,
          });
        }

        startingDate = startingDate.add(post.intervalInDays, 'days');
      }

      return [...all, ...addMorePosts];
    }, [] as any[]);
  }

  async getPostsList(orgId: string, query: GetPostsListDto, profileId?: string) {
    const page = query.page || 0;
    const limit = query.limit || 20;
    const skip = page * limit;

    const stateFilter = query.state || 'all';
    const stateAndDate =
      stateFilter === 'scheduled'
        ? {
            state: State.QUEUE,
          }
        : stateFilter === 'draft'
        ? { state: State.DRAFT }
        : stateFilter === 'published'
        ? { state: State.PUBLISHED }
        : {
            state: {
              in: [State.QUEUE, State.DRAFT, State.PUBLISHED, State.ERROR],
            },
          };

    const orderDirection: 'asc' | 'desc' =
      stateFilter === 'published' ? 'desc' : 'asc';

    const where = {
      AND: [
        {
          OR: [
            {
              organizationId: orgId,
            },
          ],
        },
        ...(profileId ? [{ profileId }] : []),
      ],
      ...stateAndDate,
      // Published posts were already posted (publishDate in the past), so fetch
      // all of them; everything else stays upcoming. Ordering handles the rest.
      ...(stateFilter === 'published'
        ? {}
        : { publishDate: { gte: dayjs.utc().toDate() } }),
      deletedAt: null as Date | null,
      parentPostId: null as string | null,
      intervalInDays: null as number | null,

      integration: {
        deletedAt: null as any,
        organizationId: orgId,
        ...(query.customer
          ? {
              customerId: query.customer,
            }
          : {}),
        ...(query.integrations
          ? {
              id: { in: query.integrations },
            }
          : {}),
      },
    };

    const [posts, total] = await Promise.all([
      this._post.model.post.findMany({
        where,
        skip,
        take: limit,
        orderBy: {
          publishDate: orderDirection,
        },
        select: {
          id: true,
          content: true,
          publishDate: true,
          releaseURL: true,
          releaseId: true,
          state: true,
          intervalInDays: true,
          group: true,
          creationMethod: true,
          tags: {
            where: {
              tag: {
                deletedAt: null,
              },
            },
            select: {
              tag: true,
            },
          },
          integration: {
            select: {
              id: true,
              providerIdentifier: true,
              name: true,
              picture: true,
            },
          },
        },
      }),
      this._post.model.post.count({ where }),
    ]);

    return {
      posts,
      total,
      page,
      limit,
      hasMore: skip + posts.length < total,
    };
  }

  async deletePost(orgId: string, group: string, profileId?: string) {
    await this._post.model.post.updateMany({
      where: {
        organizationId: orgId,
        group,
        ...(profileId ? { profileId } : {}),
      },
      data: {
        deletedAt: new Date(),
      },
    });

    return this._post.model.post.findFirst({
      where: {
        organizationId: orgId,
        group,
        parentPostId: null,
      },
      select: {
        id: true,
      },
    });
  }

  getPostsByGroup(orgId: string, group: string) {
    return this._post.model.post.findMany({
      where: {
        group,
        ...(orgId ? { organizationId: orgId } : {}),
        deletedAt: null,
      },
      include: {
        integration: true,
        tags: {
          where: {
            tag: {
              deletedAt: null,
            },
          },
          select: {
            tag: true,
          },
        },
      },
    });
  }

  // the posts of the other channels in the batch, without the given group
  getPostsByBatch(orgId: string, batchId: string, exceptGroup: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        batchId,
        group: {
          not: exceptGroup,
        },
        deletedAt: null,
        integration: {
          deletedAt: null,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  getPost(
    id: string,
    includeIntegration = false,
    orgId?: string,
    isFirst?: boolean
  ) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(orgId ? { organizationId: orgId } : {}),
        deletedAt: null,
        ...(isFirst
          ? { OR: [{ profileId: null }, { profile: { deletedAt: null } }] }
          : {}),
      },
      include: {
        ...(includeIntegration
          ? {
              integration: true,
              tags: {
                where: {
                  tag: {
                    deletedAt: null,
                  },
                },
                select: {
                  tag: true,
                },
              },
            }
          : {}),
        childrenPost: true,
      },
    });
  }

  updatePost(id: string, postId: string, releaseURL: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state: 'PUBLISHED',
        releaseURL,
        releaseId: postId,
        error: null,
      },
    });
  }

  updateReleaseId(
    id: string,
    orgId: string,
    releaseId: string,
    releaseURL?: string
  ) {
    return this._post.model.post.update({
      where: {
        id,
        organizationId: orgId,
        releaseId: 'missing',
      },
      data: {
        releaseId: String(releaseId),
        ...(releaseURL ? { releaseURL } : {}),
      },
    });
  }

  updateResolvedRelease(
    id: string,
    orgId: string,
    releaseId: string,
    releaseURL: string
  ) {
    return this._post.model.post.update({
      where: {
        id,
        organizationId: orgId,
      },
      data: {
        releaseId,
        releaseURL,
      },
    });
  }

  async changeState(id: string, state: State, err?: any, body?: any) {
    const update = await this._post.model.post.update({
      where: {
        id,
      },
      data: {
        state,
        ...(err
          ? { error: typeof err === 'string' ? err : JSON.stringify(err) }
          : {}),
      },
      include: {
        integration: {
          select: {
            providerIdentifier: true,
            // name/picture alimentam o snapshot do StatusEvent (POST_FAILED) —
            // emitido pelo PostsService a partir deste retorno, sem query extra.
            name: true,
            picture: true,
          },
        },
      },
    });

    if (state === 'ERROR' && err && body) {
      try {
        await this._errors.model.errors.create({
          data: {
            message: typeof err === 'string' ? err : JSON.stringify(err),
            organizationId: update.organizationId,
            platform: update.integration.providerIdentifier,
            postId: update.id,
            body: typeof body === 'string' ? body : JSON.stringify(body),
          },
        });
      } catch (err) {}
    }

    return update;
  }

  getErrorsByPostIds(postIds: string[]) {
    return this._errors.model.errors.findMany({
      where: {
        postId: { in: postIds },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async changeDate(
    orgId: string,
    id: string,
    date: string,
    isDraft: boolean,
    action: 'schedule' | 'update' = 'schedule'
  ) {
    return this._post.model.post.update({
      where: {
        organizationId: orgId,
        id,
      },
      data: {
        publishDate: dayjs(date).toDate(),
        // schedule: set state to QUEUE (or DRAFT if it was a draft)
        // update: don't change the state
        ...(action === 'schedule'
          ? {
              state: isDraft ? 'DRAFT' : 'QUEUE',
              releaseId: null,
              releaseURL: null,
              error: null,
            }
          : {}),
      },
    });
  }

  countPostsFromDay(orgId: string, date: Date) {
    return this._post.model.post.count({
      where: {
        organizationId: orgId,
        publishDate: {
          gte: date,
        },
        OR: [
          {
            deletedAt: null,
            state: {
              in: ['QUEUE'],
            },
          },
          {
            state: 'PUBLISHED',
          },
        ],
      },
    });
  }

  async createOrUpdatePost(
    state: 'draft' | 'schedule' | 'now' | 'update',
    orgId: string,
    date: string,
    body: PostBody,
    tags: { value: string; label: string }[],
    creationMethod: CreationMethod,
    inter?: number,
    // Keep the existing group instead of rotating it, so open clients
    // (calendar) holding the group stay valid. Used by out-of-band updates
    // (agent / MCP / public API); the dashboard keeps the rotate-and-sweep.
    keepGroup = false,
    // Shared by the posts saved together for several channels, so opening one
    // of them in the editor brings the others.
    batchId?: string,
    profileId?: string
  ) {
    const posts: Post[] = [];
    const uuid = uuidv4();
    const group = keepGroup && body.group ? body.group : uuid;

    // an edited post stays in the batch it was created in, even when it is
    // saved on its own or with a group that was rotated since
    const ids = body.value.map((value) => value.id).filter(Boolean);
    const existingBatchId =
      body.group || ids.length
        ? (
            await this._post.model.post.findFirst({
              where: {
                organizationId: orgId,
                deletedAt: null,
                batchId: {
                  not: null,
                },
                OR: [
                  ...(body.group ? [{ group: body.group }] : []),
                  ...(ids.length ? [{ id: { in: ids } }] : []),
                ],
              },
              select: {
                batchId: true,
              },
            })
          )?.batchId
        : undefined;

    for (const value of body.value) {
      const updateData = (type: 'create' | 'update') => ({
        publishDate: dayjs(date).toDate(),
        integration: {
          connect: {
            id: body.integration.id,
            organizationId: orgId,
          },
        },
        ...(posts?.[posts.length - 1]?.id
          ? {
              parentPost: {
                connect: {
                  id: posts[posts.length - 1]?.id,
                },
              },
            }
          : type === 'update'
          ? {
              parentPost: {
                disconnect: true,
              },
            }
          : {}),
        content: value.content,
        delay: value.delay || 0,
        group,
        batchId: existingBatchId || batchId,
        intervalInDays: inter ? +inter : null,
        approvedSubmitForOrder: APPROVED_SUBMIT_FOR_ORDER.NO,
        ...(type === 'create' ? { creationMethod } : {}),
        ...(state === 'update'
          ? {}
          : {
              state:
                state === 'draft' ? ('DRAFT' as const) : ('QUEUE' as const),
            }),
        image: JSON.stringify(value.image),
        settings: JSON.stringify(body.settings),
        organization: {
          connect: {
            id: orgId,
          },
        },
        ...(profileId ? { profile: { connect: { id: profileId } } } : {}),
      });

      posts.push(
        await this._post.model.post.upsert({
          where: {
            id: value.id || uuidv4(),
          },
          create: { ...updateData('create') },
          update: {
            ...updateData('update'),
            lastMessage: {
              disconnect: true,
            },
            submittedForOrder: {
              disconnect: true,
            },
          },
        })
      );

      if (posts.length === 1) {
        await this._tagsPosts.model.tagsPosts.deleteMany({
          where: {
            post: {
              id: posts[0].id,
            },
          },
        });

        if (tags.length) {
          const tagsList = await this._tags.model.tags.findMany({
            where: {
              orgId: orgId,
              deletedAt: null,
              name: {
                in: tags.map((tag) => tag.label).filter((f) => f),
              },
            },
          });

          if (tagsList.length) {
            await this._post.model.post.update({
              where: {
                id: posts[posts.length - 1].id,
              },
              data: {
                tags: {
                  createMany: {
                    data: tagsList.map((tag) => ({
                      tagId: tag.id,
                    })),
                  },
                },
              },
            });
          }
        }
      }
    }

    const previousPost = body.group
      ? (
          await this._post.model.post.findFirst({
            where: {
              group: body.group,
              deletedAt: null,
              parentPostId: null,
            },
            select: {
              id: true,
            },
          })
        )?.id!
      : undefined;

    if (body.group && !keepGroup) {
      await this._post.model.post.updateMany({
        where: {
          group: body.group,
          deletedAt: null,
        },
        data: {
          parentPostId: null,
          deletedAt: new Date(),
        },
      });
    }

    // keepGroup: the updated rows still carry the old group, so sweep only the
    // rows dropped from it (removed comments) by id instead of by group.
    if (body.group && keepGroup) {
      await this._post.model.post.updateMany({
        where: {
          group: body.group,
          deletedAt: null,
          id: {
            notIn: posts.map((p) => p.id),
          },
        },
        data: {
          parentPostId: null,
          deletedAt: new Date(),
        },
      });
    }

    return { previousPost, posts };
  }

  async submit(id: string, order: string, buyerOrganizationId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        submittedForOrderId: order,
        approvedSubmitForOrder: 'WAITING_CONFIRMATION',
        submittedForOrganizationId: buyerOrganizationId,
      },
      select: {
        id: true,
        description: true,
        submittedForOrder: {
          select: {
            messageGroupId: true,
          },
        },
      },
    });
  }

  updateMessage(id: string, messageId: string) {
    return this._post.model.post.update({
      where: {
        id,
      },
      data: {
        lastMessageId: messageId,
      },
    });
  }

  getPostById(id: string, org?: string) {
    return this._post.model.post.findUnique({
      where: {
        id,
        ...(org ? { organizationId: org } : {}),
      },
      include: {
        integration: true,
        submittedForOrder: {
          include: {
            posts: {
              where: {
                state: 'PUBLISHED',
              },
            },
            ordersItems: true,
            seller: {
              select: {
                id: true,
                account: true,
              },
            },
          },
        },
      },
    });
  }

  private get postTimelineSelect() {
    return {
      id: true,
      state: true,
      publishDate: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      releaseId: true,
      releaseURL: true,
      error: true,
      creationMethod: true,
      group: true,
      parentPostId: true,
    } as const;
  }

  getPostTimeline(id: string, org: string) {
    return this._post.model.post.findFirst({
      where: {
        id,
        organizationId: org,
      },
      select: {
        ...this.postTimelineSelect,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            disabled: true,
            refreshNeeded: true,
            deletedAt: true,
          },
        },
        childrenPost: {
          select: this.postTimelineSelect,
          orderBy: { publishDate: 'asc' as const },
        },
        errors: {
          select: {
            id: true,
            platform: true,
            message: true,
            body: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' as const },
        },
      },
    });
  }

  findAllExistingCategories() {
    return this._popularPosts.model.popularPosts.findMany({
      select: {
        category: true,
      },
      distinct: ['category'],
    });
  }

  findAllExistingTopicsOfCategory(category: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
      },
      select: {
        topic: true,
      },
      distinct: ['topic'],
    });
  }

  findPopularPosts(category: string, topic?: string) {
    return this._popularPosts.model.popularPosts.findMany({
      where: {
        category,
        ...(topic ? { topic } : {}),
      },
      select: {
        content: true,
        hook: true,
      },
    });
  }

  createPopularPosts(post: {
    category: string;
    topic: string;
    content: string;
    hook: string;
  }) {
    return this._popularPosts.model.popularPosts.create({
      data: {
        category: 'category',
        topic: 'topic',
        content: 'content',
        hook: 'hook',
      },
    });
  }

  async getPostsCountsByDates(
    orgId: string,
    times: number[],
    date: dayjs.Dayjs,
    profileId?: string
  ) {
    const dates = await this._post.model.post.findMany({
      where: {
        deletedAt: null,
        organizationId: orgId,
        ...(profileId ? { profileId } : {}),
        publishDate: {
          in: times.map((time) => {
            return date.clone().add(time, 'minutes').toDate();
          }),
        },
      },
    });

    return times.filter(
      (time) =>
        date.clone().add(time, 'minutes').isAfter(dayjs.utc()) &&
        !dates.find((dateFind) => {
          return (
            dayjs
              .utc(dateFind.publishDate)
              .diff(date.clone().startOf('day'), 'minutes') == time
          );
        })
    );
  }

  getCommentsForPosts(postIds: string[]) {
    return this._comments.model.comments.findMany({
      where: {
        postId: {
          in: postIds,
        },
        deletedAt: null,
      },
      include: {
        user: {
          select: {
            name: true,
            lastName: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  getCommentById(id: string) {
    return this._comments.model.comments.findFirst({
      where: {
        id,
        deletedAt: null,
      },
      include: {
        post: {
          select: {
            id: true,
            organizationId: true,
          },
        },
      },
    });
  }

  setCommentResolved(id: string, resolvedAt: Date | null) {
    return this._comments.model.comments.update({
      where: {
        id,
      },
      data: {
        resolvedAt,
      },
    });
  }

  getAnchoredCommentsForPost(postId: string) {
    return this._comments.model.comments.findMany({
      where: {
        postId,
        deletedAt: null,
        anchorStart: {
          not: null,
        },
      },
    });
  }

  detachAnchorsForPost(postId: string, ids: string[]) {
    return this._comments.model.comments.updateMany({
      where: {
        postId,
        id: {
          in: ids,
        },
      },
      data: {
        anchorStart: null,
        anchorEnd: null,
      },
    });
  }

  async getComments(postId: string, orgId?: string) {
    return this._comments.model.comments.findMany({
      where: {
        postId,
        ...(orgId ? { organizationId: orgId } : {}),
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'asc',
      },
      select: {
        id: true,
        content: true,
        userId: true,
        guestName: true,
        kind: true,
        createdAt: true,
        displayName: true,
        parentId: true,
        anchorStart: true,
        anchorEnd: true,
        anchorQuote: true,
        resolvedAt: true,
        // Identidade do autor só no caminho autenticado (orgId presente). O
        // endpoint publico/guest (sem orgId) NAO expoe e-mail/nome da equipe.
        ...(orgId ? { user: { select: { email: true, name: true } } } : {}),
      },
    });
  }

  // profileId do post — usado para escopar acoes de revisao ao perfil do
  // membro (um VIEWER de Dell so revisa posts do Dell).
  async getPostProfileScope(orgId: string, postId: string) {
    return this._post.model.post.findFirst({
      where: { id: postId, organizationId: orgId, deletedAt: null },
      select: { id: true, profileId: true },
    });
  }

  async getTags(orgId: string, profileId?: string) {
    return this._tags.model.tags.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(profileId ? { profileId } : {}),
      },
    });
  }

  createTag(orgId: string, body: CreateTagDto, profileId?: string) {
    return this._tags.model.tags.create({
      data: {
        orgId,
        name: body.name,
        color: body.color,
        ...(profileId ? { profileId } : {}),
      },
    });
  }

  editTag(id: string, orgId: string, body: CreateTagDto, profileId?: string) {
    return this._tags.model.tags.update({
      where: {
        id,
        orgId,
        ...(profileId ? { profileId } : {}),
      },
      data: {
        name: body.name,
        color: body.color,
      },
    });
  }

  async deleteTag(id: string, orgId: string, profileId?: string) {
    const tag = await this._tags.model.tags.update({
      where: {
        id,
        orgId,
        ...(profileId ? { profileId } : {}),
      },
      data: {
        deletedAt: new Date(),
      },
    });

    await this._tagsPosts.model.tagsPosts.deleteMany({
      where: {
        tagId: tag.id,
      },
    });

    return tag;
  }

  createComment(
    orgId: string,
    userId: string | null,
    postId: string,
    content: string,
    kind: CommentKind = 'COMMENT',
    extra: {
      displayName?: string;
      parentId?: string;
      anchorStart?: number;
      anchorEnd?: number;
      anchorQuote?: string;
    } = {}
  ) {
    return this._comments.model.comments.create({
      data: {
        organizationId: orgId,
        userId,
        postId,
        content,
        kind,
        displayName: extra.displayName ?? null,
        parentId: extra.parentId ?? null,
        anchorStart: extra.anchorStart ?? null,
        anchorEnd: extra.anchorEnd ?? null,
        anchorQuote: extra.anchorQuote ?? null,
      },
    });
  }

  async getPostByForWebhookId(postId: string, integrationId: string) {
    const select = {
      id: true,
      content: true,
      publishDate: true,
      releaseURL: true,
      state: true,
      integration: {
        select: {
          id: true,
          name: true,
          providerIdentifier: true,
          picture: true,
          type: true,
        },
      },
    };

    const posts = await this._post.model.post.findMany({
      where: {
        id: postId,
        deletedAt: null,
        parentPostId: null,
      },
      select,
    });

    if (posts.length) {
      return posts;
    }

    // The running workflows pass the platform's post id, which updatePost
    // already stored on the row as releaseId before the webhook is sent.
    return this._post.model.post.findMany({
      where: {
        releaseId: postId,
        integrationId,
        deletedAt: null,
        parentPostId: null,
      },
      orderBy: {
        updatedAt: 'desc' as const,
      },
      take: 1,
      select,
    });
  }

  async getPostsSince(orgId: string, since: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        publishDate: {
          gte: new Date(since),
        },
        deletedAt: null,
        parentPostId: null,
      },
      select: {
        id: true,
        content: true,
        publishDate: true,
        releaseURL: true,
        state: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
            picture: true,
            type: true,
          },
        },
      },
    });
  }
}
