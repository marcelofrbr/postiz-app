'use client';

import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { Button } from '@gitroom/react/form/button';
import { Input } from '@gitroom/react/form/input';
import { Textarea } from '@gitroom/react/form/textarea';
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { FormProvider, useForm } from 'react-hook-form';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useProfilePermissions } from '@gitroom/frontend/hooks/use-profile-permissions';
import { useToaster } from '@gitroom/react/toaster/toaster';
import clsx from 'clsx';
import dayjs from 'dayjs';
import {
  PreviewComment,
  usePreviewComments,
} from '@gitroom/frontend/components/preview/preview.comments.context';

const REVIEWER_NAME_KEY = 'preview-reviewer-name';

type ReviewInfo =
  | { valid: false }
  | {
      valid: true;
      allowComment: boolean;
      allowApprove: boolean;
      expiresAt: string | null;
    };

type ReviewKind = 'COMMENT' | 'APPROVAL' | 'CHANGE_REQUEST';

// O endpoint publico pode devolver tambem o tipo da entrada (comentario,
// aprovacao ou pedido de alteracao) e o nome do convidado (revisao do cliente).
type ReviewComment = PreviewComment & {
  kind?: ReviewKind;
  guestName?: string | null;
};

const GUEST_NAME_KEY = 'robo-multipost:guest-name';
const GUEST_EMAIL_KEY = 'robo-multipost:guest-email';

function readGuestDefaults() {
  if (typeof window === 'undefined') return { name: '', email: '' };
  try {
    return {
      name: window.localStorage.getItem(GUEST_NAME_KEY) || '',
      email: window.localStorage.getItem(GUEST_EMAIL_KEY) || '',
    };
  } catch {
    return { name: '', email: '' };
  }
}

function persistGuestDefaults(name: string, email: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(GUEST_NAME_KEY, name);
    window.localStorage.setItem(GUEST_EMAIL_KEY, email);
  } catch {
    // ignore
  }
}

// Visualizador (cliente convidado por agencia) aprova ou pede alteracao na
// mesma tela onde ve o post na integra (caminho autenticado).
const LoggedReviewPanel: FC<{ previewId: string }> = ({ previewId }) => {
  const t = useT();
  const fetch = useFetch();
  const toast = useToaster();
  const { mutate } = usePreviewComments();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<ReviewKind | null>(null);

  const submitKind = useCallback(
    (kind: ReviewKind) => async () => {
      const comment = note.trim();
      if (kind === 'COMMENT' && !comment) {
        return;
      }
      setSubmitting(kind);
      try {
        const response = await fetch(`/posts/${previewId}/comments`, {
          method: 'POST',
          body: JSON.stringify({ kind, comment }),
        });
        if (!response.ok) {
          toast.show(
            t('request_failed', 'Falha na requisição. Tente novamente.'),
            'warning'
          );
          return;
        }
        setNote('');
        await mutate();
      } finally {
        setSubmitting(null);
      }
    },
    [previewId, note, mutate]
  );

  return (
    <div className="flex flex-col gap-[8px] rounded-[8px] border border-newTableBorder p-[12px]">
      <div className="text-[14px] font-[600]">
        {t('client_review', 'Client review')}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t(
          'guest_note_placeholder',
          'Comentário ou observação opcional para aprovação/alterações...'
        )}
        className="w-full px-[12px] py-[8px] text-[14px] bg-newBgColorInner border border-newTableBorder rounded-[8px] outline-none min-h-[80px] resize-none"
        maxLength={2000}
      />
      <div className="flex flex-wrap gap-[8px] justify-end">
        <Button
          type="button"
          onClick={submitKind('CHANGE_REQUEST')}
          loading={submitting === 'CHANGE_REQUEST'}
          className="!bg-amber-600 hover:!bg-amber-700 !text-white"
        >
          {t('request_changes', 'Pedir alterações')}
        </Button>
        <Button
          type="button"
          onClick={submitKind('APPROVAL')}
          loading={submitting === 'APPROVAL'}
          className="!bg-green-600 hover:!bg-green-700 !text-white"
        >
          {t('approve', 'Aprovar')}
        </Button>
      </div>
    </div>
  );
};

