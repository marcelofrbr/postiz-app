import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetProfileFromRequest } from '@gitroom/nestjs-libraries/user/profile.from.request';
import { Organization, Profile, User } from '@prisma/client';
import { GetPostsDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.dto';
import { GetPostsListDto } from '@gitroom/nestjs-libraries/dtos/posts/get.posts.list.dto';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { ApiTags } from '@nestjs/swagger';
import { GeneratorDto } from '@gitroom/nestjs-libraries/dtos/generator/generator.dto';
import { CreateGeneratedPostsDto } from '@gitroom/nestjs-libraries/dtos/generator/create.generated.posts.dto';
import { AgentGraphService } from '@gitroom/nestjs-libraries/agent/agent.graph.service';
import { Response } from 'express';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ShortLinkService } from '@gitroom/nestjs-libraries/short-linking/short.link.service';
import { CreateTagDto } from '@gitroom/nestjs-libraries/dtos/posts/create.tag.dto';
import { ReviewLinksService } from '@gitroom/nestjs-libraries/database/prisma/review-links/review-links.service';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { PostValidationException } from '@gitroom/backend/api/routes/posts.validation.exception';
import {
  CreatePublicCommentDto,
  ResolveCommentDto,
} from '@gitroom/nestjs-libraries/dtos/comments/add.comment.dto';
import { RealIP } from 'nestjs-real-ip';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AllowViewer } from '@gitroom/nestjs-libraries/services/auth/profile-access/profile-access.decorators';
import { getOrgRole } from '@gitroom/nestjs-libraries/user/org.role';

@ApiTags('Posts')
@Controller('/posts')
export class PostsController {
  constructor(
    private _postsService: PostsService,
    private _agentGraphService: AgentGraphService,
    private _shortLinkService: ShortLinkService,
    private _reviewLinksService: ReviewLinksService
  ) {}

  @Get('/:id/statistics')
  async getStatistics(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._postsService.getStatistics(org.id, id);
  }

  @Get('/:id/missing')
  async getMissingContent(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._postsService.getMissingContent(org.id, id);
  }

  @Get('/:id/release-url')
  async getReleaseURL(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this._postsService.getReleaseURL(org.id, id);
  }

  @Put('/:id/release-id')
  async updateReleaseId(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('releaseId') releaseId: string
  ) {
    return this._postsService.updateReleaseId(org.id, id, releaseId);
  }

  @Post('/should-shortlink')
  async shouldShortlink(@Body() body: { messages: string[] }) {
    return { ask: this._shortLinkService.askShortLinkedin(body.messages) };
  }

  // Revisao do cliente in-app: aprovar / pedir alteracao / comentar. Liberado
  // ao Visualizador (@AllowViewer) e escopado ao perfil dele (org-USER).
  @Post('/:id/comments')
  @AllowViewer()
  async createComment(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @GetProfileFromRequest() profile: Profile | null,
    @Param('id') id: string,
    @Body() body: any,
    @RealIP() ip: string
  ) {
    // Uma rota, dois contratos: comentario ancorado/encadeado do preview
    // (CreatePublicCommentDto, com `content`) e revisao in-app do cliente
    // (`kind` + `comment`).
    if (typeof body?.content === 'string') {
      const dto = plainToInstance(CreatePublicCommentDto, body);
      const errors = await validate(dto);
      if (errors.length) {
        throw new HttpException(
          errors.flatMap((error) => Object.values(error.constraints || {})),
          400
        );
      }
      return this._postsService.createPublicComment(id, dto, user.id, ip);
    }

    return this._postsService.createReview(org.id, user.id, id, {
      kind: body?.kind ?? 'COMMENT',
      content: body?.comment ?? '',
      requireProfileId:
        getOrgRole(org) === 'USER' ? profile?.id ?? null : undefined,
    });
  }

  @Put('/comments/:commentId/resolve')
  async resolveComment(
    @GetOrgFromRequest() org: Organization,
    @Param('commentId') commentId: string,
    @Body() body: ResolveCommentDto
  ) {
    return this._postsService.resolveComment(org.id, commentId, body.resolved);
  }

  @Get('/:id/comments')
  async getComments(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Param('id') id: string
  ) {
    return this._postsService.getReviewComments(
      org.id,
      id,
      getOrgRole(org) === 'USER' ? profile?.id ?? null : undefined
    );
  }

  @Post('/:id/review-links')
  async createReviewLink(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body()
    body: {
      expiresInDays?: number;
      allowComment?: boolean;
      allowApprove?: boolean;
    }
  ) {
    return this._reviewLinksService.createForPost({
      postId: id,
      orgId: org.id,
      userId: user.id,
      expiresInDays: body?.expiresInDays,
      allowComment: body?.allowComment,
      allowApprove: body?.allowApprove,
    });
  }

  @Get('/:id/review-links')
  async listReviewLinks(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return {
      reviewLinks: await this._reviewLinksService.listForPost(id, org.id),
    };
  }

  @Delete('/:id/review-links/:linkId')
  async revokeReviewLink(
    @GetOrgFromRequest() org: Organization,
    @Param('linkId') linkId: string
  ) {
    return this._reviewLinksService.revoke(linkId, org.id);
  }

  @Get('/tags')
  async getTags(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null
  ) {
    return { tags: await this._postsService.getTags(org.id, profile?.id) };
  }

