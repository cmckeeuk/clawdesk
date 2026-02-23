export type ApiErrorCode = 'http_error' | 'network_error' | 'parse_error' | 'unknown_error'

export type UiError = {
  title: string
  message: string
  tone: 'error' | 'warning' | 'info'
  sticky: boolean
}

export class ApiError extends Error {
  code: ApiErrorCode
  status?: number
  detail?: string

  constructor(message: string, options: { code: ApiErrorCode; status?: number; detail?: string }) {
    super(message)
    this.name = 'ApiError'
    this.code = options.code
    this.status = options.status
    this.detail = options.detail
  }
}

function extractMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined
  }

  const candidate = payload as { detail?: unknown; message?: unknown; error?: unknown }

  if (typeof candidate.detail === 'string' && candidate.detail.trim()) {
    return candidate.detail.trim()
  }
  if (typeof candidate.message === 'string' && candidate.message.trim()) {
    return candidate.message.trim()
  }
  if (typeof candidate.error === 'string' && candidate.error.trim()) {
    return candidate.error.trim()
  }

  return undefined
}

export function createHttpError(status: number, payload: unknown): ApiError {
  const message = extractMessage(payload) ?? `Request failed with status ${status}`
  return new ApiError(message, {
    code: 'http_error',
    status,
    detail: message,
  })
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new ApiError('Request was aborted.', {
      code: 'network_error',
      detail: error.message,
    })
  }

  if (error instanceof SyntaxError) {
    return new ApiError('Invalid JSON response from server.', {
      code: 'parse_error',
      detail: error.message,
    })
  }

  if (error instanceof TypeError) {
    return new ApiError('Could not reach backend API.', {
      code: 'network_error',
      detail: error.message,
    })
  }

  if (error instanceof Error) {
    return new ApiError(error.message, {
      code: 'unknown_error',
      detail: error.message,
    })
  }

  return new ApiError('Unexpected API error.', {
    code: 'unknown_error',
  })
}

export function mapApiErrorToUi(error: ApiError): UiError {
  if (error.code === 'network_error') {
    return {
      title: 'Connection issue',
      message: 'Backend is not reachable. Check API URL, backend process, and network.',
      tone: 'warning',
      sticky: true,
    }
  }

  if (error.status === 400) {
    return {
      title: 'Validation error',
      message: error.detail ?? 'The request payload is invalid.',
      tone: 'warning',
      sticky: false,
    }
  }

  if (error.status === 401 || error.status === 403) {
    return {
      title: 'Authorization failed',
      message: 'API rejected this request. Verify gateway token and backend auth settings.',
      tone: 'error',
      sticky: true,
    }
  }

  if (error.status === 404) {
    return {
      title: 'Not found',
      message: error.detail ?? 'Requested resource could not be found.',
      tone: 'info',
      sticky: false,
    }
  }

  if ((error.status ?? 0) >= 500) {
    return {
      title: 'Backend failure',
      message: error.detail ?? 'Server returned an unexpected failure.',
      tone: 'error',
      sticky: true,
    }
  }

  return {
    title: 'Request failed',
    message: error.detail ?? error.message,
    tone: 'error',
    sticky: true,
  }
}