// Revisao por link com token (cliente sem conta): nome + e-mail, e aprova,
// pede alteracao ou comenta pelos endpoints publicos de revisao.
const GuestReviewPanel: FC<{
  previewId: string;
  token: string;
  allowComment: boolean;
  allowApprove: boolean;
}> = ({ previewId, token, allowComment, allowApprove }) => {
  const fetch = useFetch();
  const t = useT();
  const { mutate } = usePreviewComments();
  const defaults = useMemo(() => readGuestDefaults(), []);
  const [guestName, setGuestName] = useState(defaults.name);
  const [guestEmail, setGuestEmail] = useState(defaults.email);
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<
    null | 'comment' | 'approve' | 'changes'
  >(null);
  const [linkInvalid, setLinkInvalid] = useState(false);

  // Client-side re-validation on mount: server-rendered reviewInfo can be stale
  // if the owner revokes the link after the page was rendered.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/public/posts/${previewId}/review?token=${encodeURIComponent(token)}`
        );
        if (!res.ok) {
          if (!cancelled) setLinkInvalid(true);
          return;
        }
        const body = await res.json();
        if (!cancelled && body?.valid !== true) {
          setLinkInvalid(true);
        }
      } catch {
        // Keep form available; any subsequent POST will also enforce
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewId, token]);

  const validate = useCallback(
    (requireContent: boolean) => {
      if (!guestName.trim() || !guestEmail.trim()) {
        setError(
          t('guest_name_email_required', 'Name and email are required')
        );
        return false;
      }
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail);
      if (!emailOk) {
        setError(t('guest_invalid_email', 'Invalid email address'));
        return false;
      }
      if (requireContent && !content.trim()) {
        setError(t('comment_required', 'Comment is required'));
        return false;
      }
      setError(null);
      return true;
    },
    [guestName, guestEmail, content, t]
  );

  const submitAction = useCallback(
    async (
      kind: 'comment' | 'approve' | 'changes',
      endpoint: string,
      extra: Record<string, unknown> = {}
    ) => {
      if (!validate(kind === 'comment')) return;
      setSubmitting(kind);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body: JSON.stringify({
            token,
            guestName: guestName.trim(),
            guestEmail: guestEmail.trim(),
            ...extra,
          }),
        });
        if (!res.ok) {
          if (res.status === 429) {
            setError(
              t(
                'too_many_requests',
                'Muitas requisições. Tente novamente em instantes.'
              )
            );
          } else if (res.status === 404) {
            setLinkInvalid(true);
          } else {
            setError(
              t('request_failed', 'Falha na requisição. Tente novamente.')
            );
          }
          return;
        }
        persistGuestDefaults(guestName.trim(), guestEmail.trim());
        setContent('');
        await mutate();
      } catch {
        setError(t('request_failed', 'Falha na requisição. Tente novamente.'));
      } finally {
        setSubmitting(null);
      }
    },
    [token, guestName, guestEmail, validate, mutate, t]
  );

  const onComment = useCallback(
    () =>
      submitAction('comment', `/public/posts/${previewId}/review/comment`, {
        content: content.trim(),
      }),
    [submitAction, previewId, content]
  );

  const onApprove = useCallback(
    () =>
      submitAction('approve', `/public/posts/${previewId}/review/approve`, {
        decision: 'APPROVED',
        note: content.trim(),
      }),
    [submitAction, previewId, content]
  );

  const onRequestChanges = useCallback(
    () =>
      submitAction('changes', `/public/posts/${previewId}/review/approve`, {
        decision: 'CHANGE_REQUESTED',
        note: content.trim(),
      }),
    [submitAction, previewId, content]
  );

  if (linkInvalid) {
    return (
      <div className="p-[16px] border border-red-800 bg-red-950/40 rounded-[8px] text-center flex flex-col gap-[8px]">
        <p className="text-[14px] font-[600] text-red-300">
          {t('review_link_invalid_title', 'Link de revisão indisponível')}
        </p>
        <p className="text-[12px] text-red-200">
          {t(
            'review_link_invalid_body',
            'Este link foi revogado ou expirou. Solicite um novo link ao responsável do post.'
          )}
        </p>
      </div>
    );
  }

  if (!allowComment && !allowApprove) {
    return null;
  }

  return (
    <div className="flex flex-col gap-[8px] rounded-[8px] border border-newTableBorder p-[12px]">
      <div className="text-[14px] font-[600]">
        {t('client_review', 'Client review')}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-[8px]">
        <input
          type="text"
          placeholder={t('your_name', 'Your name')}
          className="w-full h-[40px] px-[12px] text-[14px] bg-newBgColorInner border border-newTableBorder rounded-[8px] outline-none"
          value={guestName}
          onChange={(e) => setGuestName(e.target.value)}
          maxLength={80}
        />
        <input
          type="email"
          placeholder={t('your_email', 'Your email')}
          className="w-full h-[40px] px-[12px] text-[14px] bg-newBgColorInner border border-newTableBorder rounded-[8px] outline-none"
          value={guestEmail}
          onChange={(e) => setGuestEmail(e.target.value)}
          maxLength={254}
        />
      </div>
      <textarea
        placeholder={t(
          'guest_note_placeholder',
          'Comentário ou observação opcional para aprovação/alterações...'
        )}
        className="w-full px-[12px] py-[8px] text-[14px] bg-newBgColorInner border border-newTableBorder rounded-[8px] outline-none min-h-[80px] resize-none"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        maxLength={2000}
      />
      {error && <p className="text-[12px] text-red-400">{error}</p>}
      <div className="flex flex-wrap gap-[8px] justify-end">
        {allowComment && (
          <Button
            type="button"
            onClick={onComment}
            loading={submitting === 'comment'}
            secondary={true}
          >
            {t('send_comment', 'Enviar comentário')}
          </Button>
        )}
        {allowApprove && (
          <>
            <Button
              type="button"
              onClick={onRequestChanges}
              loading={submitting === 'changes'}
              className="!bg-amber-600 hover:!bg-amber-700 !text-white"
            >
              {t('request_changes', 'Pedir alterações')}
            </Button>
            <Button
              type="button"
              onClick={onApprove}
              loading={submitting === 'approve'}
              className="!bg-green-600 hover:!bg-green-700 !text-white"
            >
              {t('approve', 'Aprovar')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
};

// Invisible reCAPTCHA v2: one widget for the page. Google only shows a puzzle
// when it considers the visitor risky; otherwise the token comes back at once.
// Google does not report a dismissed puzzle, so an attempt stays pending until
// it gets a token, expires, errors, or the reviewer clicks Post again (which
// abandons the previous attempt with null).
let recaptchaWidget: {
  id: number;
  resolve?: (token: string | null) => void;
} | null = null;

const loadRecaptchaToken = async (siteKey: string) => {
  if (!(window as any).grecaptcha?.render) {
    await new Promise<void>((resolve, reject) => {
      (window as any).onPreviewRecaptchaLoad = () => resolve();
      const script = document.createElement('script');
      script.src =
        'https://www.google.com/recaptcha/api.js?onload=onPreviewRecaptchaLoad&render=explicit';
      script.async = true;
      script.onerror = () => reject(new Error('recaptcha failed to load'));
      document.head.appendChild(script);
    });
  }
  const grecaptcha = (window as any).grecaptcha;
  if (!recaptchaWidget) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const widget: NonNullable<typeof recaptchaWidget> = { id: 0 };
    const settle = (token: string | null) => {
      const resolve = widget.resolve;
      widget.resolve = undefined;
      resolve?.(token);
    };
    widget.id = grecaptcha.render(container, {
      sitekey: siteKey,
      size: 'invisible',
      callback: (token: string) => settle(token),
      'expired-callback': () => settle(null),
      'error-callback': () => settle(null),
    });
    recaptchaWidget = widget;
  }
  const widget = recaptchaWidget;
  widget.resolve?.(null);
  grecaptcha.reset(widget.id);
  return new Promise<string | null>((resolve) => {
    widget.resolve = resolve;
    grecaptcha.execute(widget.id);
  });
};

const ReviewerNameForm: FC<{ onConfirm: (name: string) => void }> = ({
  onConfirm,
}) => {
  const t = useT();
  const form = useForm({
    values: {
      name:
        (typeof window !== 'undefined' &&
          localStorage.getItem(REVIEWER_NAME_KEY)) ||
        '',
    },
    mode: 'onChange',
  });
  const submit = useCallback(
    (values: { name: string }) => {
      const name = values.name.trim();
      if (!name) {
        return;
      }
      localStorage.setItem(REVIEWER_NAME_KEY, name);
      onConfirm(name);
    },
    [onConfirm]
  );

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(submit)}>
        <div className="relative flex gap-[10px] flex-col flex-1">
          <div className="text-[14px] text-textItemBlur">
            {t(
              'preview_comment_name_required',
              'We can only post your comment if you provide your name.'
            )}
          </div>
          <Input
            label={t('preview_comment_your_name', 'Your name')}
            placeholder={t('preview_comment_your_name', 'Your name')}
            name="name"
            maxLength={80}
            autoFocus={true}
          />
          <Button type="submit">{t('continue', 'Continue')}</Button>
        </div>
      </form>
    </FormProvider>
  );
};

