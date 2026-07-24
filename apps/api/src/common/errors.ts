import { HttpException, HttpStatus } from '@nestjs/common';

export function badRequest(message: string): HttpException {
  return new HttpException({ statusCode: 400, message, error: 'Bad Request' }, HttpStatus.BAD_REQUEST);
}

export function unauthorized(message = 'Unauthorized'): HttpException {
  return new HttpException(
    { statusCode: 401, message, error: 'Unauthorized' },
    HttpStatus.UNAUTHORIZED,
  );
}

export function forbidden(message = 'Forbidden'): HttpException {
  return new HttpException(
    { statusCode: 403, message, error: 'Forbidden' },
    HttpStatus.FORBIDDEN,
  );
}

export function notFound(message = 'Not found'): HttpException {
  return new HttpException(
    { statusCode: 404, message, error: 'Not Found' },
    HttpStatus.NOT_FOUND,
  );
}
