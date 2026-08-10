import type { AppError, AppErrorCode } from './contracts';

export class PhotoMapError extends Error {
  public readonly code: AppErrorCode;
  public readonly retryability: AppError['retryability'];
  public readonly scope: AppError['scope'];
  public readonly affectedIds?: string[];

  public constructor(
    code: AppErrorCode,
    userMessage: string,
    options: {
      retryability?: AppError['retryability'];
      scope?: AppError['scope'];
      affectedIds?: string[];
      cause?: unknown;
    } = {}
  ) {
    super(userMessage, { cause: options.cause });
    this.name = 'PhotoMapError';
    this.code = code;
    this.retryability = options.retryability ?? 'non_retryable';
    this.scope = options.scope ?? 'task';
    this.affectedIds = options.affectedIds;
  }

  public toPublicError(): AppError {
    return {
      code: this.code,
      userMessage: this.message,
      retryability: this.retryability,
      scope: this.scope,
      ...(this.affectedIds === undefined ? {} : { affectedIds: this.affectedIds })
    };
  }
}

export function toPublicError(error: unknown): AppError {
  if (error instanceof PhotoMapError) {
    return error.toPublicError();
  }

  return {
    code: 'UNKNOWN_ERROR',
    userMessage: '操作未完成，请重试。',
    retryability: 'retry',
    scope: 'task'
  };
}