const CommentComposer: FC<{
  parentId?: string;
  onDone?: () => void;
}> = ({ parentId, onDone }) => {
  const t = useT();
  const user = useUser();
  const fetch = useFetch();
  const toast = useToaster();
  const modals = useModals();
  const { recaptchaSiteKey } = useVariables();
  const { previewId, pending, setPending, mutate } = usePreviewComments();
  const [loading, setLoading] = useState(false);
  const form = useForm({ values: { content: '' } });
  const anchor = parentId ? null : pending;

  const askForName = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        modals.openModal({
          classNames: {
            modal: 'bg-transparent text-textColor',
          },
          title: t('preview_comment_your_name', 'Your name'),
          withCloseButton: true,
          onClose: () => resolve(null),
          children: (close) => (
            <ReviewerNameForm
              onConfirm={(name) => {
                resolve(name);
                close();
              }}
            />
          ),
        });
      }),
    [t]
  );

  const submit = useCallback(
    async (values: { content: string }) => {
      const content = values.content.trim();
      if (!content) {
        return;
      }

      let displayName: string | undefined;
      let recaptchaToken: string | undefined;
      if (!user?.id) {
        const name = await askForName();
        if (!name) {
          return;
        }
        displayName = name;

        if (recaptchaSiteKey) {
          const token = await loadRecaptchaToken(recaptchaSiteKey).catch(() => {
            toast.show(
              t('preview_comment_failed', 'Could not post the comment'),
              'warning'
            );
            return null;
          });
          if (!token) {
            return;
          }
          recaptchaToken = token;
        }
      }

      setLoading(true);
      try {
        const response = await fetch(
          user?.id
            ? `/posts/${previewId}/comments`
            : `/public/posts/${previewId}/comments`,
          {
            method: 'POST',
            body: JSON.stringify({
              content,
              ...(parentId ? { parentId } : {}),
              ...(anchor
                ? {
                    postId: anchor.postId,
                    anchorStart: anchor.start,
                    anchorEnd: anchor.end,
                    anchorQuote: anchor.quote,
                  }
                : {}),
              ...(displayName ? { displayName } : {}),
              ...(recaptchaToken ? { recaptchaToken } : {}),
            }),
          }
        );

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          toast.show(
            body?.message ||
              t('preview_comment_failed', 'Could not post the comment'),
            'warning'
          );
          return;
        }

        form.reset({ content: '' });
        if (anchor) {
          setPending(null);
        }
        await mutate();
        onDone?.();
      } finally {
        setLoading(false);
      }
    },
    [user?.id, recaptchaSiteKey, previewId, parentId, anchor, askForName]
  );

  return (
    <FormProvider {...form}>
      <form
        className="flex flex-col gap-[8px]"
        onSubmit={form.handleSubmit(submit)}
      >
        {!!anchor && (
          <div className="flex items-start gap-[8px] border-s-[3px] border-btnPrimary ps-[8px] text-[12px] text-textItemBlur">
            <div className="flex-1 italic truncate">{anchor.quote}</div>
            <button
              type="button"
              className="hover:text-newTextColor"
              onClick={() => setPending(null)}
              aria-label={t('cancel', 'Cancel')}
            >
              ✕
            </button>
          </div>
        )}
        <Textarea
          label={
            parentId ? t('reply', 'Reply') : t('add_a_comment', 'Add a comment')
          }
          name="content"
          className="!min-h-[90px] resize-none"
          placeholder={
            parentId
              ? t('write_a_reply', 'Write a reply...')
              : t('add_a_comment_placeholder', 'Add a comment...')
          }
          maxLength={2000}
        />
        <div className="flex items-center justify-end gap-[10px] -mt-[14px]">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-textItemBlur cursor-help"
            data-tooltip-id="tooltip"
            data-tooltip-content={t(
              'preview_comment_detach_hint',
              'Comments on selected text lose their highlight if the text is edited later.'
            )}
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
          {!!onDone && (
            <Button type="button" secondary={true} onClick={onDone}>
              {t('cancel', 'Cancel')}
            </Button>
          )}
          <Button type="submit" loading={loading}>
            {parentId ? t('reply', 'Reply') : t('post', 'Post')}
          </Button>
        </div>
      </form>
    </FormProvider>
  );
};

