import { IntegrationValidationTool } from '@gitroom/nestjs-libraries/chat/tools/integration.validation.tool';
import { IntegrationTriggerTool } from '@gitroom/nestjs-libraries/chat/tools/integration.trigger.tool';
import { IntegrationSchedulePostTool } from './integration.schedule.post';
import { GenerateVideoOptionsTool } from '@gitroom/nestjs-libraries/chat/tools/generate.video.options.tool';
import { VideoFunctionTool } from '@gitroom/nestjs-libraries/chat/tools/video.function.tool';
import { GenerateVideoTool } from '@gitroom/nestjs-libraries/chat/tools/generate.video.tool';
import { VideoStatusTool } from '@gitroom/nestjs-libraries/chat/tools/video.status.tool';
import { ClippingTool } from '@gitroom/nestjs-libraries/chat/tools/clipping.tool';
import { ClippingStatusTool } from '@gitroom/nestjs-libraries/chat/tools/clipping.status.tool';
import { ClippingWidgetTicketTool } from '@gitroom/nestjs-libraries/chat/tools/clipping.widget.ticket.tool';
import { GenerateImageTool } from '@gitroom/nestjs-libraries/chat/tools/generate.image.tool';
import { IntegrationListTool } from '@gitroom/nestjs-libraries/chat/tools/integration.list.tool';
import { GroupListTool } from '@gitroom/nestjs-libraries/chat/tools/group.list.tool';
import { UploadFromUrlTool } from '@gitroom/nestjs-libraries/chat/tools/upload.from.url.tool';
import { MediaListTool } from '@gitroom/nestjs-libraries/chat/tools/media.list.tool';
import { PostsListTool } from '@gitroom/nestjs-libraries/chat/tools/posts.list.tool';
import { PostSettingsTool } from '@gitroom/nestjs-libraries/chat/tools/post.settings.tool';
import { DeletePostTool } from '@gitroom/nestjs-libraries/chat/tools/delete.post.tool';
import { UploadWidgetTool } from '@gitroom/nestjs-libraries/chat/tools/upload.widget.tool';
import { UploadWidgetTicketTool } from '@gitroom/nestjs-libraries/chat/tools/upload.widget.ticket.tool';
import { UploadWidgetStatusTool } from '@gitroom/nestjs-libraries/chat/tools/upload.widget.status.tool';
import { KnowledgeQueryTool } from '@gitroom/nestjs-libraries/chat/tools/knowledge.query.tool';
import { WebSearchTool } from '@gitroom/nestjs-libraries/chat/tools/web-search.tool';
import { ExtractUrlsTool } from '@gitroom/nestjs-libraries/chat/tools/extract-urls.tool';
import { CreateCommentAutomationTool } from '@gitroom/nestjs-libraries/chat/tools/create.comment.automation.tool';
import { ListCommentAutomationsTool } from '@gitroom/nestjs-libraries/chat/tools/list.comment.automations.tool';
import { SetCommentAutomationStatusTool } from '@gitroom/nestjs-libraries/chat/tools/set.comment.automation.status.tool';

export const toolList = [
  IntegrationListTool,
  GroupListTool,
  IntegrationValidationTool,
  IntegrationTriggerTool,
  IntegrationSchedulePostTool,
  PostsListTool,
  PostSettingsTool,
  DeletePostTool,
  GenerateVideoOptionsTool,
  VideoFunctionTool,
  GenerateVideoTool,
  VideoStatusTool,
  ClippingTool,
  ClippingStatusTool,
  ClippingWidgetTicketTool,
  GenerateImageTool,
  UploadFromUrlTool,
  MediaListTool,
  UploadWidgetTool,
  UploadWidgetTicketTool,
  UploadWidgetStatusTool,
  KnowledgeQueryTool,
  WebSearchTool,
  ExtractUrlsTool,
  CreateCommentAutomationTool,
  ListCommentAutomationsTool,
  SetCommentAutomationStatusTool,
];