  @Post('/tags')
  async createTag(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Body() body: CreateTagDto
  ) {
    return this._postsService.createTag(org.id, body, profile?.id);
  }

  @Put('/tags/:id')
  async editTag(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Body() body: CreateTagDto,
    @Param('id') id: string
  ) {
    return this._postsService.editTag(id, org.id, body, profile?.id);
  }

  @Delete('/tags/:id')
  async deleteTag(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Param('id') id: string
  ) {
    return this._postsService.deleteTag(id, org.id, profile?.id);
  }

  @Get('/')
  async getPosts(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Query() query: GetPostsDto
  ) {
    return this._postsService.getPostsMinified(org.id, query, profile?.id);
  }

  @Get('/find-slot')
  async findSlot(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null
  ) {
    return { date: await this._postsService.findFreeDateTime(org.id, undefined, profile?.id) };
  }

  @Get('/find-slot/:id')
  async findSlotIntegration(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Param('id') id?: string
  ) {
    return { date: await this._postsService.findFreeDateTime(org.id, id, profile?.id) };
  }

  @Get('/list')
  async getPostsList(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Query() query: GetPostsListDto
  ) {
    return this._postsService.getPostsList(org.id, query, profile?.id);
  }

  @Get('/old')
  oldPosts(
    @GetOrgFromRequest() org: Organization,
    @Query('date') date: string
  ) {
    return this._postsService.getOldPosts(org.id, date);
  }

  @Get('/group/:group/debug-export')
  async getPostGroupDebugExport(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('group') group: string
  ) {
    if (!user.isSuperAdmin) {
      throw new HttpException('Forbidden', 403);
    }
    return this._postsService.getPostGroupDebugExport(org.id, group);
  }

  @Get('/group/:group')
  getPostsByGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('group') group: string
  ) {
    return this._postsService.getPostsByGroup(org.id, group);
  }

  @Get('/:id')
  getPost(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._postsService.getPost(org.id, id);
  }

  @Post('/valid')
  async validatePosts(
    @GetOrgFromRequest() org: Organization,
    @Body() rawBody: any
  ) {
    return this._postsService.validatePosts(org.id, rawBody?.posts || []);
  }

  @Post('/')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async createPost(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Body() rawBody: any
  ) {
    // Server-side validation — never trust the client to have validated.
    const validation = await this._postsService.validatePosts(
      org.id,
      rawBody?.posts || []
    );

    const fail = (item: (typeof validation)[number], error: string) => {
      throw new PostValidationException({
        provider: item.identifier,
        name: item.name,
        error,
      });
    };

    for (const item of validation) {
      if (item.emptyContent) {
        fail(
          item,
          'Your post should have at least one character or one image.'
        );
      }
    }

    if (rawBody?.type !== 'draft') {
      for (const item of validation) {
        if (!item.valid) {
          fail(item, item.settingsError || 'Please fix your settings');
        }
        if (item.errors !== true) {
          fail(item, item.errors as string);
        }
        if (item.tooLong) {
          fail(item, 'post is too long, please fix it');
        }
      }
    }

    const body = await this._postsService.mapTypeToPost(rawBody, org.id);
    return this._postsService.createPost(
      org.id,
      body,
      'WEB',
      false,
      profile?.id
    );
  }

  @Post('/generator/draft')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  generatePostsDraft(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Body() body: CreateGeneratedPostsDto
  ) {
    return this._postsService.generatePostsDraft(org.id, body, profile?.id);
  }

  @Post('/generator')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async generatePosts(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Body() body: GeneratorDto,
    @Res({ passthrough: false }) res: Response
  ) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const stream = await this._agentGraphService.start(
        org.id,
        body,
        profile?.id
      );
      for await (const event of stream) {
        res.write(JSON.stringify(event) + '\n');
      }
    } catch (err) {
      // The stream has already started, so we cannot surface a normal HTTP
      // error here. Emit a final error event on the open stream instead, so the
      // client can stop and show the message rather than hang on a truncated
      // stream. HttpExceptions carry a curated, user-facing message (e.g. the
      // AI safety rejection); anything else gets a generic message.
      const message =
        err instanceof HttpException
          ? err.message
          : 'Nao foi possivel gerar as publicacoes. Tente novamente.';
      res.write(JSON.stringify({ name: 'error', error: true, message }) + '\n');
    }

    res.end();
  }

  @Delete('/:group')
  deletePost(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Param('group') group: string
  ) {
    return this._postsService.deletePost(org.id, group, profile?.id);
  }

  @Put('/:id/date')
  changeDate(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Param('id') id: string,
    @Body('date') date: string,
    // 'update' is the safe default: clients that don't send an action must
    // never requeue (and thereby republish) a post by accident
    @Body('action') action: 'schedule' | 'update' = 'update',
    @Body('republish') republish = false
  ) {
    return this._postsService.changeDate(
      org.id,
      id,
      date,
      action,
      republish,
      profile?.id
    );
  }

  @Post('/separate-posts')
  async separatePosts(
    @GetOrgFromRequest() org: Organization,
    @GetProfileFromRequest() profile: Profile | null,
    @Body() body: { content: string; len: number }
  ) {
    return this._postsService.separatePosts(
      org.id,
      body.content,
      body.len,
      profile?.id
    );
  }
}