const CommentBody: FC<{ comment: PreviewComment }> = ({ comment }) => {
  const t = useT();
  const { kind, guestName } = comment as ReviewComment;
  const badge =
    kind === 'APPROVAL'
      ? t('approved', 'Approved')
      : kind === 'CHANGE_REQUEST'
      ? t('changes_requested', 'Changes requested')
      : null;
  // Aprovacao/pedido de alteracao sem texto gravam um conteudo padrao legado.
  const isLegacyDefault =
    !!kind &&
    kind !== 'COMMENT' &&
    (comment.content === 'Approved' || comment.content === 'Changes requested');
  const body = !comment.content || isLegacyDefault ? '' : comment.content;
  return (
    <div className="flex flex-col gap-[4px]">
      {!!badge && (
        <div>
          <span
            className={clsx(
              'text-[10px] uppercase px-[4px] rounded-[4px]',
              kind === 'APPROVAL'
                ? 'bg-green-900 text-green-200'
                : 'bg-yellow-900 text-yellow-200'
            )}
          >
            {badge}
          </span>
        </div>
      )}
      {!!body && (
        <div className="text-[14px] whitespace-pre-wrap break-words">
          {body}
        </div>
      )}
      <div className="text-[12px] text-textItemBlur">
        {comment.name || guestName || t('reviewer', 'Reviewer')} ·{' '}
        {dayjs(comment.createdAt).format('MMM D, YYYY HH:mm')}
      </div>
    </div>
  );
};

