import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import dayjs from 'dayjs';
import { Integration, Prisma } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { IntegrationTimeDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@gitroom/nestjs-libraries/dtos/plugs/plug.dto';
import { EncryptionService } from '@gitroom/nestjs-libraries/crypto/encryption.service';
import { encryptIntegrationToken } from '@gitroom/nestjs-libraries/crypto/integration-token.helper';

@Injectable()
export class IntegrationRepository {
  private storage = UploadFactory.createStorage();
  constructor(
    private _integration: PrismaRepository<'integration'>,
    private _posts: PrismaRepository<'post'>,
    private _plugs: PrismaRepository<'plugs'>,
    private _exisingPlugData: PrismaRepository<'exisingPlugData'>,
    private _customers: PrismaRepository<'customer'>,
    private _mentions: PrismaRepository<'mentions'>,
    private _encryption: EncryptionService
  ) {}

  // B1 Etapa 2: criptografia dos tokens de canal em repouso. LIGADA por padrao
  // (igual as credenciais/chaves de IA, que ja sao cifradas sem config). Sem
  // variavel obrigatoria. Freio de emergencia OPCIONAL: setar
  // DISABLE_INTEGRATION_TOKEN_ENCRYPTION=true faz novas escritas voltarem a
  // texto puro (os ja cifrados seguem sendo lidos pelo prefixo). encrypt e
  // idempotente (token ja prefixado ou vazio volta inalterado); a leitura
  // (Etapa 1) decide por prefixo, entao tokens antigos em texto puro funcionam.
  private get shouldEncryptTokens(): boolean {
    return process.env.DISABLE_INTEGRATION_TOKEN_ENCRYPTION !== 'true';
  }

  getMentions(platform: string, q: string) {
    return this._mentions.model.mentions.findMany({
      where: {
        platform,
        OR: [
          {
            name: {
              contains: q,
              mode: 'insensitive',
            },
          },
          {
            username: {
              contains: q,
              mode: 'insensitive',
            },
          },
        ],
      },
      orderBy: {
        name: 'asc',
      },
      take: 100,
      select: {
        name: true,
        username: true,
        image: true,
      },
    });
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    if (mentions.length === 0) {
      return [] as any[];
    }
    return this._mentions.model.mentions.createMany({
      data: mentions.map((mention) => ({
        platform,
        name: mention.name,
        username: mention.username,
        image: mention.image,
      })),
      skipDuplicates: true,
    });
  }

  async checkPreviousConnections(org: string, id: string) {
    // Deleted accounts keep their integrations with an md5 hashed
    // rootInternalId, so match both the raw id and its hash to still catch
    // channels that were connected by a deleted account.
    const findIt = await this._integration.model.integration.findMany({
      where: {
        rootInternalId: {
          in: [id, createHash('md5').update(id).digest('hex')],
        },
      },
      select: {
        organizationId: true,
        id: true,
      },
    });

    if (findIt.some((f) => f.organizationId === org)) {
      return false;
    }

    return findIt.length > 0;
  }

  updateProviderSettings(org: string, id: string, settings: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        additionalSettings: settings,
      },
    });
  }

  updateCustomName(org: string, id: string, name: string) {
    return this._integration.model.integration.update({
      select: {
        id: true,
      },
      where: {
        id,
        organizationId: org,
      },
      data: {
        customName: name.trim() || null,
      },
    });
  }

  async setTimes(org: string, id: string, times: IntegrationTimeDto) {
    return this._integration.model.integration.update({
      select: {
        id: true,
      },
      where: {
        id,
        organizationId: org,
      },
      data: {
        postingTimes: JSON.stringify(times.time),
      },
    });
  }

  getPlug(plugId: string) {
    return this._plugs.model.plugs.findFirst({
      where: {
        id: plugId,
      },
      include: {
        integration: true,
      },
    });
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._plugs.model.plugs.findMany({
      where: {
        integrationId,
        organizationId: orgId,
        activated: true,
      },
      include: {
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
          },
        },
      },
    });
  }

  async updateIntegration(id: string, params: Partial<Integration>) {
    if (
      params.picture &&
      (params.picture.indexOf(process.env.CLOUDFLARE_BUCKET_URL!) === -1 ||
        params.picture.indexOf(process.env.FRONTEND_URL!) === -1)
    ) {
      try {
        params.picture = await this.storage.uploadSimple(params.picture);
      } catch (err) {
        // Avatar e cosmetico: uma falha de storage (ex.: credencial R2 errada)
        // NAO pode derrubar a selecao de pagina / conexao do canal. Mantem a
        // URL original do provider (publica e utilizavel).
        console.error(
          `[integration] falha ao subir avatar na selecao de pagina (mantendo original): ${
            (err as Error)?.name || 'Error'
          }: ${(err as Error)?.message || 'sem detalhe'}`
        );
      }
    }

    const existing = await this._integration.model.integration.findUnique({
      where: {
        organizationId_internalId: {
          organizationId: params.organizationId!,
          internalId: params.internalId,
        },
      },
    });

    if (existing) {
      await this._posts.model.post.updateMany({
        where: {
          integrationId: id,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      await this._integration.model.integration.update({
        where: {
          id,
        },
        data: {
          internalId: `deleted_${params.internalId}_${makeId(10)}`,
          deletedAt: new Date(),
        },
      });
    }

    // Só cifra valores realmente presentes (string nao-vazia). null/''/undefined
    // passam por `...params` inalterados — evita divergencia on/off (cifrar so
    // faz sentido para um token real; nao marcar tokenEncrypted sem ter cifrado).
    const encryptedTokenFields = this.shouldEncryptTokens
      ? {
          ...(params.token
            ? { token: encryptIntegrationToken(this._encryption, params.token) }
            : {}),
          ...(params.refreshToken
            ? {
                refreshToken: encryptIntegrationToken(
                  this._encryption,
                  params.refreshToken
                ),
              }
            : {}),
          ...(params.token || params.refreshToken
            ? { tokenEncrypted: true }
            : {}),
        }
      : {};

    return this._integration.model.integration.update({
      where: {
        ...(existing ? { id: existing.id } : { id }),
      },
      data: {
        ...params,
        ...encryptedTokenFields,
        disabled: false,
        deletedAt: null,
      },
    });
  }

  setIntegrationProfile(id: string, profileId: string) {
    return this._integration.model.integration.update({
      where: { id },
      data: { profileId },
    });
  }

  /**
   * Marca refreshNeeded=true de forma ATOMICA, apenas na transicao false->true.
   * Retorna true quando de fato transicionou agora (para o service notificar uma
   * unica vez) e false quando o canal ja estava marcado — evitando e-mail/sininho
   * duplicados quando o batch de refresh e o post-time colidem na mesma
   * integration (o filtro no `where` faz o guard sem read-then-write).
   *
   * `reason` (ja sanitizado — name+message, NUNCA o token) e persistido em
   * refreshError/refreshErrorAt na MESMA escrita atomica, para a tela de Status
   * mostrar o "porque" da desconexao.
   */
  async markRefreshNeeded(
    org: string,
    id: string,
    reason?: string
  ): Promise<boolean> {
    const { count } = await this._integration.model.integration.updateMany({
      where: {
        id,
        organizationId: org,
        refreshNeeded: false,
      },
      data: {
        refreshNeeded: true,
        refreshError: reason ?? null,
        refreshErrorAt: new Date(),
      },
    });
    return count > 0;
  }

  getIntegrationByInternalId(org: string, internalId: string) {
    return this._integration.model.integration.findFirst({
      where: {
        organizationId: org,
        internalId,
        deletedAt: null,
      },
    });
  }

  // Moves a channel to another provider in place (MIGRATE_PROVIDERS): only the
  // provider and the app-scoped ids change, so the integration id - and with it
  // scheduled posts, settings and customers - survives the migration. The
  // follow-up createOrUpdateIntegration upsert matches the new internalId and
  // stores the fresh tokens.
  async migrateIntegration(
    org: string,
    id: string,
    internalId: string,
    providerIdentifier: string,
    rootInternalId: string
  ) {
    // A soft-deleted channel can still hold the target internalId
    // (deleteChannel keeps it): rename it out of the way like updateIntegration
    // does, otherwise the organizationId_internalId unique constraint rejects
    // the migration. Live channels are rejected by the service before this.
    const existing = await this._integration.model.integration.findUnique({
      where: {
        organizationId_internalId: {
          organizationId: org,
          internalId,
        },
      },
    });

    if (existing && existing.deletedAt) {
      await this._integration.model.integration.update({
        where: {
          id: existing.id,
        },
        data: {
          internalId: `deleted_${internalId}_${makeId(10)}`,
        },
      });
    }

    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        internalId,
        providerIdentifier,
        rootInternalId,
      },
    });
  }

  async createOrUpdateIntegration(
    additionalSettings:
      | {
          title: string;
          description: string;
          type: 'checkbox' | 'text' | 'textarea';
          value: any;
          regex?: string;
        }[]
      | undefined,
    oneTimeToken: boolean,
    org: string,
    name: string,
    picture: string | undefined,
    type: 'article' | 'social',
    internalId: string,
    provider: string,
    token: string,
    refreshToken = '',
    expiresIn = 999999999,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string,
    profileId?: string
  ) {
    const encToken = this.shouldEncryptTokens
      ? encryptIntegrationToken(this._encryption, token)
      : token;
    const encRefreshToken = this.shouldEncryptTokens
      ? encryptIntegrationToken(this._encryption, refreshToken)
      : refreshToken;
    const tokenEncrypted = this.shouldEncryptTokens;

    const postTimes = timezone
      ? {
          postingTimes: JSON.stringify([
            { time: 560 - timezone },
            { time: 850 - timezone },
            { time: 1140 - timezone },
          ]),
        }
      : {};
    const upsert = await this._integration.model.integration.upsert({
      where: {
        organizationId_internalId: {
          internalId,
          organizationId: org,
        },
      },
      create: {
        type: type as any,
        name,
        providerIdentifier: provider,
        token: encToken,
        profile: username,
        ...(picture ? { picture } : {}),
        inBetweenSteps: isBetweenSteps,
        refreshToken: encRefreshToken,
        tokenEncrypted,
        ...(expiresIn
          ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
          : {}),
        internalId,
        ...postTimes,
        organizationId: org,
        refreshNeeded: false,
        refreshError: null,
        refreshErrorAt: null,
        rootInternalId: internalId,
        ...(customInstanceDetails ? { customInstanceDetails } : {}),
        ...(profileId ? { profileId } : {}),
        additionalSettings: additionalSettings
          ? JSON.stringify(additionalSettings)
          : '[]',
      },
      update: {
        ...(additionalSettings
          ? { additionalSettings: JSON.stringify(additionalSettings) }
          : {}),
        ...(customInstanceDetails ? { customInstanceDetails } : {}),
        type: type as any,
        ...(!refresh
          ? {
              inBetweenSteps: isBetweenSteps,
            }
          : {}),
        ...(picture ? { picture } : {}),
        profile: username,
        providerIdentifier: provider,
        token: encToken,
        // never wipe a stored refresh token with an empty one
        ...(refreshToken ? { refreshToken: encRefreshToken } : {}),
        tokenEncrypted,
        ...(expiresIn
          ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
          : {}),
        internalId,
        organizationId: org,
        deletedAt: null,
        refreshNeeded: false,
        refreshError: null,
        refreshErrorAt: null,
      },
    });

    if (oneTimeToken) {
      const rootId =
        (
          await this._integration.model.integration.findFirst({
            where: {
              organizationId: org,
              internalId: internalId,
            },
          })
        )?.rootInternalId || internalId;

      await this._integration.model.integration.updateMany({
        where: {
          id: {
            not: upsert.id,
          },
          rootInternalId: rootId,
        },
        data: {
          token: encToken,
          refreshToken: encRefreshToken,
          tokenEncrypted,
          refreshNeeded: false,
          refreshError: null,
          refreshErrorAt: null,
          ...(expiresIn
            ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
            : {}),
        },
      });
    }

    return upsert;
  }

  needsToBeRefreshed() {
    return this._integration.model.integration.findMany({
      where: {
        tokenExpiration: {
          lte: dayjs().add(1, 'day').toDate(),
        },
        inBetweenSteps: false,
        deletedAt: null,
        refreshNeeded: false,
        OR: [{ profileId: null }, { clientProfile: { deletedAt: null } }],
      },
    });
  }

  async setBetweenRefreshSteps(id: string) {
    return this._integration.model.integration.update({
      where: {
        id,
      },
      data: {
        inBetweenSteps: true,
      },
    });
  }
  refreshNeeded(org: string, id: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        refreshNeeded: true,
      },
    });
  }

  updateNameAndUrl(id: string, name: string, url: string) {
    return this._integration.model.integration.update({
      where: {
        id,
      },
      data: {
        ...(name ? { name } : {}),
        ...(url ? { picture: url } : {}),
      },
    });
  }

  getIntegrationById(org: string, id: string, profileId?: string) {
    return this._integration.model.integration.findFirst({
      where: {
        organizationId: org,
        id,
        deletedAt: null,
        AND: [
          { OR: [{ profileId: null }, { clientProfile: { deletedAt: null } }] },
          ...(profileId ? [{ OR: [{ profileId }, { profileId: null }] }] : []),
        ],
      },
    });
  }

  getIntegrationsByInternalId(internalId: string) {
    return this._integration.model.integration.findMany({
      where: {
        internalId,
        deletedAt: null,
        disabled: false,
        OR: [{ profileId: null }, { clientProfile: { deletedAt: null } }],
      },
    });
  }

  // Usado em saveProviderPage para detectar quando o user esta tentando
  // conectar um canal que ja existe em outro perfil da mesma org.
  // Retorna a integracao ativa (nao soft-deleted) com profile incluido.
  findActiveByOrgAndInternalIdWithProfile(org: string, internalId: string) {
    return this._integration.model.integration.findFirst({
      where: {
        organizationId: org,
        internalId,
        deletedAt: null,
        OR: [{ profileId: null }, { clientProfile: { deletedAt: null } }],
      },
      include: {
        clientProfile: {
          select: { id: true, name: true },
        },
      },
    });
  }

  async getIntegrationForOrder(
    id: string,
    order: string,
    user: string,
    org: string
  ) {
    const integration = await this._posts.model.post.findFirst({
      where: {
        integrationId: id,
        submittedForOrder: {
          id: order,
          messageGroup: {
            OR: [
              { sellerId: user },
              { buyerId: user },
              { buyerOrganizationId: org },
            ],
          },
        },
      },
      select: {
        integration: {
          select: {
            id: true,
            name: true,
            picture: true,
            inBetweenSteps: true,
            providerIdentifier: true,
          },
        },
      },
    });

    return integration?.integration;
  }

  async updateOnCustomerName(org: string, id: string, name: string) {
    const customer = !name
      ? undefined
      : (await this._customers.model.customer.findFirst({
          where: {
            orgId: org,
            name,
          },
        })) ||
        (await this._customers.model.customer.create({
          data: {
            name,
            orgId: org,
          },
        }));

    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        customer: !customer
          ? { disconnect: true }
          : {
              connect: {
                id: customer.id,
              },
            },
      },
    });
  }

  updateIntegrationGroup(org: string, id: string, group: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: !group
        ? {
            customer: {
              disconnect: true,
            },
          }
        : {
            customer: {
              connect: {
                id: group,
              },
            },
          },
    });
  }

  getCustomerByName(orgId: string, name: string) {
    return this._customers.model.customer.findFirst({
      where: {
        orgId,
        name,
        deletedAt: null,
      },
    });
  }

  updateCustomerName(orgId: string, id: string, name: string) {
    return this._customers.model.customer.update({
      where: {
        id,
        orgId,
      },
      data: {
        name,
      },
    });
  }

  customers(orgId: string) {
    return this._customers.model.customer.findMany({
      where: {
        orgId,
        deletedAt: null,
      },
    });
  }

  getIntegrationsList(org: string, profileId?: string) {
    return this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        deletedAt: null,
        AND: [
          { OR: [{ profileId: null }, { clientProfile: { deletedAt: null } }] },
          ...(profileId ? [{ OR: [{ profileId }, { profileId: null }] }] : []),
        ],
      },
      include: {
        customer: true,
      },
    });
  }

  private async latestPostsFor(
    org: string,
    state: 'PUBLISHED' | 'ERROR',
    field: 'publishDate' | 'updatedAt',
    options: { topLevelOnly: boolean; includeDeleted: boolean },
    groups: { integrationId: string; date: Date | null }[]
  ) {
    const matches = groups.filter((group) => group.date);

    if (!matches.length) {
      return [];
    }

    return this._posts.model.post.findMany({
      where: {
        organizationId: org,
        state,
        ...(options.includeDeleted ? {} : { deletedAt: null }),
        ...(options.topLevelOnly ? { parentPostId: null } : {}),
        OR: matches.map(
          (group) =>
            ({
              integrationId: group.integrationId,
              [field]: group.date,
            } as Prisma.PostWhereInput)
        ),
      },
      orderBy: {
        id: 'asc',
      },
      select: {
        id: true,
        integrationId: true,
        publishDate: true,
        updatedAt: true,
        releaseURL: true,
        error: true,
      },
    });
  }

  /**
   * Canais que precisam de atencao para a tela de Status: token morto
   * (refreshNeeded) OU desativado (disabled). Escopado por org; `profileId`
   * opcional para drill-down futuro. `select` EXPLICITO — nunca retorna
   * token/refreshToken. Traz o perfil de origem embutido (sem N+1). Indices em
   * refreshNeeded/disabled ja existem.
   */
  getProblemChannels(org: string, profileId?: string) {
    return this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        deletedAt: null,
        OR: [{ refreshNeeded: true }, { disabled: true }],
        AND: [
          { OR: [{ profileId: null }, { clientProfile: { deletedAt: null } }] },
        ],
        ...(profileId ? { profileId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        providerIdentifier: true,
        internalId: true,
        picture: true,
        refreshNeeded: true,
        disabled: true,
        refreshError: true,
        refreshErrorAt: true,
        clientProfile: { select: { id: true, name: true } },
      },
    });
  }

  private firstPerIntegration<T extends { integrationId: string }>(posts: T[]) {
    const byIntegration = new Map<string, T>();

    for (const post of posts) {
      if (!byIntegration.has(post.integrationId)) {
        byIntegration.set(post.integrationId, post);
      }
    }

    return byIntegration;
  }

  async getChannelHealth(org: string, includeDeleted = false) {
    const [integrations, lastPublished, lastErrored] = await Promise.all([
      this._integration.model.integration.findMany({
        where: {
          organizationId: org,
        },
        orderBy: {
          createdAt: 'asc',
        },
        select: {
          id: true,
          internalId: true,
          name: true,
          providerIdentifier: true,
          type: true,
          disabled: true,
          refreshNeeded: true,
          inBetweenSteps: true,
          tokenExpiration: true,
          deletedAt: true,
          createdAt: true,
          updatedAt: true,
          customer: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      this._posts.model.post.groupBy({
        by: ['integrationId'],
        where: {
          organizationId: org,
          state: 'PUBLISHED',
          ...(includeDeleted ? {} : { deletedAt: null }),
          parentPostId: null,
        },
        _max: { publishDate: true },
      }),
      this._posts.model.post.groupBy({
        by: ['integrationId'],
        where: {
          organizationId: org,
          state: 'ERROR',
          ...(includeDeleted ? {} : { deletedAt: null }),
        },
        _max: { updatedAt: true },
      }),
    ]);

    const [publishedPosts, erroredPosts] = await Promise.all([
      this.latestPostsFor(
        org,
        'PUBLISHED',
        'publishDate',
        { topLevelOnly: true, includeDeleted },
        lastPublished.map((group) => ({
          integrationId: group.integrationId,
          date: group._max.publishDate,
        }))
      ),
      this.latestPostsFor(
        org,
        'ERROR',
        'updatedAt',
        { topLevelOnly: false, includeDeleted },
        lastErrored.map((group) => ({
          integrationId: group.integrationId,
          date: group._max.updatedAt,
        }))
      ),
    ]);

    const publishedByIntegration = this.firstPerIntegration(publishedPosts);
    const erroredByIntegration = this.firstPerIntegration(erroredPosts);

    return integrations.map((integration) => {
      const published = publishedByIntegration.get(integration.id);
      const errored = erroredByIntegration.get(integration.id);

      return {
        ...integration,
        lastPublishedAt: published?.publishDate || null,
        lastPublishedPostId: published?.id || null,
        lastPublishedUrl: published?.releaseURL || null,
        lastErrorAt: errored?.updatedAt || null,
        lastErrorPostId: errored?.id || null,
        lastError: errored?.error || null,
      };
    });
  }

  async disableChannel(org: string, id: string) {
    await this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        disabled: true,
      },
    });
  }

  async enableChannel(org: string, id: string) {
    await this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        disabled: false,
      },
    });
  }

  getPostsForChannel(org: string, id: string) {
    return this._posts.model.post.groupBy({
      by: ['group'],
      where: {
        organizationId: org,
        integrationId: id,
        deletedAt: null,
      },
    });
  }

  deleteChannel(org: string, id: string) {
    return this._integration.model.integration.update({
      select: {
        id: true,
      },
      where: {
        id,
        organizationId: org,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async deleteIntegrationsForAccount(org: string) {
    const hash = (value: string) =>
      createHash('md5').update(value).digest('hex');

    await this._posts.model.post.updateMany({
      where: {
        organizationId: org,
        deletedAt: null,
      },
      data: {
        deletedAt: new Date(),
      },
    });

    const integrations = await this._integration.model.integration.findMany({
      where: {
        organizationId: org,
      },
    });

    // md5 is deterministic, so a hashed rootInternalId can still be matched
    // by checkPreviousConnections when the same channel is connected again
    // from a new account.
    for (const integration of integrations) {
      await this._integration.model.integration.update({
        where: {
          id: integration.id,
        },
        data: {
          name: hash(integration.name),
          internalId: hash(integration.internalId),
          rootInternalId: integration.rootInternalId
            ? hash(integration.rootInternalId)
            : null,
          token: hash(integration.token),
          refreshToken: integration.refreshToken
            ? hash(integration.refreshToken)
            : null,
          profile: integration.profile ? hash(integration.profile) : null,
          customInstanceDetails: integration.customInstanceDetails
            ? hash(integration.customInstanceDetails)
            : null,
          picture: null,
          deletedAt: integration.deletedAt || new Date(),
        },
      });
    }
  }

  async checkForDeletedOnceAndUpdate(org: string, page: string) {
    return this._integration.model.integration.updateMany({
      where: {
        organizationId: org,
        internalId: page,
        OR: [
          { deletedAt: { not: null } },
          { clientProfile: { deletedAt: { not: null } } },
        ],
      },
      data: {
        internalId: makeId(10),
      },
    });
  }

  async disableIntegrations(org: string, totalChannels: number) {
    const getChannels = await this._integration.model.integration.findMany({
      where: {
        organizationId: org,
        disabled: false,
        deletedAt: null,
        OR: [{ profileId: null }, { clientProfile: { deletedAt: null } }],
      },
      take: totalChannels,
      select: {
        id: true,
      },
    });

    for (const channel of getChannels) {
      await this._integration.model.integration.update({
        where: {
          id: channel.id,
        },
        data: {
          disabled: true,
        },
      });
    }
  }

  enableAllIntegrations(org: string) {
    return this._integration.model.integration.updateMany({
      where: {
        organizationId: org,
        disabled: true,
        deletedAt: null,
      },
      data: {
        disabled: false,
      },
    });
  }

  getPlugsByIntegrationId(org: string, id: string) {
    return this._plugs.model.plugs.findMany({
      where: {
        organizationId: org,
        integrationId: id,
      },
    });
  }

  createOrUpdatePlug(org: string, integrationId: string, body: PlugDto) {
    return this._plugs.model.plugs.upsert({
      where: {
        organizationId: org,
        plugFunction_integrationId: {
          integrationId,
          plugFunction: body.func,
        },
      },
      create: {
        integrationId,
        organizationId: org,
        plugFunction: body.func,
        data: JSON.stringify(body.fields),
        activated: true,
      },
      update: {
        data: JSON.stringify(body.fields),
      },
      select: {
        activated: true,
      },
    });
  }

  changePlugActivation(orgId: string, plugId: string, status: boolean) {
    return this._plugs.model.plugs.update({
      where: {
        organizationId: orgId,
        id: plugId,
      },
      data: {
        activated: !!status,
      },
    });
  }

  async loadExisingData(
    methodName: string,
    integrationId: string,
    id: string[]
  ) {
    return this._exisingPlugData.model.exisingPlugData.findMany({
      where: {
        integrationId,
        methodName,
        value: {
          in: id,
        },
      },
    });
  }

  async saveExisingData(
    methodName: string,
    integrationId: string,
    value: string[]
  ) {
    return this._exisingPlugData.model.exisingPlugData.createMany({
      data: value.map((p) => ({
        integrationId,
        methodName,
        value: p,
      })),
    });
  }

  async getPostingTimes(orgId: string, integrationsId?: string) {
    return this._integration.model.integration.findMany({
      where: {
        ...(integrationsId ? { id: integrationsId } : {}),
        organizationId: orgId,
        disabled: false,
        deletedAt: null,
        OR: [{ profileId: null }, { clientProfile: { deletedAt: null } }],
      },
      select: {
        postingTimes: true,
      },
    });
  }
}
