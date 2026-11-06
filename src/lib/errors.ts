export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string>;

  constructor(status: number, body: Record<string, unknown>, headers?: Record<string, string>) {
    super(typeof body.error === 'string' ? body.error : `HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export class BadRequestError extends HttpError {
  constructor(message = 'Bad Request') {
    super(400, { error: message });
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, { error: message });
    this.name = 'UnauthorizedError';
  }
}

export class NotFoundError extends HttpError {
  constructor(body: string | Record<string, unknown> = 'Not Found') {
    super(404, typeof body === 'string' ? { error: body } : body);
    this.name = 'NotFoundError';
  }
}

export class RateLimitedError extends HttpError {
  constructor(retryAfterSeconds: number) {
    super(429, { code: 'rate_limited', retryAfterSeconds }, { 'Retry-After': String(retryAfterSeconds) });
    this.name = 'RateLimitedError';
  }
}