const ThreadCard: FC<{
  comment: PreviewComment;
  replies: PreviewComment[];
  canResolve: boolean;
}> = ({ comment, replies, canResolve }) => {
  const t = useT();
  const fetch = useFetch();
  const toast = useToaster();
  const ref = useRef<HTMLDivElement>(null);
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [flash, setFlash] = useState(false);
  const {
    mutate,
    activeThread,
    setActiveThread,
    hoveredThread,
    setHoveredThread,
  } = usePreviewComments();
  const resolved = !!comment.resolvedAt;
  const anchored = comment.anchorStart !== null && comment.anchorEnd !== null;

  useEffect(() => {
    if (activeThread?.id !== comment.id || activeThread.source !== 'mark') {
      return;
    }
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(timer);
  }, [activeThread, comment.id]);

  const toggleResolved = useCallback(async () => {
    const response = await fetch(`/posts/comments/${comment.id}/resolve`, {
      method: 'PUT',
      body: JSON.stringify({ resolved: !resolved }),
    });
    if (!response.ok) {
      toast.show(
        t('preview_comment_failed', 'Could not post the comment'),
        'warning'
      );
      return;
    }
    mutate();
  }, [comment.id, resolved]);

  return (
    <div
      ref={ref}
      onMouseEnter={() => !resolved && setHoveredThread(comment.id)}
      onMouseLeave={() => setHoveredThread(null)}
      className={clsx(
        'flex flex-col gap-[8px] rounded-[8px] border p-[12px] transition-colors',
        resolved && 'opacity-50',
        flash || hoveredThread === comment.id || activeThread?.id === comment.id
          ? 'border-btnPrimary'
          : 'border-newTableBorder'
      )}
    >
      <div className="flex items-center gap-[6px] flex-wrap">
        {resolved && (
          <div className="text-[11px] rounded-[4px] px-[6px] py-[2px] bg-btnSimple">
            {t('resolved', 'Resolved')}
          </div>
        )}
        {!!comment.anchorQuote && !anchored && !resolved && (
          <div className="text-[11px] rounded-[4px] px-[6px] py-[2px] bg-btnSimple">
            {t('preview_comment_text_changed', 'Text changed')}
          </div>
        )}
      </div>
      {!!comment.anchorQuote && (
        <div
          className={clsx(
            'border-s-[3px] border-btnPrimary ps-[8px] text-[12px] italic text-textItemBlur truncate',
            anchored && !resolved && 'cursor-pointer hover:text-newTextColor'
          )}
          onClick={() =>
            anchored &&
            !resolved &&
            setActiveThread({ id: comment.id, source: 'card' })
          }
        >
          {comment.anchorQuote}
        </div>
      )}
      {resolved && !expanded ? (
        <div
          className="text-[14px] truncate cursor-pointer"
          onClick={() => setExpanded(true)}
        >
          {comment.content}
        </div>
      ) : (
        <CommentBody comment={comment} />
      )}
      {(!resolved || expanded) && !!replies.length && (
        <div className="flex flex-col gap-[8px] ps-[12px] border-s border-newTableBorder">
          {replies.map((reply) => (
            <CommentBody key={reply.id} comment={reply} />
          ))}
        </div>
      )}
      {(!resolved || expanded) && (
        <div className="flex gap-[12px] text-[12px]">
          {!resolved && (
            <button
              type="button"
              className="text-textItemBlur hover:text-newTextColor"
              onClick={() => setReplying(!replying)}
            >
              {t('reply', 'Reply')}
            </button>
          )}
          {canResolve && (
            <button
              type="button"
              className="text-textItemBlur hover:text-newTextColor"
              onClick={toggleResolved}
            >
              {resolved ? t('reopen', 'Reopen') : t('resolve', 'Resolve')}
            </button>
          )}
          {resolved && (
            <button
              type="button"
              className="text-textItemBlur hover:text-newTextColor"
              onClick={() => setExpanded(false)}
            >
              {t('collapse', 'Collapse')}
            </button>
          )}
        </div>
      )}
      {replying && !resolved && (
        <CommentComposer
          parentId={comment.id}
          onDone={() => setReplying(false)}
        />
      )}
    </div>
  );
};

export const CommentsComponents: FC<{
  previewId: string;
  token?: string;
  reviewInfo?: ReviewInfo;
}> = ({ previewId, token, reviewInfo }) => {
  const t = useT();
  const user = useUser();
  const { isViewer } = useProfilePermissions();
  const guestReview =
    !!token && !!reviewInfo && reviewInfo.valid === true ? reviewInfo : null;
  const { comments, isLoading, postIds, organizationId } = usePreviewComments();
  const canResolve = !!user?.id && user?.orgId === organizationId;

  const threads = useMemo(() => {
    const replies = comments.reduce((all, current) => {
      if (current.parentId) {
        all[current.parentId] = [...(all[current.parentId] || []), current];
      }
      return all;
    }, {} as Record<string, PreviewComment[]>);

    const rank = (c: PreviewComment) => {
      if (c.resolvedAt) {
        return [2, 0, dayjs(c.createdAt).valueOf()];
      }
      if (c.anchorStart !== null && c.anchorEnd !== null) {
        return [0, postIds.indexOf(c.postId), c.anchorStart];
      }
      return [1, 0, dayjs(c.createdAt).valueOf()];
    };

    return comments
      .filter((c) => !c.parentId)
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
      })
      .map((comment) => ({ comment, replies: replies[comment.id] || [] }));
  }, [comments, postIds]);

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="text-[18px] font-[600]">{t('comments', 'Comments')}</div>
      {!!guestReview && (
        <GuestReviewPanel
          previewId={previewId}
          token={token!}
          allowComment={guestReview.allowComment}
          allowApprove={guestReview.allowApprove}
        />
      )}
      {!guestReview && !!user?.id && isViewer && (
        <LoggedReviewPanel previewId={previewId} />
      )}
      <CommentComposer />
      {!isLoading && !threads.length && (
        <div className="text-[13px] text-textItemBlur">
          {t(
            'preview_no_comments_yet',
            'No comments yet. Select some text in the post to comment on it, or add a general comment.'
          )}
        </div>
      )}
      <div className="flex flex-col gap-[10px]">
        {threads.map(({ comment, replies }) => (
          <ThreadCard
            key={comment.id}
            comment={comment}
            replies={replies}
            canResolve={canResolve}
          />
        ))}
      </div>
    </div>
  );
};
